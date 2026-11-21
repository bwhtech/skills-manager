import { createHash } from "node:crypto"
import { lstat, readdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import type { UpdateFileChange, UpdatePreview } from "../../shared/api.ts"
import { isInside } from "../lib/files.ts"
import {
  PREVIEW_LIMITS,
  ReadBudget,
  formatMb,
  mapLimit,
  openRegularFile,
  previewTooLarge,
  readPrefix,
} from "./limits.ts"
import { countLineChanges } from "./line-diff.ts"

export const MAX_DIFF_BYTES = PREVIEW_LIMITS.maxDiffBytes
const BINARY_SNIFF_BYTES = 8 * 1024
const HASH_CHUNK_BYTES = 64 * 1024

/**
 * isExcluded in skills 1.9.0 (copyDirectory): `metadata.json` whatever its
 * type, and these directories. The CLI leaves them out when it copies a skill.
 */
const CLI_EXCLUDED_NAMES = new Set(["metadata.json"])
const CLI_EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"])
/** On the local side only `.git` is left out: update deletes everything else. */
const LOCAL_EXCLUDED_DIRS = new Set([".git"])

export interface DiffLimits {
  maxFilesPerSide: number
  maxReadBytes: number
  readConcurrency: number
}

const DEFAULT_LIMITS: DiffLimits = PREVIEW_LIMITS

export interface WalkOptions {
  /** apply the CLI's copy exclusions (the upstream side) */
  cliExclusions?: boolean
  maxFiles?: number
  /** names the side in errors */
  label?: string
}

/** A regular file found by the walk. */
export interface FileEntry {
  /** absolute path to read; its last component is not a link */
  path: string
  size: number
}

/** Relative posix path -> file, for every file in a folder. */
export type FileMap = Map<string, FileEntry>

export type DiffResult = Pick<UpdatePreview, "files" | "summary" | "upToDate">

/** One side of one path: a file on disk or bytes given by the caller. */
type Side = { file: FileEntry } | { bytes: Uint8Array }

/**
 * Compares the local skill folder (old) with the upstream one (new).
 * `newOverrides` replaces upstream file bytes, e.g. a SKILL.md the CLI renames.
 * Fails with 413 instead of truncating when a limit is passed.
 */
export async function diffFolders(
  oldRoot: string,
  newRoot: string,
  newOverrides: Map<string, Uint8Array> = new Map(),
  limits: DiffLimits = DEFAULT_LIMITS
): Promise<DiffResult> {
  const maxFiles = limits.maxFilesPerSide
  const [before, after] = await Promise.all([
    collectFiles(oldRoot, { maxFiles, label: "local" }),
    collectFiles(newRoot, { cliExclusions: true, maxFiles, label: "upstream" }),
  ])
  return diffFileMaps(before, after, newOverrides, limits)
}

/**
 * Compares two local folders, e.g. a skill's canonical folder with a same-named copy. Both
 * sides are walked the same way (only `.git` is left out), with the preview's limits: a
 * limit passed is a 413, never a partial result. `fileCount` is the number of files in `b`.
 */
export async function diffLocalFolders(
  a: string,
  b: string,
  limits: DiffLimits = DEFAULT_LIMITS
): Promise<DiffResult & { fileCount: number }> {
  const maxFiles = limits.maxFilesPerSide
  const [before, after] = await Promise.all([
    collectFiles(a, { maxFiles, label: "canonical" }),
    collectFiles(b, { maxFiles, label: "copy" }),
  ])
  return { ...(await diffFileMaps(before, after, new Map(), limits)), fileCount: after.size }
}

async function diffFileMaps(
  before: FileMap,
  after: FileMap,
  newOverrides: Map<string, Uint8Array>,
  limits: DiffLimits
): Promise<DiffResult> {
  const pairs = [...new Set([...before.keys(), ...after.keys()])].map(
    (path) => {
      const old = before.get(path)
      const override = newOverrides.get(path)
      const upstream = after.get(path)
      const next: Side | null = override
        ? { bytes: override }
        : upstream
          ? { file: upstream }
          : null
      return { path, old: old ? { file: old } : null, next }
    }
  )
  const planned = pairs.reduce((sum, p) => sum + plannedRead(p.old, p.next), 0)
  if (planned > limits.maxReadBytes)
    throw previewTooLarge(
      `the skill folders hold more than ${formatMb(limits.maxReadBytes)} to compare`
    )
  const budget = new ReadBudget(limits.maxReadBytes)
  const changes = await mapLimit(pairs, limits.readConcurrency, (p) =>
    compareSides(p.path, p.old, p.next, budget)
  )
  const files = changes
    .filter((c): c is UpdateFileChange => c !== null)
    .sort(byPreviewOrder)
  return { files, summary: summarize(files), upToDate: files.length === 0 }
}

/** One file's change, or null when the bytes are equal. Both sides in memory. */
export function compareFile(
  path: string,
  oldBytes: Uint8Array | null,
  newBytes: Uint8Array | null
): UpdateFileChange | null {
  if (oldBytes && newBytes && Buffer.from(oldBytes).equals(newBytes))
    return null
  if (!oldBytes && !newBytes) return null
  const change = newChange(path, oldBytes !== null, newBytes !== null)
  change.binary = isBinary(oldBytes) || isBinary(newBytes)
  if (change.binary) return change
  const tooLarge =
    (oldBytes?.length ?? 0) > MAX_DIFF_BYTES ||
    (newBytes?.length ?? 0) > MAX_DIFF_BYTES
  if (tooLarge) {
    change.tooLarge = true
    return change
  }
  const oldText = oldBytes ? decode(oldBytes) : ""
  const newText = newBytes ? decode(newBytes) : ""
  Object.assign(change, countLineChanges(oldText, newText))
  if (oldBytes) change.oldContent = oldText
  if (newBytes) change.newContent = newText
  return change
}

async function compareSides(
  path: string,
  old: Side | null,
  next: Side | null,
  budget: ReadBudget
): Promise<UpdateFileChange | null> {
  if (!old && !next) return null
  const large = [old, next].some((s) => s && sizeOf(s) > MAX_DIFF_BYTES)
  if (!large) {
    const [oldSmall, newSmall] = await Promise.all([
      readSmall(old, budget),
      readSmall(next, budget),
    ])
    // Both sides fit (or are missing): compare in memory with line counts.
    if (oldSmall !== undefined && newSmall !== undefined)
      return compareFile(path, oldSmall, newSmall)
  }
  return compareLarge(path, old, next, budget)
}

/**
 * A side over the size cap: equal sizes are compared by streaming SHA-256.
 * Nothing is decoded and no lines are counted.
 */
async function compareLarge(
  path: string,
  old: Side | null,
  next: Side | null,
  budget: ReadBudget
): Promise<UpdateFileChange | null> {
  if (old && next && sizeOf(old) === sizeOf(next)) {
    const [a, b] = await Promise.all([
      hashSide(old, budget),
      hashSide(next, budget),
    ])
    if (a === b) return null
  }
  const change = newChange(path, old !== null, next !== null)
  const [oldHead, newHead] = await Promise.all([
    sniffSide(old, budget),
    sniffSide(next, budget),
  ])
  change.binary = isBinary(oldHead) || isBinary(newHead)
  if (!change.binary) change.tooLarge = true
  return change
}

function newChange(
  path: string,
  hasOld: boolean,
  hasNew: boolean
): UpdateFileChange {
  return {
    path,
    status: !hasOld ? "added" : !hasNew ? "removed" : "modified",
    binary: false,
    linesAdded: 0,
    linesRemoved: 0,
  }
}

/** Bytes the diff plans to read for one path, from the walk's sizes. */
function plannedRead(old: Side | null, next: Side | null): number {
  const sizes = [old, next].filter((s): s is Side => s !== null).map(sizeOf)
  if (sizes.every((size) => size <= MAX_DIFF_BYTES))
    return sizes.reduce((a, b) => a + b, 0)
  if (sizes.length === 2 && sizes[0] === sizes[1]) return sizes[0] * 2
  return sizes.length * BINARY_SNIFF_BYTES
}

function sizeOf(side: Side): number {
  return "bytes" in side ? side.bytes.length : side.file.size
}

/**
 * The whole side when it fits under the cap; null when missing; undefined
 * when it is too large (or grew past the cap since the walk).
 */
async function readSmall(
  side: Side | null,
  budget: ReadBudget
): Promise<Uint8Array | null | undefined> {
  if (!side) return null
  if (sizeOf(side) > MAX_DIFF_BYTES) return undefined
  if ("bytes" in side) return side.bytes
  const handle = await openRegularFile(side.file.path)
  try {
    const { bytes, truncated } = await readPrefix(
      handle,
      MAX_DIFF_BYTES,
      budget
    )
    return truncated ? undefined : bytes
  } finally {
    await handle.close()
  }
}

async function hashSide(side: Side, budget: ReadBudget): Promise<string> {
  const hash = createHash("sha256")
  if ("bytes" in side) return hash.update(side.bytes).digest("hex")
  const handle = await openRegularFile(side.file.path)
  try {
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length)
      if (bytesRead === 0) break
      budget.take(bytesRead)
      hash.update(chunk.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest("hex")
}

async function sniffSide(
  side: Side | null,
  budget: ReadBudget
): Promise<Uint8Array | null> {
  if (!side) return null
  if ("bytes" in side) return side.bytes.subarray(0, BINARY_SNIFF_BYTES)
  const handle = await openRegularFile(side.file.path)
  try {
    return (await readPrefix(handle, BINARY_SNIFF_BYTES, budget)).bytes
  } finally {
    await handle.close()
  }
}

/**
 * Every regular file under root, with its size. Symlinks are followed only
 * when their target stays inside the folder (as the CLI does when it
 * copies); others are skipped. More than `maxFiles` files is a 413.
 */
export async function collectFiles(
  root: string,
  options: WalkOptions = {}
): Promise<FileMap> {
  const realRoot = await realpath(root)
  const files: FileMap = new Map()
  const walker = new Walker(realRoot, files, options)
  await walker.walk(realRoot, "", new Set())
  return files
}

class Walker {
  private dirs = 0
  private readonly maxFiles: number

  constructor(
    private readonly realRoot: string,
    private readonly files: FileMap,
    private readonly options: WalkOptions
  ) {
    this.maxFiles = options.maxFiles ?? PREVIEW_LIMITS.maxFilesPerSide
  }

  async walk(dir: string, prefix: string, ancestors: Set<string>) {
    const realDir = await realpath(dir)
    if (ancestors.has(realDir)) return
    if (++this.dirs > this.maxFiles) throw this.tooMany("folders")
    const branch = new Set(ancestors).add(realDir)
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const target = await resolveEntry(full, this.realRoot)
      if (!target) continue
      if (isSkipped(entry.name, target.isDir, this.options)) continue
      if (target.isDir) {
        await this.walk(full, rel, branch)
        continue
      }
      if (this.files.size >= this.maxFiles) throw this.tooMany("files")
      this.files.set(rel, { path: target.path, size: target.size })
    }
  }

  private tooMany(what: string) {
    const side = this.options.label
      ? `the ${this.options.label} skill`
      : "a skill"
    return previewTooLarge(
      `${side} folder has more than ${this.maxFiles.toLocaleString("en-US")} ${what}`
    )
  }
}

/** A dir or regular file to visit, or null (broken, outside, or special). */
async function resolveEntry(
  path: string,
  realRoot: string
): Promise<{ path: string; isDir: boolean; size: number } | null> {
  const info = await lstat(path)
  if (!info.isSymbolicLink()) {
    if (info.isDirectory()) return { path, isDir: true, size: 0 }
    return info.isFile() ? { path, isDir: false, size: info.size } : null
  }
  const real = await realpath(path).catch(() => null)
  if (!real || !isInside(realRoot, real)) return null
  const target = await stat(real)
  if (target.isDirectory()) return { path: real, isDir: true, size: 0 }
  return target.isFile()
    ? { path: real, isDir: false, size: target.size }
    : null
}

function isSkipped(
  name: string,
  isDir: boolean,
  options: WalkOptions
): boolean {
  if (!options.cliExclusions) return isDir && LOCAL_EXCLUDED_DIRS.has(name)
  return CLI_EXCLUDED_NAMES.has(name) || (isDir && CLI_EXCLUDED_DIRS.has(name))
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
