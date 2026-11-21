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
} from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type { FileContent, SaveRequest } from "../../shared/api.ts"
import { HttpError, badRequest } from "./errors.ts"

export const MAX_TEXT_BYTES = 1024 * 1024
// Float mtimes can lose precision on the round trip through JSON.
const MTIME_TOLERANCE_MS = 1

export async function readTextFile(path: string): Promise<FileContent> {
  const info = await stat(path)
  if (info.size > MAX_TEXT_BYTES)
    throw new HttpError(413, "too_large", "File is larger than 1 MB")
  const content = await readFile(path, "utf8")
  return { content, mtimeMs: info.mtimeMs }
}

/**
 * Save with an optimistic lock on mtime. Writes atomically: a temp file in
 * the same directory, then rename. Pass the real target, not a symlink.
 */
export async function saveTextFile(
  target: string,
  req: SaveRequest
): Promise<number> {
  if (typeof req.content !== "string")
    throw badRequest("content must be a string")
  if (Buffer.byteLength(req.content) > MAX_TEXT_BYTES)
    throw new HttpError(413, "too_large", "Content is larger than 1 MB")
  const current = await stat(target)
  if (!req.force) {
    if (typeof req.baseMtimeMs !== "number")
      throw badRequest("baseMtimeMs is required unless force is set")
    if (Math.abs(current.mtimeMs - req.baseMtimeMs) > MTIME_TOLERANCE_MS) {
      throw new HttpError(409, "conflict", "The file changed on disk", {
        currentMtimeMs: current.mtimeMs,
      })
    }
  }
  return atomicWrite(target, req.content, current.mode & 0o7777)
}

export async function atomicWrite(
  target: string,
  content: string,
  mode = 0o644
): Promise<number> {
  const temp = join(
    dirname(target),
    `.${basename(target)}.${crypto.randomUUID().slice(0, 8)}.tmp`
  )
  try {
    await writeFile(temp, content, { flag: "wx", mode })
    await chmod(temp, mode)
    await rename(temp, target)
  } catch (err) {
    await unlink(temp).catch(() => {})
    throw err
  }
  return (await stat(target)).mtimeMs
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
