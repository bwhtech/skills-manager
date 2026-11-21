import {
  lstat,
  readFile,
  readlink,
  realpath,
  rename,
  stat,
  writeFile,
  unlink,
  chmod,
  open,
} from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type {
  FileContent,
  SaveRequest,
  SaveResponse,
} from "../../shared/api.ts"
import { HttpError, badRequest } from "./errors.ts"

export const MAX_TEXT_BYTES = 1024 * 1024

/** sha256 hex of file bytes or of a string's UTF-8 bytes. */
export function contentHash(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex")
}

export async function readTextFile(path: string): Promise<FileContent> {
  const info = await stat(path)
  if (info.size > MAX_TEXT_BYTES)
    throw new HttpError(413, "too_large", "File is larger than 1 MB")
  const bytes = await readFile(path)
  return {
    content: bytes.toString("utf8"),
    mtimeMs: info.mtimeMs,
    hash: contentHash(bytes),
  }
}

/**
 * The path a save really writes, so that every alias of one file (a symlink
 * to it, or a path through a symlinked parent dir) maps to one lock key:
 * the real path of the file, or of its parent dir plus the basename when the
 * file is missing.
 */
export async function canonicalPath(path: string): Promise<string> {
  const real = await realpathOrNull(path)
  if (real) return real
  return join(await realpath(dirname(path)), basename(path))
}

/**
 * Save with an optimistic lock on the content hash. The hash check and the
 * write run under a per-file lock keyed by the canonical path, so two saves
 * with the same baseHash cannot both pass, even through different aliases.
 * Writes atomically: a temp file next to the real file, then rename.
 */
export interface SaveOptions {
  /** lock (and write) this path instead of canonicalPath(target) */
  lockKey?: string
  /**
   * `target` is a real path the caller validated: lock and write exactly it, with no second
   * realpath (which could resolve elsewhere than the checked path if a parent dir became a
   * symlink in between). The guard should check that path again; after the rename the save
   * checks that the written path still resolves to itself and logs loudly if not.
   */
  resolved?: boolean
  /** runs under the lock before the hash check; throw to refuse the save */
  guard?: () => Promise<void>
}

export async function saveTextFile(
  target: string,
  req: SaveRequest,
  options: SaveOptions = {}
): Promise<SaveResponse> {
  if (typeof req.content !== "string")
    throw badRequest("content must be a string")
  if (Buffer.byteLength(req.content) > MAX_TEXT_BYTES)
    throw new HttpError(413, "too_large", "Content is larger than 1 MB")
  if (!req.force && typeof req.baseHash !== "string")
    throw badRequest("baseHash is required unless force is set")
  const content = req.content
  const real = options.lockKey ?? (options.resolved ? target : await canonicalPath(target))
  return withPathLock(real, async () => {
    await options.guard?.()
    const current = await stat(real)
    if (!req.force) {
      const currentHash = contentHash(await readFile(real))
      if (currentHash !== req.baseHash) {
        throw new HttpError(409, "conflict", "The file changed on disk", {
          currentHash,
          currentMtimeMs: current.mtimeMs,
        })
      }
    }
    const mtimeMs = await atomicWrite(real, content, current.mode & 0o7777)
    if (options.resolved) await checkStillResolved(real)
    return { mtimeMs, hash: contentHash(content) }
  })
}

/**
 * After a save to a validated real path: the path must still resolve to itself. If not, a
 * parent dir was swapped for a symlink during the save, and the bytes may have landed
 * somewhere else. Bun has no openat (no dir-handle-relative writes), so this same-user race
 * stays open; it is the same accepted limit as instruction sync. Log it loudly.
 */
async function checkStillResolved(path: string): Promise<void> {
  const now = await realpathOrNull(path)
  if (now === path) return
  console.error(
    `SECURITY: a save to ${path} may have been redirected: the path now resolves to ${now ?? "nothing"}`
  )
  throw new HttpError(500, "redirected", `The save may have been redirected: ${path} now resolves to ${now ?? "nothing"}`)
}

const pathLocks = new Map<string, Promise<unknown>>()

/** Runs fn after every earlier fn for the same path has settled. */
export async function withPathLock<T>(
  path: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  pathLocks.set(path, tail)
  try {
    return await run
  } finally {
    if (pathLocks.get(path) === tail) pathLocks.delete(path)
  }
}

/** Runs fn holding the lock of every path, taken in sorted order (no deadlock). */
export async function withPathLocks<T>(
  paths: string[],
  fn: () => Promise<T>
): Promise<T> {
  const keys = [...new Set(paths)].sort()
  const run = (i: number): Promise<T> =>
    i === keys.length ? fn() : withPathLock(keys[i], () => run(i + 1))
  return run(0)
}

/**
 * Where a path's own directory entry lives: the real parent dir plus the
 * name. Unlike realpath, it does not follow the entry itself, so it stays the
 * same lock key when a regular file becomes a symlink. For a regular file it
 * equals canonicalPath.
 */
export async function fileLocation(path: string): Promise<string> {
  const dir = (await realpathOrNull(dirname(path))) ?? dirname(path)
  return join(dir, basename(path))
}

/**
 * Writes via a temp file and rename. `durable` also fsyncs the temp file before the rename
 * and the parent directory after it, so the new content survives power loss, not only a
 * crash of this process (used for the removal journal, which must be on disk before a delete).
 */
export async function atomicWrite(
  target: string,
  content: string,
  mode = 0o644,
  options: { durable?: boolean } = {}
): Promise<number> {
  const temp = join(
    dirname(target),
    `.${basename(target)}.${crypto.randomUUID().slice(0, 8)}.tmp`
  )
  try {
    await writeFile(temp, content, { flag: "wx", mode })
    await chmod(temp, mode)
    if (options.durable) await fsyncPath(temp)
    await rename(temp, target)
    if (options.durable) await fsyncPath(dirname(target))
  } catch (err) {
    await unlink(temp).catch(() => {})
    throw err
  }
  return (await stat(target)).mtimeMs
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export interface LinkInfo {
  isLink: boolean
  /** where reads and writes go: the resolved target for links, else the path */
  target: string
  exists: boolean
}

/** Resolve a path that may be a symlink (also a dangling one). */
export async function resolveLink(path: string): Promise<LinkInfo> {
  const info = await lstat(path).catch(() => null)
  if (!info) return { isLink: false, target: path, exists: false }
  if (!info.isSymbolicLink())
    return { isLink: false, target: path, exists: true }
  const real = await realpath(path).catch(() => null)
  if (real) return { isLink: true, target: real, exists: true }
  const link = await readlink(path)
  return { isLink: true, target: resolve(dirname(path), link), exists: false }
}

export async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false
}

export async function pathExists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null
}

export async function realpathOrNull(path: string): Promise<string | null> {
  return realpath(path).catch(() => null)
}

export function isInside(parent: string, child: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith("/") ? parent : parent + "/")
  )
}
