import type { Dirent } from "node:fs"
import { existsSync } from "node:fs"
import { readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { isDirectory, isInside } from "../lib/files.ts"

const SKIP_NAMES = new Set([
  "node_modules",
  "env",
  "venv",
  "dist",
  "build",
  "target",
  "__pycache__",
])
const MARKER_FILES = ["CLAUDE.md", "AGENTS.md", "skills-lock.json"]
const MARKER_DIRS = [".claude/skills", ".agents/skills"]

export interface ScanOptions {
  root: string
  depth: number
  skipPaths: string[]
}

/**
 * Finds project roots under `root`. Does not descend into symlinked dirs
 * (they can loop), but a symlinked dir that is itself a project counts.
 * Hidden dirs are skipped. Results are deduplicated by real path and keep
 * the path as found (e.g. ~/skills-manager rather than its /mnt target).
 */
export async function scanProjects(opts: ScanOptions): Promise<string[]> {
  const realSkips = await Promise.all(
    opts.skipPaths.map((p) => realpath(p).catch(() => p))
  )
  const options = {
    ...opts,
    skipPaths: [...new Set([...opts.skipPaths, ...realSkips])],
  }
  const found = new Set<string>()
  const linked: string[] = []
  await walk(opts.root, 0, options, found, linked)
  for (const link of linked) {
    const real = await realpath(link).catch(() => null)
    if (
      real &&
      !isSkipped(real, options) &&
      (await isDirectory(real)) &&
      isProject(real)
    )
      found.add(link)
  }
  return dedupeByRealpath(
    [...found].sort(),
    await realpath(opts.root).catch(() => opts.root)
  )
}

async function dedupeByRealpath(
  paths: string[],
  realRoot: string
): Promise<string[]> {
  const seen = new Set<string>([realRoot])
  const out: string[] = []
  for (const path of paths) {
    const real = (await realpath(path).catch(() => null)) ?? path
    if (seen.has(real)) continue
    seen.add(real)
    out.push(path)
  }
  return out
}

export function isProject(dir: string): boolean {
  return (
    MARKER_FILES.some((f) => existsSync(join(dir, f))) ||
    MARKER_DIRS.some((d) => existsSync(join(dir, d)))
  )
}

async function walk(
  dir: string,
  depth: number,
  opts: ScanOptions,
  found: Set<string>,
  linked: string[]
) {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (hasMarker(dir, entries)) found.add(dir)
  if (depth >= opts.depth) return
  const children: Promise<void>[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_NAMES.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (isSkipped(path, opts)) continue
    if (entry.isSymbolicLink()) linked.push(path)
    else if (entry.isDirectory())
      children.push(walk(path, depth + 1, opts, found, linked))
  }
  await Promise.all(children)
}

function hasMarker(dir: string, entries: Dirent[]): boolean {
  const names = new Set(entries.map((e) => e.name))
  if (MARKER_FILES.some((f) => names.has(f))) return true
  return MARKER_DIRS.some(
    (d) => names.has(d.split("/")[0]) && existsSync(join(dir, d))
  )
}

function isSkipped(path: string, opts: ScanOptions): boolean {
  return opts.skipPaths.some((skip) => isInside(skip, path))
}
