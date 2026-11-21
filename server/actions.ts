import type { Stats } from "node:fs"
import { lstat, mkdir, rename, rm, rmdir, unlink } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import {
  updateTargetsOverlap,
  type InstallRequest,
  type Job,
  type ShownRemovalPlan,
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
import { checkShown, logCopies, type RemovalGuard, type ShownPlans } from "./removal/guard.ts"
import {
  QUICK_MAX_ENTRIES,
  fullDigest,
  quickDigest,
  sameIdentity,
  takeInventory,
  type CopyIdentity,
} from "./removal/inventory.ts"
import type { PlannedRemoval } from "./removal/plan.ts"
import { PREVIEW_LIMITS } from "./preview/limits.ts"

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
  /** test seam: called around the staging of each ticked copy (see StageHooks) */
  stage?: StageHooks
}

export interface UpdateJobRequest {
  scope: string
  /** empty = every skill in the scope, or none when `remove` is set */
  names: string[]
  /**
   * deleted-upstream removals, authorized by RemovalGuard.authorize: their plans at request
   * time, and what the dialog showed and ticked per name
   */
  remove?: {
    plans: PlannedRemoval[]
    shown: ShownPlans
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
    const expected = identitiesOf(plans)
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
      const result = await this.removeConfirmed(guard, scope, remove, shown, cwd, log, expected)
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
    shown: ShownPlans,
    cwd: string,
    log: JobLog,
    expected: ReadonlyMap<string, CopyIdentity | null>
  ): Promise<{ ok: boolean; removed: string[] }> {
    let prepared
    try {
      prepared = await guard.prepare(scope, names, shown, log)
    } catch (err) {
      log(`Nothing removed: ${(err as Error).message}`)
      return { ok: false, removed: [] }
    }
    if (prepared.groups.length === 0) {
      log("Nothing was removed.")
      return { ok: prepared.failed.length === 0, removed: [] }
    }
    const result = await this.runRemoval(guard, scope, prepared.groups.flatMap((g) => g.plans), cwd, log, expected)
    return { ok: result.ok && prepared.failed.length === 0, removed: result.removed }
  }

  /**
   * Confirmed plans, per set of agents (one `skills remove` call each):
   *
   * 1. Every ticked copy must still be the folder the request validated (`expected`: device,
   *    inode and inventory digests recorded server side when the request was planned).
   * 2. Re-check the group with the ticked copies assumed gone (guard.recheck "present").
   * 3. Stage each ticked copy: checked again right before (device, inode, metadata walk),
   *    moved into a trash dir in its own skills dir, checked after the move (device, inode,
   *    full inventory). Any mismatch moves it back and skips the group.
   * 4. Re-check with the copies staged. A failure restores them and skips the group.
   * 5. Run `skills remove`, verify. Staged copies of a verified name are deleted for good;
   *    those of a name that did not verify (or of a failed call) are moved back.
   */
  private async runRemoval(
    guard: RemovalGuard,
    scope: string,
    plans: PlannedRemoval[],
    cwd: string,
    log: JobLog,
    expected: ReadonlyMap<string, CopyIdentity | null>
  ): Promise<{ ok: boolean; removed: string[] }> {
    const removed: string[] = []
    const deleted: string[] = []
    const restored: string[] = []
    const stranded: string[] = []
    let ok = true
    const settled = new Set<StagedCopy>()
    const giveBack = async (staged: StagedCopy[]) => {
      for (const copy of [...staged].reverse()) {
        if (settled.has(copy)) continue
        settled.add(copy)
        if (await restoreStaged(copy, log)) restored.push(copy.path)
        else stranded.push(copy.trashed)
      }
    }
    for (const group of groupPlans(plans)) {
      const names = group.plans.map((p) => p.name)
      const skip = (reason: string) => {
        ok = false
        log(`Skipped ${names.join(", ")} (removal_plan_changed): ${reason.replace(/\.+$/, "")}. Open the dialog again.`)
      }
      const ticked = group.plans.flatMap((plan) => plan.deleteCopies.map((path) => ({ plan, path })))
      const swapped = ticked.filter(({ plan, path }) => !sameIdentity(expected.get(path), plan.identities[path]))
      if (swapped.length) {
        skip(`${swapped.map((t) => t.path).join(", ")} is not the folder that was checked when the removal was requested`)
        continue
      }
      const before = await guard.recheck(scope, group.plans, { copies: "present" })
      if (!before.ok) {
        skip(before.reason)
        continue
      }
      const staged: StagedCopy[] = []
      try {
        let stageFailed: string | null = null
        for (const { path } of ticked) {
          const copy = await stageCopy(path, scope, guard.home, expected.get(path) ?? null, log, this.hooks.stage)
          if (!copy) {
            stageFailed = path
            break
          }
          staged.push(copy)
        }
        if (stageFailed) {
          ok = false
          log(`Skipped ${names.join(", ")}: the separate copy ${stageFailed} could not be staged, so skills remove did not run.`)
          await giveBack(staged)
          continue
        }
        const done = await this.removeGroup(guard, scope, group, staged, cwd, log, { removed, deleted, settled, stranded, giveBack })
        if (!done) ok = false
      } catch (err) {
        // Whatever failed, no staged copy stays in a trash dir unless it cannot be moved back.
        ok = false
        log(`Stopped ${names.join(", ")}: ${(err as Error).message}`)
        await giveBack(staged)
      }
    }
    if (deleted.length) log(`Deleted separate copies: ${deleted.join(", ")}`)
    if (restored.length) log(`Restored separate copies: ${restored.join(", ")}`)
    if (stranded.length) {
      ok = false
      log(`Left in a trash dir (move them back by hand): ${stranded.join(", ")}`)
    }
    if (removed.length) log(`Removed and verified: ${removed.join(", ")}`)
    return { ok, removed }
  }

  /**
   * Steps 4 and 5 of runRemoval for one group whose ticked copies are staged: re-check with
   * them staged, run `skills remove`, verify, then delete the copies of verified names and
   * move the others back. False when anything failed (logged).
   */
  private async removeGroup(
    guard: RemovalGuard,
    scope: string,
    group: { agents: string[]; plans: PlannedRemoval[] },
    staged: StagedCopy[],
    cwd: string,
    log: JobLog,
    out: {
      removed: string[]
      deleted: string[]
      /** staged copies already deleted or moved back */
      settled: Set<StagedCopy>
      stranded: string[]
      giveBack: (copies: StagedCopy[]) => Promise<void>
    }
  ): Promise<boolean> {
    const names = group.plans.map((p) => p.name)
    const checked = await guard.recheck(scope, group.plans)
    if (!checked.ok) {
      log(`Skipped ${names.join(", ")} (removal_plan_changed): ${checked.reason.replace(/\.+$/, "")}. Open the dialog again.`)
      await out.giveBack(staged)
      return false
    }
    let ok = true
    const args = removeArgsFor(scope, names, group.agents)
    log(`$ ${this.cli.display(args)}`)
    const step = await this.runStep(args, cwd, log)
    const verified = await guard.verify(scope, group.plans, step.output, step.code, checked.snapshot)
    out.removed.push(...verified.removed)
    for (const item of verified.incomplete) {
      ok = false
      log(`Incomplete removal of ${item.name}: ${item.problems.join("; ")}`)
    }
    const back: StagedCopy[] = []
    for (const plan of group.plans) {
      const mine = staged.filter((copy) => plan.deleteCopies.includes(copy.path))
      if (!verified.removed.includes(plan.name)) {
        back.push(...mine)
        continue
      }
      for (const copy of mine) {
        out.settled.add(copy)
        if (await purgeStaged(copy, guard.home, log)) out.deleted.push(copy.path)
        else {
          ok = false
          out.stranded.push(copy.trashed)
        }
      }
    }
    if (back.length) {
      log(`Moving back the separate copies of what did not verify: ${back.map((c) => c.path).join(", ")}`)
      await out.giveBack(back)
    }
    return ok
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
   * Remove one skill. npx skills: the ticked copies first, then `skills remove` with -a
   * limited by the plan (other same-named copies stay), refused (409) when the plan is
   * blocked, and checked on disk afterwards. `plan` comes from RemovalGuard.plans (intent
   * "remove", the ticked copies as gone) at request time; `shown` is what the dialog showed.
   */
  remove(skill: IndexedSkill, plan?: PlannedRemoval, shown?: ShownRemovalPlan): Job {
    if (skill.origin === "npx") {
      if (!plan || !this.guard)
        throw new HttpError(500, "internal", "Removal is not available")
      const asShown: ShownRemovalPlan = shown ?? {
        willDelete: plan.willDelete,
        copies: plan.deleteCopies,
        shownCopies: plan.copies.map((c) => ({ path: c.path, identical: c.identical })),
      }
      const refusal = checkShown(plan, asShown)
      if (refusal) throw refusal
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
          const [now] = await guard.plans(skill.scope, [skill.cliName], {
            intent: "remove",
            gone: new Map([[skill.cliName, plan.deleteCopies]]),
          })
          const changed = checkShown(now, asShown)
          if (changed || now.agents.join(" ") !== plan.agents.join(" ")) {
            log(`Nothing removed: ${changed ? (changed.detail ?? changed.message) : "the agents to pass changed"}`)
            return 1
          }
          logCopies(now, log)
          const result = await this.runRemoval(guard, skill.scope, [now], cwd, log, identitiesOf([plan]))
          removed = result.removed
          return result.ok ? 0 : 1
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

/** The identities of the ticked copies, as the request-time plans recorded them. */
function identitiesOf(plans: PlannedRemoval[]): Map<string, CopyIdentity | null> {
  const out = new Map<string, CopyIdentity | null>()
  for (const plan of plans) for (const path of plan.deleteCopies) out.set(path, plan.identities[path] ?? null)
  return out
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

/** Test seams around the staging of one ticked copy (path = the copy's path). */
export interface StageHooks {
  /** before the checks that precede the move */
  beforeCheck?: (path: string) => Promise<void> | void
  /** after those checks, right before the move into the trash dir */
  afterCheck?: (path: string) => Promise<void> | void
  /** after the move, before the trashed folder is checked */
  afterMove?: (path: string) => Promise<void> | void
}

/** A ticked copy moved into a trash dir in its own skills dir, not yet deleted. */
export interface StagedCopy {
  path: string
  placement: SkillPlacement
  /** the folder in the trash dir */
  trashed: string
  dev: number
  ino: number
}

/**
 * Stages a separate copy of an npx skill that the user ticked: a real folder directly in a
 * verified agent skills dir (no symlink from the scope root down to it), still the folder the
 * plan checked. Right before the move: same device and inode, same metadata walk (names,
 * kinds, modes, sizes, link texts, mtimes). It is moved into a fresh trash dir inside the same
 * skills dir, then checked again: same device and inode, still in the trash dir inside the
 * real skills dir, and the same full inventory (bytes included) as the plan recorded; for a
 * copy too large to read, the same metadata walk. On any mismatch it is moved back. Null when
 * it was not staged (logged).
 */
export async function stageCopy(
  path: string,
  scope: string,
  home: string,
  identity: CopyIdentity | null,
  log: JobLog,
  hooks: StageHooks = {}
): Promise<StagedCopy | null> {
  await hooks.beforeCheck?.(path)
  const refuse = (why: string) => {
    log(`Refused to stage the separate copy ${path}: ${why}.`)
    return null
  }
  if (!identity) return refuse("it could not be fingerprinted when it was checked, so it is not deleted here")
  const placement: SkillPlacement = { path, root: dirname(path), scope, deletable: true }
  const realRoot = await verifiedSkillsDir(placement, home)
  if (!realRoot) return refuse("its skills dir links outside the scope")
  if (isUnsafeToDelete(path, home)) return refuse("the path is not safe to delete")
  const info = await lstat(path).catch(() => null)
  if (!info?.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino)
    return refuse("it is not the folder that was checked (it was moved or replaced)")
  if ((await realpathOrNull(path)) !== join(realRoot, basename(path))) return refuse("it moved or its skills dir changed")
  const quick = await takeInventory(path, { maxEntries: QUICK_MAX_ENTRIES, maxReadBytes: 0 }, { content: false }).catch(() => null)
  if (!quick || quickDigest(quick) !== identity.quick) return refuse("its files changed since it was checked")
  await hooks.afterCheck?.(path)

  const trash = join(placement.root, TRASH_PREFIX + crypto.randomUUID().slice(0, 8))
  const trashed = join(trash, basename(path))
  try {
    await mkdir(trash, { mode: 0o700 })
    await rename(path, trashed)
  } catch (err) {
    await rmdir(trash).catch(() => {})
    return refuse(`could not move it into a trash dir (${(err as Error).message})`)
  }
  const staged: StagedCopy = { path, placement, trashed, dev: info.dev, ino: info.ino }
  await hooks.afterMove?.(path)

  const problem = await checkStaged(staged, home, identity)
  if (problem) {
    log(`Refused to stage the separate copy ${path}: ${problem}.`)
    await restoreStaged(staged, log)
    return null
  }
  log(`Staged the separate copy ${path} in ${trash}`)
  return staged
}

/** Why the staged folder is not the checked copy any more, else null. */
async function checkStaged(staged: StagedCopy, home: string, identity: CopyIdentity): Promise<string | null> {
  const real = await checkTrashed(staged.placement, staged.trashed, staged, home)
  if (!real) return "what was moved is not the folder that was checked"
  const limits = { maxEntries: PREVIEW_LIMITS.maxFilesPerSide, maxReadBytes: PREVIEW_LIMITS.maxReadBytes }
  const inv = identity.full
    ? await takeInventory(real, limits).catch(() => null)
    : await takeInventory(real, { maxEntries: QUICK_MAX_ENTRIES, maxReadBytes: 0 }, { content: false }).catch(() => null)
  if (!inv || inv.dev !== identity.dev || inv.ino !== identity.ino) return "what was moved is not the folder that was checked"
  const same = identity.full ? fullDigest(inv) === identity.full : quickDigest(inv) === identity.quick
  return same ? null : "its contents are not the ones that were checked"
}

/**
 * Moves a staged copy back to its path: never over something that appeared there meanwhile,
 * and checked after (same device and inode). False when it stays in the trash dir (logged).
 */
export async function restoreStaged(staged: StagedCopy, log: JobLog): Promise<boolean> {
  if (await lstat(staged.path).catch(() => null)) {
    log(`Could not restore the separate copy ${staged.path}: something else is there now. It is at ${staged.trashed}.`)
    return false
  }
  const moved = await rename(staged.trashed, staged.path).then(
    () => true,
    (err: Error) => {
      log(`Could not restore the separate copy ${staged.path} (${err.message}). It is at ${staged.trashed}.`)
      return false
    }
  )
  if (!moved) return false
  await rmdir(dirname(staged.trashed)).catch(() => {})
  const info = await lstat(staged.path).catch(() => null)
  if (!info || info.dev !== staged.dev || info.ino !== staged.ino) {
    log(`Restored ${staged.path}, but it is not the folder that was staged; check it by hand.`)
    return false
  }
  log(`Restored the separate copy ${staged.path}`)
  return true
}

/** Deletes a staged copy for good, after checking it is still the staged folder. */
export async function purgeStaged(staged: StagedCopy, home: string, log: JobLog): Promise<boolean> {
  const real = await checkTrashed(staged.placement, staged.trashed, staged, home)
  if (!real) {
    log(`Did not delete the separate copy ${staged.path}: its trash dir changed. It is at ${staged.trashed}.`)
    return false
  }
  await rm(real, { recursive: true })
  await rmdir(dirname(real)).catch(() => {})
  log(`Deleted the separate copy ${staged.path}`)
  return true
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
  before: Pick<Stats, "dev" | "ino">,
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
