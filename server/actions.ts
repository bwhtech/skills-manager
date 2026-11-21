import type { Stats } from "node:fs"
import { lstat, mkdir, rename, rm, rmdir, unlink } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import {
  updateTargetsOverlap,
  type InstallRequest,
  type Job,
  type UpdateTarget,
} from "../shared/api.ts"
import { parseCheckOutput } from "./cli/parsers.ts"
import type { SkillsCli } from "./cli/skills-cli.ts"
import { config } from "./config.ts"
import { readScopeLock, type LockReader, type SkillLock } from "./discovery/locks.ts"
import {
  isRemovable,
  type IndexedSkill,
  type SkillPlacement,
} from "./discovery/skill-index.ts"
import { cleanLine } from "./lib/ansi.ts"
import { forbidden, HttpError } from "./lib/errors.ts"
import { isInside, realpathOrNull } from "./lib/files.ts"
import type { JobLog, JobManager } from "./jobs.ts"
import type { RemovalGuard } from "./removal/guard.ts"
import type { PlannedRemoval } from "./removal/plan.ts"

/** How an update step went. */
export interface UpdateOutcome {
  /** false: a failure that could not be pinned to skills; prune nothing */
  ok: boolean
  /** lock keys whose update or source failed: their `available` entries stay */
  failed: string[]
  /** why step 2 must not run, else null */
  blocksRemoval: string | null
}

export interface ActionHooks {
  /**
   * after an update step, whatever the outcome; names empty = every skill in the scope.
   * `output` is the step's CLI output (it names skills deleted upstream).
   */
  afterUpdate?: (
    scope: string,
    names: string[],
    outcome: UpdateOutcome,
    output: string
  ) => void
  /**
   * after a remove of npx skills (CLI names), whatever the outcome: `removed` are the names
   * verified gone from the disk and the lock file; `attempted` every name the job was for
   */
  afterRemove?: (scope: string, removed: string[], attempted: string[]) => void
}

export interface UpdateJobRequest {
  scope: string
  /** empty = every skill in the scope, or none when `remove` is set */
  names: string[]
  /**
   * deleted-upstream removals, authorized by RemovalGuard.authorize: their plans at request
   * time, and the willDelete lists the dialog showed
   */
  remove?: {
    plans: PlannedRemoval[]
    shown: ReadonlyMap<string, readonly string[]>
  }
}

interface StepResult {
  code: number
  output: string
}

/** Builds and queues the jobs that change installed skills. */
export class SkillActions {
  constructor(
    private readonly cli: SkillsCli,
    private readonly jobs: JobManager,
    private readonly hooks: ActionHooks = {},
    private readonly guard: RemovalGuard | null = null,
    private readonly readLock: LockReader = readScopeLock
  ) {}

  install(req: InstallRequest): Job {
    const args = [
      "add",
      req.source,
      "-s",
      ...req.skills,
      "-a",
      ...req.agents,
      "-y",
    ]
    if (req.scope === "user") args.push("-g")
    const count = req.skills.length
    return this.cliJob(
      "install",
      `Install ${req.source} (${count} skill${count === 1 ? "" : "s"})`,
      args,
      req.scope
    )
  }

  /**
   * `skills update`, then (with `remove`) `skills remove` for deleted-upstream skills, as two
   * steps of one job. Step 2 runs only when step 1 printed no failure (whatever its exit
   * code), and then only for names the guard confirms again right before (fresh upstream
   * fetch, unchanged lock entry, plan within what the dialog showed). Afterwards the disk and
   * the lock file are checked. With `remove` and no names, only step 2 runs. 409
   * update_in_progress when a queued or running update job overlaps.
   */
  update(req: UpdateJobRequest): Job {
    const { scope } = req
    const plans = req.remove?.plans ?? []
    const shown = req.remove?.shown ?? new Map()
    const remove = plans.map((p) => p.name)
    if (remove.length && !this.guard)
      throw new HttpError(500, "internal", "Removal is not available")
    const removeOnly = req.names.length === 0 && remove.length > 0
    const names = removeOnly ? [] : req.names
    const target: UpdateTarget = {
      scope,
      names: removeOnly
        ? remove
        : names.length
          ? [...new Set([...names, ...remove])]
          : [],
    }
    const busy = this.jobs
      .unfinished()
      .find((j) => j.update && updateTargetsOverlap(j.update, target))
    if (busy)
      throw new HttpError(
        409,
        "update_in_progress",
        `An update of the same skills is already queued or running: ${busy.title}`,
        { jobId: busy.id }
      )
    const updateArgs = ["update", ...names, scope === "user" ? "-g" : "-p", "-y"]
    const planned = groupPlans(plans).map((g) =>
      removeArgsFor(scope, g.plans.map((p) => p.name), g.agents)
    )
    const steps = [...(removeOnly ? [] : [updateArgs]), ...planned]
    const cwd = scopeCwd(scope)
    let updated: StepResult | null = null
    let outcome: UpdateOutcome | null = null
    let removed: string[] = []

    const run = async (log: JobLog): Promise<number> => {
      if (!removeOnly) {
        if (remove.length) log(`Step 1 of 2: ${this.cli.display(updateArgs)}`)
        const step = await this.runStep(updateArgs, cwd, log)
        updated = step
        const lock = await this.readLock(scope).catch(() => null)
        outcome = assessUpdate(step, lock)
        // A printed failure fails the job even when the CLI exits 0.
        if (!remove.length) return outcome.blocksRemoval ? step.code || 1 : step.code
        if (outcome.blocksRemoval) {
          log(`Step 2 of 2 skipped: ${outcome.blocksRemoval}, so nothing was removed.`)
          return step.code || 1
        }
        log("")
        log("Step 2 of 2: remove the deleted-upstream skills")
      }
      const guard = this.guard as RemovalGuard
      const result = await this.removeConfirmed(guard, scope, remove, shown, cwd, log)
      removed = result.removed
      return result.ok ? 0 : 1
    }

    const what = names.length ? names.join(", ") : "all skills"
    const title = removeOnly
      ? `Remove ${remove.join(", ")} (deleted upstream, ${scopeLabel(scope)})`
      : remove.length
        ? `Update ${what}, remove ${remove.join(", ")} (${scopeLabel(scope)})`
        : `Update ${what} (${scopeLabel(scope)})`
    return this.jobs.enqueue({
      kind: removeOnly ? "remove" : "update",
      title,
      command: steps.map((args) => this.cli.display(args)).join(" && "),
      cwd,
      update: target,
      ...(remove.length ? { remove } : {}),
      run,
      onDone: () => {
        const u = updated as StepResult | null
        if (u) {
          const o = (outcome as UpdateOutcome | null) ?? {
            ok: false,
            failed: [],
            blocksRemoval: "the update did not finish",
          }
          this.hooks.afterUpdate?.(scope, names, o, u.output)
        }
        if (remove.length) this.hooks.afterRemove?.(scope, removed, remove)
      },
    })
  }

  /**
   * Step 2: confirm each name again (guard.prepare), run `skills remove` once per set of
   * agents, then check the disk and the lock file (guard.verify).
   */
  private async removeConfirmed(
    guard: RemovalGuard,
    scope: string,
    names: string[],
    shown: ReadonlyMap<string, readonly string[]>,
    cwd: string,
    log: JobLog
  ): Promise<{ ok: boolean; removed: string[] }> {
    let prepared
    try {
      prepared = await guard.prepare(scope, names, shown, log)
    } catch (err) {
      log(`Nothing removed: ${(err as Error).message}`)
      return { ok: false, removed: [] }
    }
    const removed: string[] = []
    let ok = prepared.failed.length === 0
    for (const group of prepared.groups) {
      const args = removeArgsFor(scope, group.plans.map((p) => p.name), group.agents)
      log(`$ ${this.cli.display(args)}`)
      const step = await this.runStep(args, cwd, log)
      const verified = await guard.verify(scope, group.plans, step.output, step.code)
      removed.push(...verified.removed)
      for (const item of verified.incomplete) {
        ok = false
        log(`Incomplete removal of ${item.name}: ${item.problems.join("; ")}`)
      }
    }
    if (prepared.groups.length === 0) log("Nothing was removed.")
    else if (removed.length) log(`Removed and verified: ${removed.join(", ")}`)
    return { ok, removed }
  }

  /** Runs one CLI step into the job log, and keeps its output. */
  private async runStep(
    args: string[],
    cwd: string,
    log: JobLog
  ): Promise<StepResult> {
    const lines: string[] = []
    const { exitCode, timedOut } = await this.cli.stream(
      args,
      cwd,
      (line) => {
        lines.push(line)
        log(line)
      },
      config.cliTimeoutMs * 5
    )
    if (timedOut) log("Timed out; the command was stopped.")
    return { code: timedOut ? exitCode || 1 : exitCode, output: lines.join("\n") }
  }

  /**
   * Remove one skill. npx skills: `skills remove` with -a limited by the plan (independent
   * same-named copies stay), refused (409) when the plan is blocked, and checked on disk
   * afterwards. `plan` comes from RemovalGuard.plans at request time.
   */
  remove(skill: IndexedSkill, plan?: PlannedRemoval): Job {
    if (skill.origin === "npx") {
      if (!plan || !this.guard)
        throw new HttpError(500, "internal", "Removal is not available")
      if (plan.blocked)
        throw new HttpError(
          409,
          plan.blockCode === "collision" ? "removal_conflict" : "removal_blocked",
          plan.blocked
        )
      const guard = this.guard
      const args = removeArgsFor(skill.scope, [skill.cliName], plan.agents)
      const cwd = scopeCwd(skill.scope)
      let removed: string[] = []
      return this.jobs.enqueue({
        kind: "remove",
        title: `Remove ${skill.cliName} (${scopeLabel(skill.scope)})`,
        command: this.cli.display(args),
        cwd,
        run: async (log) => {
          // The disk may have changed since the request: plan again, never wider.
          const [now] = await guard.plans(skill.scope, [skill.cliName])
          const extra = now.willDelete.filter((p) => !plan.willDelete.includes(p))
          if (now.blocked || extra.length || now.agents.join(" ") !== plan.agents.join(" ")) {
            log(`Nothing removed: ${now.blocked ?? `what would be deleted changed (${extra.join(", ") || "other agents"})`}`)
            return 1
          }
          for (const k of now.kept) log(`Kept: ${k.reason} at ${k.path}`)
          const step = await this.runStep(args, cwd, log)
          const verified = await guard.verify(skill.scope, [now], step.output, step.code)
          removed = verified.removed
          for (const item of verified.incomplete)
            log(`Incomplete removal of ${item.name}: ${item.problems.join("; ")}`)
          return verified.incomplete.length ? 1 : 0
        },
        onDone: () => {
          this.hooks.afterRemove?.(skill.scope, removed, [skill.cliName])
        },
      })
    }
    if (skill.origin !== "manual")
      throw forbidden(`${skill.origin} skills cannot be removed here`)
    if (!isRemovable(skill))
      throw forbidden(
        "This skill lives in a project folder that is not an agent install dir; remove it by hand"
      )
    return this.jobs.enqueue({
      kind: "remove",
      title: `Remove ${skill.name} (${scopeLabel(skill.scope)})`,
      command: `delete ${skill.realPath}`,
      cwd: skill.realPath,
      run: (log) => removeManualSkill(skill, log),
    })
  }

  private cliJob(
    kind: Job["kind"],
    title: string,
    args: string[],
    scope: string
  ): Job {
    const cwd = scopeCwd(scope)
    return this.jobs.enqueue({
      kind,
      title,
      command: this.cli.display(args),
      cwd,
      run: async (log) => (await this.runStep(args, cwd, log)).code,
    })
  }
}

function scopeCwd(scope: string): string {
  return scope === "user" ? config.home : scope
}

function groupPlans(plans: PlannedRemoval[]): { agents: string[]; plans: PlannedRemoval[] }[] {
  const groups = new Map<string, { agents: string[]; plans: PlannedRemoval[] }>()
  for (const plan of plans) {
    const key = plan.agents.join(" ")
    const group = groups.get(key) ?? { agents: plan.agents, plans: [] }
    group.plans.push(plan)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function removeArgsFor(scope: string, names: string[], agents: string[]): string[] {
  const args = ["remove", "-s", ...names, "-a", ...agents, "-y"]
  if (scope === "user") args.push("-g")
  return args
}

/**
 * How `skills update` went, from its output whatever the exit code: it prints
 * "✗ Failed to check skills from <source>" and still exits 0 when a source cannot be
 * fetched. A skill gone from its download ("is no longer in this download") counts as
 * failed in the CLI; here it is deleted upstream, not a failure.
 *
 * - Each failure line is pinned to lock keys: a source (source or sourceUrl) names every
 *   key from it, a skill name names that key. Those keys stay in `available`.
 * - A failure that cannot be pinned, a timeout, an exit code other than 0 or 1, or exit 1
 *   without a line that explains it: ok false, nothing is pruned.
 * - Any failure at all blocks step 2: the sources the job touched did not all check out.
 */
export function assessUpdate(
  { code, output }: StepResult,
  lock: SkillLock | null
): UpdateOutcome {
  const report = parseCheckOutput(output)
  const failed = new Set<string>()
  const named = new Set<string>()
  let unpinned = false
  for (const failure of report.failures) {
    const keys = keysFor(failure.name, lock)
    if (keys.length === 0) unpinned = true
    named.add(failure.name)
    for (const key of keys) failed.add(key)
  }
  const countOnly = report.failCount - report.goneFromDownload > 0 && report.failures.length === 0
  const exitUnexplained =
    code !== 0 &&
    !(code === 1 && (report.failures.length > 0 || report.goneFromDownload > 0))
  if (unpinned || countOnly || exitUnexplained || (code !== 0 && code !== 1)) {
    return {
      ok: false,
      failed: [...failed],
      blocksRemoval: exitUnexplained || code > 1 ? `the update exited with ${code}` : "the update reported a failure",
    }
  }
  return {
    ok: true,
    failed: [...failed],
    blocksRemoval: failed.size ? `the update could not check ${[...named].join(", ")}` : null,
  }
}

/** Lock keys a CLI failure line names: by source, sourceUrl or the key itself. */
function keysFor(name: string, lock: SkillLock | null): string[] {
  if (!lock) return []
  const keys: string[] = []
  for (const [key, entry] of lock.skills)
    if (key === name || entry.source === name || entry.sourceUrl === name) keys.push(key)
  return keys
}

/** @deprecated kept for callers that only need a yes/no; see assessUpdate. */
export function updateSucceeded(step: StepResult, lock: SkillLock | null = null): boolean {
  return assessUpdate(step, lock).blocksRemoval === null
}

// `skills remove` exits 0 even when it removed nothing (skills 1.9.0 removeCommand).
const REMOVE_FAILED = [
  /Failed to remove \d+ skill\(s\)/,
  /No matching skills found for/,
  /No skills found to remove/,
  /Could not remove skill from /,
]

export function removeSucceeded({ code, output }: StepResult): boolean {
  if (code !== 0) return false
  const lines = output.split("\n").map((line) => cleanLine(line))
  return !lines.some((line) => REMOVE_FAILED.some((re) => re.test(line)))
}

/**
 * Test seams: called between the steps of a recursive delete, so tests can
 * swap paths in the gaps where a race could happen.
 */
export interface RemoveHooks {
  /** after the chain check, before the folder is moved to the trash dir */
  afterVerify?: () => Promise<void> | void
  /** after the move, before the trashed folder is checked again */
  afterTrash?: () => Promise<void> | void
}

const TRASH_PREFIX = ".skills-manager-trash-"

/**
 * Removes a hand-made skill. Only placements in a deletable skills dir are
 * touched (see SkillLocation.deletable). Nothing is cached: each placement is
 * checked right before it is changed.
 *
 * - A placement that is a symlink is unlinked (its target stays), if its
 *   skills dir passes the chain check.
 * - The folder itself is deleted only from a placement that is a plain dir
 *   whose real path is the skill's real path. To delete, the chain is checked,
 *   the folder is renamed into a fresh hidden trash dir inside the same skills
 *   dir, the result is checked again (same inode, real path inside the real
 *   skills dir, no symlinks on the way), and only then is it deleted by real
 *   path. If a check fails, the folder is moved back and nothing is deleted.
 *
 * Bun/Node have no openat/unlinkat, so a process running as the same user
 * can still race the last step; the threat model accepts that. The recursive
 * delete itself is Bun's rm, which walks with openat(O_NOFOLLOW|O_DIRECTORY)
 * and unlinkat on dir fds: it never follows a symlink inside the folder
 * (traced with strace on Bun 1.4; pinned by a test in remove.test.ts).
 */
export async function removeManualSkill(
  skill: Pick<IndexedSkill, "realPath" | "placements">,
  log: JobLog,
  home = config.home,
  hooks: RemoveHooks = {}
): Promise<number> {
  let removed = false
  let owner: SkillPlacement | null = null
  for (const placement of skill.placements) {
    const info = await lstat(placement.path).catch(() => null)
    if (!info) continue
    if (!placement.deletable) {
      log(`Kept ${placement.path}: the manager does not delete from ${placement.root}.`)
      continue
    }
    if (!(await verifiedSkillsDir(placement, home))) {
      log(`Kept ${placement.path}: its skills dir links outside the scope.`)
      continue
    }
    if (info.isSymbolicLink()) {
      await unlink(placement.path)
      removed = true
      log(`Removed link ${placement.path}`)
      continue
    }
    const real = await realpathOrNull(placement.path)
    if (info.isDirectory() && real === skill.realPath) owner = placement
  }
  if (owner === null) {
    if (removed) log(`Kept ${skill.realPath}: it lives outside the skills dirs.`)
    else log(`Nothing removed: ${skill.realPath} is not in a skills dir.`)
    return removed ? 0 : 1
  }
  if (isUnsafeToDelete(owner.path, home)) {
    log(`Refused to delete ${owner.path}`)
    return 1
  }
  const ok = await deleteSkillFolder(owner, skill.realPath, home, log, hooks)
  return ok ? 0 : 1
}

/** Verify, move into a trash dir, verify again, then delete. */
async function deleteSkillFolder(
  placement: SkillPlacement,
  realPath: string,
  home: string,
  log: JobLog,
  hooks: RemoveHooks
): Promise<boolean> {
  const name = basename(placement.path)
  const before = await lstat(placement.path).catch(() => null)
  const realRoot = await verifiedSkillsDir(placement, home)
  if (
    !before?.isDirectory() ||
    !realRoot ||
    join(realRoot, name) !== realPath ||
    (await realpathOrNull(placement.path)) !== realPath
  ) {
    log(`Refused to delete ${placement.path}: it moved or its skills dir changed.`)
    return false
  }
  await hooks.afterVerify?.()

  const trashName = TRASH_PREFIX + crypto.randomUUID().slice(0, 8)
  const trash = join(placement.root, trashName)
  const trashed = join(trash, name)
  try {
    await mkdir(trash, { mode: 0o700 })
    await rename(placement.path, trashed)
  } catch (err) {
    await rmdir(trash).catch(() => {})
    log(`Could not delete ${placement.path}: ${(err as Error).message}`)
    return false
  }
  await hooks.afterTrash?.()

  const realTrashed = await checkTrashed(placement, trashed, before, home)
  if (!realTrashed) {
    const back = await rename(trashed, placement.path).then(
      () => true,
      () => false
    )
    await rmdir(trash).catch(() => {})
    log(
      back
        ? `Refused to delete ${placement.path}: its skills dir changed. Nothing was deleted.`
        : `Refused to delete ${placement.path}: its skills dir changed. The folder was left at ${trashed}.`
    )
    return false
  }
  await rm(realTrashed, { recursive: true })
  await rmdir(dirname(realTrashed)).catch(() => {})
  log(`Deleted ${placement.path}`)
  return true
}

/**
 * Real path of the trashed folder if it is still the folder that was
 * verified (same device and inode, not a symlink) and sits in a trash dir
 * directly inside the verified real skills dir. Else null.
 */
async function checkTrashed(
  placement: SkillPlacement,
  trashed: string,
  before: Stats,
  home: string
): Promise<string | null> {
  const realRoot = await verifiedSkillsDir(placement, home)
  if (!realRoot) return null
  const trash = dirname(trashed)
  const [trashInfo, info] = await Promise.all([
    lstat(trash).catch(() => null),
    lstat(trashed).catch(() => null),
  ])
  if (!trashInfo?.isDirectory() || trashInfo.isSymbolicLink()) return null
  if (!info?.isDirectory() || info.isSymbolicLink()) return null
  if (info.dev !== before.dev || info.ino !== before.ino) return null
  const real = await realpathOrNull(trashed)
  const expected = join(realRoot, basename(trash), basename(trashed))
  if (real !== expected || !isInside(realRoot, real)) return null
  return real
}

/**
 * Real path of the placement's skills dir if it resolves to the path
 * discovery expects: the placement is a direct child of the dir, and no
 * component from the scope root (home or the project) down to the dir is a
 * symlink or a non-directory. The scope root itself may sit behind a link;
 * it is resolved and trusted. Else null.
 */
export async function verifiedSkillsDir(
  placement: Pick<SkillPlacement, "path" | "root" | "scope">,
  home: string
): Promise<string | null> {
  const root = resolve(placement.root)
  if (dirname(resolve(placement.path)) !== root) return null
  const scopeRoot = resolve(placement.scope === "user" ? home : placement.scope)
  const base = isInside(scopeRoot, root) ? scopeRoot : dirname(root)
  const realBase = await realpathOrNull(base)
  if (!realBase) return null
  let current = base
  for (const part of relative(base, root).split("/").filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current).catch(() => null)
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return null
  }
  const realRoot = await realpathOrNull(root)
  return realRoot === join(realBase, relative(base, root)) ? realRoot : null
}

function isUnsafeToDelete(path: string, home: string): boolean {
  const p = resolve(path)
  return p === home || isInside(p, home) || p.split("/").length < 4
}

function scopeLabel(scope: string): string {
  return scope === "user" ? "user" : (scope.split("/").pop() ?? scope)
}
