// Sync via symlink: turn one known instruction file into a symlink to another,
// and back. Callers pass only files the server discovered itself.
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { HttpError } from "../lib/errors.ts"
import {
  MAX_TEXT_BYTES,
  contentHash,
  isInside,
  realpathOrNull,
  withPathLock,
} from "../lib/files.ts"

/** One side of a link, as it is on disk now. */
export interface LinkEnd {
  id: string
  path: string
  isLink: boolean
  /** for a link: its target exists */
  exists: boolean
  /** real path when it exists */
  real: string | null
}

/** Why source cannot become a link to target, or null when it can. */
export function checkLink(source: LinkEnd, target: LinkEnd): HttpError | null {
  if (source.id === target.id)
    return new HttpError(400, "self_link", "A file cannot be synced to itself")
  if (target.isLink)
    return new HttpError(
      400,
      "target_is_link",
      `${target.path} is itself a symlink. Sync to the real file${target.real ? ` (${target.real})` : ""} instead.`
    )
  if (!target.exists || !target.real)
    return new HttpError(400, "target_missing", "The target file does not exist")
  if (source.isLink) {
    const detail =
      source.real === target.real
        ? "Already synced to this file"
        : "Already a symlink. Stop syncing it first."
    return new HttpError(409, "already_linked", detail)
  }
  if (source.real && source.real === target.real)
    return new HttpError(
      400,
      "cycle",
      `${target.path} resolves to ${source.path}: the link would point at itself`
    )
  return null
}

/**
 * The backup path for a file: <path>.bak, or <path>.bak-<time> (then -2, -3…)
 * when that exists. Only a suggestion: writeBackup never overwrites.
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

/** Writes the backup with O_EXCL, so an existing backup is never replaced. */
async function writeBackup(
  path: string,
  bytes: Uint8Array,
  mode: number
): Promise<string> {
  for (const candidate of backupCandidates(path)) {
    try {
      await writeFile(candidate, bytes, { flag: "wx", mode })
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
  }
  throw new HttpError(500, "internal", "No free backup name")
}

/** Where the file itself lives: its real parent dir plus its name. */
async function location(path: string): Promise<string> {
  const dir = (await realpathOrNull(dirname(path))) ?? dirname(path)
  return join(dir, basename(path))
}

/** Relative when both files are under HOME, else absolute. */
async function linkText(
  sourceLocation: string,
  target: LinkEnd,
  home: string
): Promise<string> {
  const homes = [home, (await realpathOrNull(home)) ?? home]
  const under = (p: string) => homes.some((h) => isInside(h, p))
  const real = target.real!
  if (under(sourceLocation) && under(real))
    return relative(dirname(sourceLocation), real)
  return real
}

export async function linkFile(
  source: LinkEnd,
  target: LinkEnd,
  options: { baseHash?: string; home: string }
): Promise<{ backupPath: string | null }> {
  const problem = checkLink(source, target)
  if (problem) throw problem
  const dir = dirname(source.path)
  await mkdir(dir, { recursive: true })
  const sourceLocation = await location(source.path)
  // The same key a save of the regular source file locks (its real path).
  return withPathLock(sourceLocation, async () => {
    // Check again under the lock: the disk may have changed since the preview.
    const info = await lstat(source.path).catch(() => null)
    if (info?.isSymbolicLink())
      throw new HttpError(
        409,
        "already_linked",
        "Already a symlink. Stop syncing it first."
      )
    if (info && !info.isFile())
      throw new HttpError(400, "bad_request", `${source.path} is not a file`)
    const text = await linkText(sourceLocation, target, options.home)

    if (!info) {
      // Missing source: create the link in place; EEXIST if a file appeared.
      try {
        await symlink(text, source.path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST")
          throw new HttpError(409, "exists", "The file appeared on disk")
        throw err
      }
      await verifyLink(source.path, target, () => unlink(source.path))
      return { backupPath: null }
    }

    if (typeof options.baseHash !== "string")
      throw new HttpError(
        400,
        "bad_request",
        "baseHash is required when the file exists"
      )
    const bytes = await readFile(source.path)
    const currentHash = contentHash(bytes)
    if (currentHash !== options.baseHash)
      throw new HttpError(409, "conflict", "The file changed on disk", {
        currentHash,
        currentMtimeMs: info.mtimeMs,
      })
    const backupPath = await writeBackup(source.path, bytes, info.mode & 0o777)
    const temp = join(
      dir,
      `.${basename(source.path)}.${crypto.randomUUID().slice(0, 8)}.link`
    )
    try {
      await symlink(text, temp)
      await verifyLink(temp, target, async () => {})
      await rename(temp, source.path)
    } catch (err) {
      await unlink(temp).catch(() => {})
      throw err
    }
    return { backupPath }
  })
}

/** The new link must resolve to the target's real path. */
async function verifyLink(
  path: string,
  target: LinkEnd,
  undo: () => Promise<void>
): Promise<void> {
  if ((await realpathOrNull(path)) === target.real) return
  await undo().catch(() => {})
  throw new HttpError(
    500,
    "internal",
    `The link at ${path} does not resolve to ${target.real}`
  )
}

/**
 * Replaces the symlink at path with a regular file: the target's content now
 * ("copy") or empty. Temp file in the same dir, then rename over the link, so
 * the target itself is never opened for writing.
 */
export async function unlinkFile(
  path: string,
  mode: "copy" | "empty"
): Promise<void> {
  const key = await location(path)
  await withPathLock(key, async () => {
    const info = await lstat(path).catch(() => null)
    if (!info?.isSymbolicLink())
      throw new HttpError(400, "not_a_link", `${path} is not a symlink`)
    let bytes: Uint8Array = new Uint8Array()
    let fileMode = 0o644
    if (mode === "copy") {
      const real = await realpath(path).catch(() => null)
      if (!real)
        throw new HttpError(
          409,
          "link_broken",
          "The link target does not exist, so there is nothing to copy"
        )
      const targetInfo = await stat(real)
      if (!targetInfo.isFile())
        throw new HttpError(400, "bad_request", `${real} is not a file`)
      if (targetInfo.size > MAX_TEXT_BYTES)
        throw new HttpError(413, "too_large", "File is larger than 1 MB")
      bytes = await readFile(real)
      fileMode = targetInfo.mode & 0o777
    }
    const temp = join(
      dirname(path),
      `.${basename(path)}.${crypto.randomUUID().slice(0, 8)}.tmp`
    )
    try {
      await writeFile(temp, bytes, { flag: "wx", mode: fileMode })
      await chmod(temp, fileMode)
      await rename(temp, path)
    } catch (err) {
      await unlink(temp).catch(() => {})
      throw err
    }
  })
}
