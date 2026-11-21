import { constants, type Dirent } from "node:fs"
import { lstat, open, readdir, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { HttpError } from "../lib/errors.ts"

/** Bounds on what one update preview reads, fetches and returns. */
export const PREVIEW_LIMITS = {
  /** files over this are compared by hash only; no contents, no line counts */
  maxDiffBytes: 256 * 1024,
  /** files in the local or the upstream skill folder */
  maxFilesPerSide: 2000,
  /** bytes read from disk for one diff, both sides together */
  maxReadBytes: 50 * 1024 * 1024,
  readConcurrency: 16,
  /** disk used by one fetched source (clone or download) */
  maxSourceBytes: 300 * 1024 * 1024,
  /** SKILL.md files a source may have when the skill must be found by name */
  maxSkillMds: 5000,
} as const

export function previewTooLarge(detail: string): HttpError {
  return new HttpError(413, "preview_too_large", `Preview too large: ${detail}`)
}

/** Counts bytes read; throws 413 past the limit. */
export class ReadBudget {
  private used = 0

  constructor(private readonly max: number) {}

  take(bytes: number): void {
    this.used += bytes
    if (this.used > this.max)
      throw previewTooLarge(
        `the diff would read more than ${formatMb(this.max)} from disk`
      )
  }
}

/**
 * Opens a regular file without following a link in its last component and
 * without blocking on a FIFO. Throws when the path is not a regular file.
 */
export async function openRegularFile(path: string): Promise<FileHandle> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    if ((await handle.stat()).isFile()) return handle
  } catch (err) {
    await handle.close()
    throw err
  }
  await handle.close()
  throw new HttpError(409, "not_a_file", "A file changed while it was read")
}

/**
 * Reads at most `max` bytes. `truncated` is true when the file is longer.
 * The budget, if any, is charged for every byte read.
 */
export async function readPrefix(
  handle: FileHandle,
  max: number,
  budget?: ReadBudget
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const buffer = Buffer.alloc(max + 1)
  let length = 0
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      buffer.length - length,
      length
    )
    if (bytesRead === 0) break
    budget?.take(bytesRead)
    length += bytesRead
  }
  const truncated = length > max
  return { bytes: buffer.subarray(0, Math.min(length, max)), truncated }
}

/**
 * Bytes used under `dir` (apparent sizes, links not followed). Stops counting
 * once the total passes `limit`, so a huge tree costs no more than needed.
 */
export async function dirSize(dir: string, limit: number): Promise<number> {
  let total = 0
  const stack = [dir]
  while (stack.length > 0 && total <= limit) {
    const current = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue // deleted meanwhile (git renames temp files)
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      total += await lstat(full).then(
        (s) => s.size,
        () => 0
      )
      if (total > limit) break
    }
  }
  return total
}

/** Runs fn over items with at most `limit` calls in flight; keeps order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index])
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

export function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}
