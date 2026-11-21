import type { Stats } from "node:fs"
import { lstat, mkdir, rename, rm, rmdir } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { SkillPlacement } from "../discovery/skill-index.ts"
import type { JobLog } from "../jobs.ts"
import { isInside, realpathOrNull } from "../lib/files.ts"
import { DELETE_LIMITS, QUICK_LIMITS, fullDigest, quickDigest, takeInventory, type CopyIdentity } from "./inventory.ts"
import type { JournalStatus, RemovalJournal } from "./journal.ts"

/**
 * Staging of separate copies that a removal deletes: each ticked copy is moved into a hidden
 * trash dir in its own skills dir (`.skills-manager-trash-<id>/<name>`) before `skills remove`
 * runs, and deleted for good only after the removal verified. A journal records each move
 * first (journal.ts), so a crash leaves a visible, recoverable state (recovery.ts).
 */
export const TRASH_PREFIX = ".skills-manager-trash-"

/** Test seams around the staging of one ticked copy (path = the copy's path). */
export interface StageHooks {
  /** before the checks that precede the move */
  beforeCheck?: (path: string) => Promise<void> | void
  /** after those checks and the journal entry, right before the move into the trash dir */
  afterCheck?: (path: string) => Promise<void> | void
  /** after the move, before the trashed folder is checked */
  afterMove?: (path: string) => Promise<void> | void
  /**
   * after every ticked copy of a group is staged and journaled, before the re-check and
   * `skills remove` (SKILLS_MANAGER_TEST_CRASH_AFTER_STAGE kills the server here)
   */
  afterGroupStaged?: (paths: string[]) => Promise<void> | void
}

/** Test seams of a move back (moveBack): `path` is the original path. */
export interface RestoreHooks {
  /** before the empty folder is made at the original path */
  beforeMkdir?: (path: string) => Promise<void> | void
  /** after that folder is made, before the copy is renamed onto it */
  afterMkdir?: (path: string) => Promise<void> | void
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
 * kinds, modes, sizes, link texts, mtimes). The journal records the move before it happens.
 * The copy is moved into a fresh trash dir inside the same skills dir, then checked again:
 * same device and inode, still in the trash dir inside the real skills dir, and the same full
 * inventory (every byte) as the plan recorded. On any mismatch it is moved back. Null when it
 * was not staged (logged).
 */
export async function stageCopy(
  path: string,
  scope: string,
  home: string,
  identity: CopyIdentity | null,
  log: JobLog,
  hooks: StageHooks = {},
  journal?: RemovalJournal
): Promise<StagedCopy | null> {
  await hooks.beforeCheck?.(path)
  const refuse = (why: string) => {
    log(`Refused to stage the separate copy ${path}: ${why}.`)
    return null
  }
  if (!identity) return refuse("it is too large to fingerprint, so it is not deleted here")
  const placement: SkillPlacement = { path, root: dirname(path), scope, deletable: true }
  const realRoot = await verifiedSkillsDir(placement, home)
  if (!realRoot) return refuse("its skills dir links outside the scope")
  if (isUnsafeToDelete(path, home)) return refuse("the path is not safe to delete")
  const info = await lstat(path).catch(() => null)
  if (!info?.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino)
    return refuse("it is not the folder that was checked (it was moved or replaced)")
  if ((await realpathOrNull(path)) !== join(realRoot, basename(path))) return refuse("it moved or its skills dir changed")
  const quick = await takeInventory(path, QUICK_LIMITS, { content: false }).catch(() => null)
  if (!quick || quickDigest(quick) !== identity.quick) return refuse("its files changed since it was checked")

  const trash = join(placement.root, TRASH_PREFIX + crypto.randomUUID().slice(0, 8))
  const trashed = join(trash, basename(path))
  // The journal first: whatever happens after the move, there is a record of where it went.
  if (journal) {
    try {
      await journal.plan({ original: path, staged: trashed, scope, dev: info.dev, ino: info.ino, full: identity.full })
    } catch (err) {
      return refuse(`could not write the removal journal (${(err as Error).message})`)
    }
  }
  await hooks.afterCheck?.(path)
  try {
    await mkdir(trash, { mode: 0o700 })
    await rename(path, trashed)
  } catch (err) {
    await rmdir(trash).catch(() => {})
    await journal?.drop(trashed).catch(() => {})
    return refuse(`could not move it into a trash dir (${(err as Error).message})`)
  }
  const staged: StagedCopy = { path, placement, trashed, dev: info.dev, ino: info.ino }
  const noted = await note(journal, trashed, "staged")
  if (noted) {
    log(`Refused to stage the separate copy ${path}: could not update the removal journal (${noted}).`)
    await restoreStaged(staged, log, journal)
    return null
  }
  await hooks.afterMove?.(path)

  const problem = await checkStaged(staged, home, identity)
  if (problem) {
    log(`Refused to stage the separate copy ${path}: ${problem}.`)
    await restoreStaged(staged, log, journal)
    return null
  }
  log(`Staged the separate copy ${path} in ${trash}`)
  return staged
}

/** Why the staged folder is not the checked copy any more, else null. */
async function checkStaged(staged: StagedCopy, home: string, identity: CopyIdentity): Promise<string | null> {
  const real = await checkTrashed(staged.placement, staged.trashed, staged, home)
  if (!real) return "what was moved is not the folder that was checked"
  const inv = await takeInventory(real, DELETE_LIMITS).catch(() => null)
  if (!inv || inv.dev !== identity.dev || inv.ino !== identity.ino) return "what was moved is not the folder that was checked"
  return fullDigest(inv) === identity.full ? null : "its contents are not the ones that were checked"
}

/**
 * Moves a staged copy back to its path with moveBack (never over anything that is there).
 * False when it stays in the trash dir, or when what arrived is not what was moved (logged,
 * and recorded in the journal).
 */
export async function restoreStaged(
  staged: StagedCopy,
  log: JobLog,
  journal?: RemovalJournal,
  hooks: RestoreHooks = {}
): Promise<boolean> {
  const result = await moveBack(staged.trashed, staged.path, hooks)
  if (!result.ok) {
    await note(journal, staged.trashed, result.moved ? "restored" : "staged", result.reason)
    log(
      result.moved
        ? `Moved the separate copy back to ${staged.path}, but ${result.reason}.`
        : `Could not restore the separate copy ${staged.path}: ${result.reason}. It is at ${staged.trashed}.`
    )
    return false
  }
  await note(journal, staged.trashed, "restored")
  log(`Restored the separate copy ${staged.path}`)
  return true
}

export type MoveBack = { ok: true } | { ok: false; reason: string; moved?: boolean }

/**
 * Moves `trashed` back to `original` without ever replacing anything there:
 * 1. mkdir(original), not recursive: EEXIST means something is there, so the copy stays.
 * 2. rename(trashed, original): this can only replace the empty folder made in step 1. If
 *    something was put into it meanwhile (ENOTEMPTY / EEXIST), the copy stays, and that
 *    folder is removed again only while it is still the empty one made in step 1.
 * 3. The folder now at `original` must have the device and inode of what was in the trash dir.
 * The trash dir is removed when it is empty.
 */
export async function moveBack(trashed: string, original: string, hooks: RestoreHooks = {}): Promise<MoveBack> {
  const before = await lstat(trashed).catch(() => null)
  if (!before?.isDirectory()) return { ok: false, reason: `${trashed} is not a folder any more` }
  await hooks.beforeMkdir?.(original)
  try {
    await mkdir(original, { mode: 0o700 })
  } catch (err) {
    return {
      ok: false,
      reason: errno(err) === "EEXIST" ? `something else is at ${original} now` : `could not make ${original} (${(err as Error).message})`,
    }
  }
  const placeholder = await lstat(original).catch(() => null)
  await hooks.afterMkdir?.(original)
  try {
    await rename(trashed, original)
  } catch (err) {
    const now = await lstat(original).catch(() => null)
    if (placeholder && now?.isDirectory() && now.dev === placeholder.dev && now.ino === placeholder.ino)
      await rmdir(original).catch(() => {}) // fails unless it is still empty
    const code = errno(err)
    return {
      ok: false,
      reason:
        code === "ENOTEMPTY" || code === "EEXIST"
          ? `something else appeared at ${original} while it was moved back`
          : `could not move it back (${(err as Error).message})`,
    }
  }
  await rmdir(dirname(trashed)).catch(() => {})
  const after = await lstat(original).catch(() => null)
  if (!after?.isDirectory() || after.dev !== before.dev || after.ino !== before.ino)
    return { ok: false, moved: true, reason: `the folder at ${original} is not the one that was in the trash dir; check it by hand` }
  return { ok: true }
}

/**
 * Deletes a staged copy for good, after checking it is still the staged folder in its trash
 * dir. "kept": the trash dir changed, nothing was deleted. "purge_failed": the delete threw
 * part way; what is left stays in the trash dir and is never moved back (part of it may be
 * gone). Recorded in the journal either way.
 */
export async function purgeStaged(
  staged: StagedCopy,
  home: string,
  log: JobLog,
  journal?: RemovalJournal
): Promise<"deleted" | "kept" | "purge_failed"> {
  const real = await checkTrashed(staged.placement, staged.trashed, staged, home)
  if (!real) {
    await note(journal, staged.trashed, "staged", "its trash dir changed, so it was not deleted")
    log(`Did not delete the separate copy ${staged.path}: its trash dir changed. It is at ${staged.trashed}.`)
    return "kept"
  }
  try {
    await rm(real, { recursive: true })
  } catch (err) {
    const why = (err as Error).message
    await note(journal, staged.trashed, "purge_failed", why)
    log(
      `Could not delete the separate copy ${staged.path} completely (${why}). What is left is at ${staged.trashed}. It was not moved back, because part of it may be gone.`
    )
    return "purge_failed"
  }
  await rmdir(dirname(real)).catch(() => {})
  await note(journal, staged.trashed, "deleted")
  log(`Deleted the separate copy ${staged.path}`)
  return "deleted"
}

/** Records a status in the journal. The error message when the write failed, else null. */
async function note(journal: RemovalJournal | undefined, staged: string, status: JournalStatus, error?: string) {
  if (!journal) return null
  return journal.set(staged, status, error).then(
    () => null,
    (err: Error) => err.message
  )
}

/**
 * Real path of the trashed folder if it is still the folder that was
 * verified (same device and inode, not a symlink) and sits in a trash dir
 * directly inside the verified real skills dir. Else null.
 */
export async function checkTrashed(
  placement: Pick<SkillPlacement, "path" | "root" | "scope">,
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

/** Home itself, a parent of home, or a path too short to be a skill folder. */
export function isUnsafeToDelete(path: string, home: string): boolean {
  const p = resolve(path)
  return p === home || isInside(p, home) || p.split("/").length < 4
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code
}
