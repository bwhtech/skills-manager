import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import type { UpdateFileChange, UpdatePreview } from "../../shared/api.ts"
import { HttpError } from "../lib/errors.ts"
import { isInside } from "../lib/files.ts"
import { countLineChanges } from "./line-diff.ts"

export const MAX_DIFF_BYTES = 256 * 1024
const BINARY_SNIFF_BYTES = 8 * 1024
const MAX_FILES = 5000
/** Never part of a preview, on either side. */
const ALWAYS_SKIP_DIRS = new Set([".git", "node_modules"])
/** What the skills CLI leaves out when it copies a skill (isExcluded in 1.9.0). */
const CLI_EXCLUDED_FILES = new Set(["metadata.json"])
const CLI_EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"])

export interface WalkOptions {
  /** apply the CLI's copy exclusions (the upstream side) */
  cliExclusions?: boolean
}

/** Relative posix path -> absolute path to read, for every file in a folder. */
export type FileMap = Map<string, string>

export type DiffResult = Pick<UpdatePreview, "files" | "summary" | "upToDate">

/**
 * Compares the local skill folder (old) with the upstream one (new).
 * `newOverrides` replaces upstream file bytes, e.g. a SKILL.md the CLI renames.
 */
export async function diffFolders(
  oldRoot: string,
  newRoot: string,
  newOverrides: Map<string, Uint8Array> = new Map()
): Promise<DiffResult> {
  const [before, after] = await Promise.all([
    collectFiles(oldRoot),
    collectFiles(newRoot, { cliExclusions: true }),
  ])
  const paths = [...new Set([...before.keys(), ...after.keys()])]
  const changes = await Promise.all(
    paths.map(async (path) => {
      const oldPath = before.get(path)
      const newPath = after.get(path)
      const [oldBytes, newBytes] = await Promise.all([
        oldPath ? readFile(oldPath) : null,
        newOverrides.get(path) ?? (newPath ? readFile(newPath) : null),
      ])
      return compareFile(path, oldBytes, newBytes)
    })
  )
  const files = changes
    .filter((c): c is UpdateFileChange => c !== null)
    .sort(byPreviewOrder)
  return { files, summary: summarize(files), upToDate: files.length === 0 }
}

/** One file's change, or null when the bytes are equal. */
export function compareFile(
  path: string,
  oldBytes: Uint8Array | null,
  newBytes: Uint8Array | null
): UpdateFileChange | null {
  if (oldBytes && newBytes && Buffer.from(oldBytes).equals(newBytes))
    return null
  if (!oldBytes && !newBytes) return null
  const status = !oldBytes ? "added" : !newBytes ? "removed" : "modified"
  const binary = isBinary(oldBytes) || isBinary(newBytes)
  const change: UpdateFileChange = {
    path,
    status,
    binary,
    linesAdded: 0,
    linesRemoved: 0,
  }
  if (binary) return change
  const oldText = oldBytes ? decode(oldBytes) : ""
  const newText = newBytes ? decode(newBytes) : ""
  const tooLarge =
    (oldBytes?.length ?? 0) > MAX_DIFF_BYTES ||
    (newBytes?.length ?? 0) > MAX_DIFF_BYTES
  Object.assign(change, countLineChanges(oldText, newText))
  if (tooLarge) change.tooLarge = true
  else {
    if (oldBytes) change.oldContent = oldText
    if (newBytes) change.newContent = newText
  }
  return change
}

/**
 * Every regular file under root. Symlinks are followed only when their target
 * stays inside the folder (as the CLI does when it copies); others are skipped.
 */
export async function collectFiles(
  root: string,
  options: WalkOptions = {}
): Promise<FileMap> {
  const realRoot = await realpath(root)
  const files: FileMap = new Map()
  await walk(realRoot, "", realRoot, new Set(), files, options)
  return files
}

async function walk(
  dir: string,
  prefix: string,
  realRoot: string,
  ancestors: Set<string>,
  files: FileMap,
  options: WalkOptions
): Promise<void> {
  const realDir = await realpath(dir)
  if (ancestors.has(realDir)) return
  const branch = new Set(ancestors).add(realDir)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const target = await resolveEntry(full, realRoot)
    if (!target) continue
    if (isSkipped(entry.name, target.isDir, options)) continue
    if (target.isDir) {
      await walk(full, rel, realRoot, branch, files, options)
      continue
    }
    if (files.size >= MAX_FILES)
      throw new HttpError(422, "too_many_files", `More than ${MAX_FILES} files`)
    files.set(rel, target.path)
  }
}

/** A dir or regular file to visit, or null (broken, outside, or special). */
async function resolveEntry(
  path: string,
  realRoot: string
): Promise<{ path: string; isDir: boolean } | null> {
  const info = await lstat(path)
  if (!info.isSymbolicLink()) {
    if (info.isDirectory()) return { path, isDir: true }
    return info.isFile() ? { path, isDir: false } : null
  }
  const real = await realpath(path).catch(() => null)
  if (!real || !isInside(realRoot, real)) return null
  const target = await stat(real)
  if (target.isDirectory()) return { path: real, isDir: true }
  return target.isFile() ? { path: real, isDir: false } : null
}

function isSkipped(
  name: string,
  isDir: boolean,
  options: WalkOptions
): boolean {
  if (isDir && ALWAYS_SKIP_DIRS.has(name)) return true
  if (!options.cliExclusions) return false
  return isDir ? CLI_EXCLUDED_DIRS.has(name) : CLI_EXCLUDED_FILES.has(name)
}

function summarize(files: UpdateFileChange[]): UpdatePreview["summary"] {
  const summary = {
    added: 0,
    removed: 0,
    modified: 0,
    linesAdded: 0,
    linesRemoved: 0,
  }
  for (const f of files) {
    summary[f.status]++
    summary.linesAdded += f.linesAdded
    summary.linesRemoved += f.linesRemoved
  }
  return summary
}

/** SKILL.md at the top of the folder first, then by path (code point order). */
function byPreviewOrder(a: UpdateFileChange, b: UpdateFileChange): number {
  const rank = (f: UpdateFileChange) => (f.path === "SKILL.md" ? 0 : 1)
  return rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

function isBinary(bytes: Uint8Array | null): boolean {
  return !!bytes && bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
