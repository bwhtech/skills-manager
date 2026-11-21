import type { Stats } from "node:fs"
import { lstat, mkdir, rename, rm, rmdir, unlink } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { InstallRequest, Job, UpdateRunRequest } from "../shared/api.ts"
import type { SkillsCli } from "./cli/skills-cli.ts"
import { config } from "./config.ts"
import {
  isRemovable,
  type IndexedSkill,
  type SkillPlacement,
} from "./discovery/skill-index.ts"
import { forbidden } from "./lib/errors.ts"
import { isInside, realpathOrNull } from "./lib/files.ts"
import type { JobLog, JobManager } from "./jobs.ts"

export interface ActionHooks {
  /** after an update job; names empty = every skill in the scope */
  afterUpdate?: (scope: string, names: string[]) => void
}

/** Builds and queues the jobs that change installed skills. */
export class SkillActions {
  constructor(
    private readonly cli: SkillsCli,
    private readonly jobs: JobManager,
    private readonly hooks: ActionHooks = {}
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

  update(
    req: Required<Pick<UpdateRunRequest, "scope">> & { names: string[] }
  ): Job {
    const args = [
      "update",
      ...req.names,
      req.scope === "user" ? "-g" : "-p",
      "-y",
    ]
    const what = req.names.length ? req.names.join(", ") : "all skills"
    return this.cliJob(
      "update",
      `Update ${what} (${scopeLabel(req.scope)})`,
      args,
      req.scope,
      () => this.hooks.afterUpdate?.(req.scope, req.names)
    )
  }

  remove(skill: IndexedSkill): Job {
    if (skill.origin === "npx") {
      const args = ["remove", "-s", skill.cliName, "-y"]
      if (skill.scope === "user") args.push("-g")
      return this.cliJob(
        "remove",
        `Remove ${skill.cliName} (${scopeLabel(skill.scope)})`,
        args,
        skill.scope
      )
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
    scope: string,
    onDone?: () => void
  ): Job {
    const cwd = scope === "user" ? config.home : scope
    return this.jobs.enqueue({
      kind,
      title,
      command: this.cli.display(args),
      cwd,
      onDone,
      run: async (log) => {
        const { exitCode, timedOut } = await this.cli.stream(
          args,
          cwd,
          log,
          config.cliTimeoutMs * 5
        )
        if (timedOut) log("Timed out; the command was stopped.")
        return exitCode
      },
    })
  }
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
