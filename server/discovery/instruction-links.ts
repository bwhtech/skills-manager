// Sync via symlink: turn one known instruction file into a symlink to another,
// and back. Callers pass only files the server discovered itself.
//
// Every operation takes the per-path locks (lib/files.ts) of both ends, in
// sorted order, keyed by fileLocation. Saves of instruction files lock the
// same keys, so a link, an unlink and a save of either end never interleave.
// Under the locks each end is probed again with lstat right before the change,
// and the result is checked after it. Disk changes from outside the app are
// handled with no-replace steps (rename to a fresh name, link, symlink), so a
// file that appears meanwhile is never overwritten.
import {
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
  chmod,
} from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { HttpError } from "../lib/errors.ts"
import {
  MAX_TEXT_BYTES,
  contentHash,
  fileLocation,
  isInside,
  realpathOrNull,
  withPathLocks,
} from "../lib/files.ts"

export type EntryKind = "file" | "link" | "missing" | "other"

/** One path as it is on disk now. */
export interface Probe {
  path: string
  /** fileLocation(path): the lock key */
  location: string
  kind: EntryKind
  /** real path: the file itself, or a link's resolved target (null if broken) */
  real: string | null
  /** for a link: what its resolved target is */
  targetKind?: EntryKind
  /** hard link count of a regular file */
  nlink: number
}

export async function probe(path: string): Promise<Probe> {
  const location = await fileLocation(path)
  const info = await lstat(path).catch(() => null)
  if (!info) return { path, location, kind: "missing", real: null, nlink: 0 }
  if (info.isSymbolicLink()) {
    const real = await realpathOrNull(path)
    const target = real ? await stat(real).catch(() => null) : null
    return {
      path,
      location,
      kind: "link",
      real,
      targetKind: !target ? "missing" : target.isFile() ? "file" : "other",
      nlink: info.nlink,
    }
  }
  return {
    path,
    location,
    kind: info.isFile() ? "file" : "other",
    real: await realpathOrNull(path),
    nlink: info.nlink,
  }
}

interface End {
  id: string
  probe: Probe
}

/** Why source cannot become a link to target, or null when it can. */
export function checkLink(source: End, target: End): HttpError | null {
  const s = source.probe
  const t = target.probe
  if (source.id === target.id)
    return new HttpError(400, "self_link", "A file cannot be synced to itself")
  if (t.kind === "link")
    return new HttpError(
      400,
      "target_is_link",
      `${t.path} is itself a symlink. Sync to the real file${t.real ? ` (${t.real})` : ""} instead.`
    )
  if (t.kind === "missing")
    return new HttpError(400, "target_missing", "The target file does not exist")
  if (t.kind === "other")
    return new HttpError(400, "target_not_file", `${t.path} is not a regular file`)
  if (s.kind === "link") {
    const detail =
      s.real === t.real
        ? "Already synced to this file"
        : "Already a symlink. Stop syncing it first."
    return new HttpError(409, "already_linked", detail)
  }
  if (s.kind === "other")
    return new HttpError(400, "source_not_file", `${s.path} is not a regular file`)
  if (t.real === s.location || (s.real && t.real === s.real))
    return new HttpError(
      400,
      "cycle",
      `${t.path} resolves to ${s.path}: the link would point at itself`
    )
  if (s.kind === "file" && s.nlink > 1)
    return new HttpError(
      409,
      "hard_linked",
      `${s.path} has ${s.nlink} hard links. A symlink would replace only this name and split them. Remove the other hard links first.`
    )
  return null
}

/**
 * The backup path the link would use now: <path>.bak, or <path>.bak-<time>
 * (then -2, -3…). Only a preview: the link reserves the name with link(2),
 * which never replaces a file.
 */
export async function backupPathFor(path: string): Promise<string> {
  for (const candidate of backupCandidates(path)) {
    if (!(await lstat(candidate).catch(() => null))) return candidate
  }
  throw new HttpError(500, "internal", "No free backup name")
}

function* backupCandidates(path: string): Generator<string> {
  yield `${path}.bak`
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-")
  yield `${path}.bak-${stamp}`
  for (let n = 2; n < 1000; n++) yield `${path}.bak-${stamp}-${n}`
}

/** Gives `from` a backup name with link(2): EEXIST tries the next name. */
async function linkAsBackup(from: string, path: string): Promise<string> {
  for (const candidate of backupCandidates(path)) {
    try {
      await link(from, candidate)
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
  }
  throw new HttpError(500, "internal", "No free backup name")
}

/** A fresh, unused name next to path. */
function scratchName(path: string, tag: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${crypto.randomUUID().slice(0, 8)}.${tag}`
  )
}

/** Relative when both files are under HOME, else absolute. */
async function linkText(
  sourceLocation: string,
  targetReal: string,
  home: string
): Promise<string> {
  const homes = [home, (await realpathOrNull(home)) ?? home]
  const under = (p: string) => homes.some((h) => isInside(h, p))
  if (under(sourceLocation) && under(targetReal))
    return relative(dirname(sourceLocation), targetReal)
  return targetReal
}

/**
 * Puts the file at `from` back at `path` without ever replacing what is there, and never
 * throws. A regular file or a symlink goes back through link(2) (EEXIST if something
 * appeared). A directory is never moved back. When it cannot, `from` is kept.
 */
export async function putBack(
  from: string,
  path: string
): Promise<{ restored: true } | { restored: false; keptAt: string; why: string }> {
  try {
    const st = await lstat(from)
    // There is no no-replace rename for directories, and an instruction file is never a
    // directory: keep it where it is and say so, rather than risk replacing anything.
    if (st.isDirectory()) return { restored: false, keptAt: from, why: "it is a directory" }
    await link(from, path)
    await unlink(from).catch(() => {})
    return { restored: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { restored: false, keptAt: from, why: code === "EEXIST" ? "a new file appeared there" : (err as Error).message }
  }
}

/*
 * Accepted limit (owner's decision, 2026-11-21): the scratch names used here
 * (.<name>.<random>.moving / .undo / .tmp) are removed by pathname after they
 * were inspected. A same-user process that swaps one of them in the
 * microseconds between the check and the unlink could have its file removed.
 * Bun/Node offer no openat/unlinkat to close this. Every path that touches a
 * user's real file backs it up first, never replaces anything it has not
 * inspected, and reports where a displaced file is kept.
 */

export interface LinkIds {
  sourceId: string
  targetId: string
}

export async function linkFile(
  sourcePath: string,
  targetPath: string,
  ids: LinkIds,
  options: { baseHash?: string; home: string }
): Promise<{ backupPath: string | null }> {
  const ends = async (): Promise<[End, End]> => [
    { id: ids.sourceId, probe: await probe(sourcePath) },
    { id: ids.targetId, probe: await probe(targetPath) },
  ]
  const early = checkLink(...(await ends()))
  if (early) throw early
  await mkdir(dirname(sourcePath), { recursive: true })
  const keys = [await fileLocation(sourcePath), await fileLocation(targetPath)]

  return withPathLocks(keys, async () => {
    // Again under the locks, right before the change.
    const [source, target] = await ends()
    const problem = checkLink(source, target)
    if (problem) throw problem
    const targetReal = target.probe.real!
    const text = await linkText(source.probe.location, targetReal, options.home)

    if (source.probe.kind === "missing") {
      // symlink(2) never replaces: EEXIST if a file appeared meanwhile.
      try {
        await symlink(text, sourcePath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST")
          throw new HttpError(409, "exists", `A file appeared at ${sourcePath}. Nothing was changed.`)
        throw err
      }
      await verifyLink(sourcePath, text, targetPath, targetReal, null)
      return { backupPath: null }
    }

    if (typeof options.baseHash !== "string")
      throw new HttpError(400, "bad_request", "baseHash is required when the file exists")

    // 1. Move the live file out of the way: rename is atomic and keeps the
    //    bytes that are there at this moment, whatever was read before.
    //    From here on the user's file lives under a temporary name, so every
    //    failure path either puts it back without replacing anything, or says
    //    exactly where it is. Nothing deletes the only remaining name.
    const moving = scratchName(sourcePath, "moving")
    await rename(sourcePath, moving)
    let backupPath: string | null = null
    /** The name that surely holds the user's file right now. */
    const held = () => backupPath ?? moving

    const giveBack = async (reason: string, code: string, status: 409 | 500, extra: Record<string, unknown> = {}) => {
      const back = await putBack(held(), sourcePath)
      if (back.restored && backupPath) await unlink(moving).catch(() => {})
      throw new HttpError(
        status,
        code,
        back.restored
          ? reason
          : `${reason} Your file could not be put back at ${sourcePath} (${back.why}); it is kept at ${back.keptAt}.`,
        { ...extra, ...(back.restored ? {} : { keptAt: back.keptAt }) }
      )
    }

    const moved = await lstat(moving).catch(() => null)
    if (!moved?.isFile())
      return giveBack(`${sourcePath} changed on disk. Nothing was changed.`, "source_not_file", 409)

    // 2. Give it a backup name without replacing an existing backup.
    try {
      backupPath = await linkAsBackup(moving, sourcePath)
    } catch (err) {
      return giveBack(`Could not make a backup of ${sourcePath} (${(err as Error).message}). Nothing was changed.`, "backup_failed", 500)
    }
    // Both names are the same file now; the scratch one is only a leftover.
    const leftover = await unlink(moving).then(
      () => null,
      () => moving
    )

    // 3. The backup is what the user would lose: it must be what they saw.
    let bytes: Buffer
    try {
      bytes = await readFile(backupPath)
    } catch (err) {
      return giveBack(`Could not read ${sourcePath} to check it (${(err as Error).message}). Nothing was changed.`, "unreadable", 500)
    }
    const currentHash = contentHash(bytes)
    if (currentHash !== options.baseHash)
      return giveBack("The file changed on disk.", "conflict", 409, { currentHash, currentMtimeMs: moved.mtimeMs })

    // 4. The link goes to the now free name; symlink(2) never replaces.
    try {
      await symlink(text, sourcePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST")
        throw new HttpError(
          409,
          "exists",
          `A new file appeared at ${sourcePath} during the sync. It was kept, and your file is at ${backupPath}.`,
          { backupPath }
        )
      return giveBack(`Could not create the link (${(err as Error).message}). Nothing was changed.`, "link_failed", 500)
    }
    if (leftover) console.warn(`instruction sync: could not remove the scratch name ${leftover} (same file as ${backupPath})`)
    await verifyLink(sourcePath, text, targetPath, targetReal, backupPath)
    return { backupPath }
  })
}

/**
 * After the change: the link must resolve to the target, and the target must
 * still be a regular file. Else undo: remove our link (only if it is still
 * ours) and put the backup back.
 */
async function verifyLink(
  path: string,
  text: string,
  targetPath: string,
  targetReal: string,
  backupPath: string | null
): Promise<void> {
  const target = await lstat(targetPath).catch(() => null)
  const ok =
    !!target?.isFile() &&
    (await realpathOrNull(path)) === targetReal &&
    (await realpathOrNull(targetPath)) === targetReal
  if (ok) return
  // Take whatever is at path aside first, then look at it: only our own link is deleted.
  // Anything else that appeared there is put back (no-replace) or kept and reported.
  const aside = scratchName(path, "undo")
  let stray: string | null = null
  if (await rename(path, aside).then(() => true, () => false)) {
    const entry = await lstat(aside).catch(() => null)
    const ours = entry?.isSymbolicLink() && (await readlink(aside).catch(() => null)) === text
    if (ours) await unlink(aside).catch(() => {})
    else {
      const back = await putBack(aside, path)
      if (!back.restored) stray = back.keptAt
    }
  }
  const restored = backupPath ? (await putBack(backupPath, path)).restored : true
  const notes = [
    restored ? null : `Your file is kept at ${backupPath}.`,
    stray ? `Something that appeared at ${path} during the sync is kept at ${stray}.` : null,
  ].filter(Boolean)
  throw new HttpError(
    409,
    "target_changed",
    `${targetPath} changed during the sync. ${notes.length ? notes.join(" ") : "Nothing was changed."}`,
    { ...(restored ? {} : { backupPath }), ...(stray ? { keptAt: stray } : {}) }
  )
}

/**
 * Replaces the symlink at path with a regular file: the target's content now
 * ("copy") or empty. The target is never opened for writing.
 */
export async function unlinkFile(path: string, mode: "copy" | "empty"): Promise<void> {
  const before = await probe(path)
  if (before.kind !== "link")
    throw new HttpError(400, "not_a_link", `${path} is not a symlink`)
  const keys = [before.location]
  if (before.real) keys.push(await fileLocation(before.real))

  await withPathLocks(keys, async () => {
    const now = await probe(path)
    if (now.kind !== "link")
      throw new HttpError(400, "not_a_link", `${path} is not a symlink`)
    if (now.real !== before.real)
      throw new HttpError(409, "conflict", `${path} changed on disk. Try again.`)
    let bytes: Uint8Array = new Uint8Array()
    let fileMode = 0o644
    if (mode === "copy") {
      if (!now.real || now.targetKind === "missing")
        throw new HttpError(409, "link_broken", "The link target does not exist, so there is nothing to copy")
      if (now.targetKind !== "file")
        throw new HttpError(400, "target_not_file", `${now.real} is not a regular file`)
      const info = await stat(now.real)
      if (info.size > MAX_TEXT_BYTES)
        throw new HttpError(413, "too_large", "File is larger than 1 MB")
      bytes = await readFile(now.real)
      fileMode = info.mode & 0o777
    }
    const temp = scratchName(path, "tmp")
    const moving = scratchName(path, "moving")
    // Cleanup removes the temp name only if this call created it ("wx" fails on EEXIST).
    let created = false
    try {
      await writeFile(temp, bytes, { flag: "wx", mode: fileMode })
      created = true
      await chmod(temp, fileMode)
      // Take the link away (atomic), check it is the link we probed, then
      // put the new file at the free name with link(2), which never replaces.
      await rename(path, moving)
      // Whatever now sits at the scratch name goes back (no-replace) or is reported on
      // every path below, including when it cannot even be inspected.
      const moved = await lstat(moving).catch(() => null)
      if (!moved?.isSymbolicLink()) {
        const back = await putBack(moving, path)
        throw new HttpError(
          409,
          "conflict",
          back.restored
            ? `${path} changed on disk. Nothing was changed.`
            : `${path} changed on disk, and it could not be put back (${back.why}); it is kept at ${back.keptAt}.`,
          back.restored ? undefined : { keptAt: back.keptAt }
        )
      }
      try {
        await link(temp, path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          // The old link is only a pointer: nothing is lost by dropping it.
          await unlink(moving).catch(() => {})
          throw new HttpError(409, "exists", `A new file appeared at ${path}. It was kept.`)
        }
        // Put the old link back without replacing anything; it is only a pointer either way.
        const back = await putBack(moving, path)
        throw new HttpError(
          500,
          "unlink_failed",
          back.restored
            ? `Could not create the file (${(err as Error).message}). Nothing was changed.`
            : `Could not create the file (${(err as Error).message}), and the old link could not be put back (${back.why}); it is at ${back.keptAt}.`,
          back.restored ? undefined : { keptAt: back.keptAt }
        )
      }
      // The old link (checked above) is only a pointer; a leftover scratch name loses nothing.
      await unlink(moving).catch(() => {})
    } finally {
      if (created) await unlink(temp).catch(() => {})
    }
  })
}
