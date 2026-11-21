import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises"
import { join } from "node:path"
import { isInside } from "../lib/files.ts"
import { HttpError } from "../lib/errors.ts"
import { formatMb } from "../preview/limits.ts"

/**
 * A deletion inventory: every entry under a folder, walked without following symlinks. It is
 * what decides whether a separate copy may be called "identical" (and so whether deleting it
 * can lose anything), and it fingerprints a ticked copy so that the folder the job deletes is
 * the folder the plan checked.
 *
 * Recorded per entry: the kind, and
 * - directories and regular files: the permission bits (mode & 0o7777);
 * - regular files: the size, a SHA-256 of the bytes and the Git blob id;
 * - symlinks: the link text, and whether it resolves inside the folder, outside, or nowhere;
 * - anything else (FIFO, socket, device): the kind only. Nothing is opened.
 */
export type EntryKind = "dir" | "file" | "symlink" | "fifo" | "socket" | "block device" | "char device" | "unknown"

export interface InventoryEntry {
  kind: EntryKind
  mode?: number
  size?: number
  sha256?: string
  /** Git blob id: sha1 of "blob <size>\0" and the bytes */
  blob?: string
  /** symlinks: the link text */
  target?: string
  resolves?: "inside" | "outside" | "dangling"
  mtimeMs: number
}

export interface Inventory {
  /** the folder walked */
  root: string
  dev: number
  ino: number
  /** relative posix path -> entry; "" is the folder itself */
  entries: Map<string, InventoryEntry>
  /** false: a metadata walk (names, kinds, modes, sizes, mtimes), no file was read */
  content: boolean
}

export interface InventoryLimits {
  /** entries below the root */
  maxEntries: number
  /** bytes read to hash files (content walks only), counted as they are read */
  maxReadBytes: number
}

/**
 * Hard cap of a deletion inventory, independent of the preview limits: every byte of a copy
 * is hashed before it may be deleted. A copy over it cannot be deleted here (tooLargeToRemove).
 */
export const DELETE_LIMITS: InventoryLimits = { maxEntries: 20_000, maxReadBytes: 500 * 1024 * 1024 }

/** The same cap for a metadata walk: names, kinds, modes, sizes and mtimes; no file is read. */
export const QUICK_LIMITS: InventoryLimits = { maxEntries: DELETE_LIMITS.maxEntries, maxReadBytes: 0 }

/** Fingerprint of a copy that the plan checked; the job compares it before and after staging. */
export interface CopyIdentity {
  dev: number
  ino: number
  /** digest of the metadata walk: names, kinds, modes, sizes, link texts and mtimes */
  quick: string
  /** digest of the content walk: every byte of every file (no mtimes) */
  full: string
}

/** 413 too_large: a walk passed its limits. */
export function inventoryTooLarge(detail: string): HttpError {
  return new HttpError(413, "too_large", `Too large: ${detail}`)
}

export function isTooLarge(err: unknown): boolean {
  return err instanceof HttpError && err.status === 413
}

/** Test seam: called after each chunk a content walk reads (`read`: bytes of that file so far). */
export interface InventoryHooks {
  afterChunk?: (path: string, read: number) => Promise<void> | void
}

/**
 * Names the skills CLI never copies (isExcluded in skills 1.9.0, used by copyDirectory and
 * computeSkillFolderHash): `metadata.json` of any type, and these directories. A copy the CLI
 * made never holds them, so they are always the user's own data.
 */
const CLI_EXCLUDED_FILES = new Set(["metadata.json"])
const CLI_EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"])

const HASH_CHUNK = 64 * 1024

/**
 * Walks `root` (a real directory, not a link). Throws 413 past a limit. File bytes are charged
 * against maxReadBytes as they are read, and no file is read past the size lstat gave: a file
 * that grows or shrinks while it is read fails the walk.
 */
export async function takeInventory(
  root: string,
  limits: InventoryLimits,
  options: { content?: boolean; hooks?: InventoryHooks } = {}
): Promise<Inventory> {
  const content = options.content ?? true
  const top = await lstat(root)
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Error(`${root} is not a folder`)
  const realRoot = await realpath(root)
  const entries = new Map<string, InventoryEntry>([["", dirEntry(top)]])
  let count = 0
  const budget = { used: 0, max: limits.maxReadBytes }
  const stack: [string, string][] = [[root, ""]]
  while (stack.length) {
    const [dir, prefix] = stack.pop() as [string, string]
    for (const name of (await readdir(dir)).sort()) {
      if (++count > limits.maxEntries)
        throw inventoryTooLarge(`the folder has more than ${limits.maxEntries.toLocaleString("en-US")} entries`)
      const full = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const info = await lstat(full)
      if (info.isDirectory()) {
        entries.set(rel, dirEntry(info))
        stack.push([full, rel])
      } else if (info.isSymbolicLink()) {
        const target = await readlink(full)
        const real = await realpath(full).catch(() => null)
        const resolves = !real ? "dangling" : isInside(realRoot, real) ? "inside" : "outside"
        entries.set(rel, { kind: "symlink", target, resolves, mtimeMs: info.mtimeMs })
      } else if (info.isFile()) {
        const entry: InventoryEntry = { kind: "file", mode: info.mode & 0o7777, size: info.size, mtimeMs: info.mtimeMs }
        if (content) {
          // Refuse early when the size alone passes the budget; hashFile charges what it reads.
          if (budget.used + info.size > budget.max) throw overBudget(budget.max)
          Object.assign(entry, await hashFile(full, info, budget, options.hooks))
        }
        entries.set(rel, entry)
      } else entries.set(rel, { kind: specialKind(info), mtimeMs: info.mtimeMs })
    }
  }
  const after = await lstat(root)
  if (after.dev !== top.dev || after.ino !== top.ino) throw new Error(`${root} was replaced while it was read`)
  return { root, dev: top.dev, ino: top.ino, entries, content }
}

function dirEntry(info: Stats): InventoryEntry {
  return { kind: "dir", mode: info.mode & 0o7777, mtimeMs: info.mtimeMs }
}

function specialKind(info: Stats): EntryKind {
  if (info.isFIFO()) return "fifo"
  if (info.isSocket()) return "socket"
  if (info.isBlockDevice()) return "block device"
  if (info.isCharacterDevice()) return "char device"
  return "unknown"
}

function overBudget(max: number): HttpError {
  return inventoryTooLarge(`the folder holds more than ${formatMb(max)}`)
}

/**
 * SHA-256 and Git blob id of a regular file, read once without following links. Reads at most
 * the lstat size plus one byte (to see whether it grew), charging every byte read to `budget`.
 */
async function hashFile(path: string, info: Stats, budget: { used: number; max: number }, hooks: InventoryHooks = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const now = await handle.stat()
    if (!now.isFile() || now.dev !== info.dev || now.ino !== info.ino)
      throw new Error(`${path} changed while it was read`)
    const sha256 = createHash("sha256")
    const blob = createHash("sha1").update(`blob ${info.size}\0`)
    const chunk = Buffer.alloc(HASH_CHUNK)
    let read = 0
    // One byte past the size: if it is there, the file grew.
    while (read <= info.size) {
      const want = Math.min(chunk.length, info.size + 1 - read)
      const { bytesRead } = await handle.read(chunk, 0, want, read)
      if (bytesRead === 0) break
      budget.used += bytesRead
      if (budget.used > budget.max) throw overBudget(budget.max)
      read += bytesRead
      if (read > info.size) break
      const part = chunk.subarray(0, bytesRead)
      sha256.update(part)
      blob.update(part)
      await hooks.afterChunk?.(path, read)
    }
    if (read !== info.size) throw new Error(`${path} changed while it was read`)
    return { sha256: sha256.digest("hex"), blob: blob.digest("hex") }
  } finally {
    await handle.close()
  }
}

/** Digest of a content walk: every recorded field except mtimes. */
export function fullDigest(inv: Inventory): string {
  if (!inv.content) throw new Error("a metadata walk has no content digest")
  return digest(inv, (e) => [e.kind, e.mode ?? null, e.size ?? null, e.sha256 ?? null, e.target ?? null])
}

/** Digest of the metadata: kinds, modes, sizes, link texts and mtimes (the root's mtime left out). */
export function quickDigest(inv: Inventory): string {
  return digest(inv, (e, rel) => [e.kind, e.mode ?? null, e.size ?? null, e.target ?? null, rel ? e.mtimeMs : null])
}

function digest(inv: Inventory, fields: (e: InventoryEntry, rel: string) => unknown[]): string {
  const hash = createHash("sha256")
  for (const rel of [...inv.entries.keys()].sort()) hash.update(JSON.stringify([rel, ...fields(inv.entries.get(rel) as InventoryEntry, rel)]) + "\n")
  return hash.digest("hex")
}

/** The identity of a copy, from a content walk. */
export function identityOf(inv: Inventory): CopyIdentity {
  return { dev: inv.dev, ino: inv.ino, quick: quickDigest(inv), full: fullDigest(inv) }
}

export function sameIdentity(a: CopyIdentity | null | undefined, b: CopyIdentity | null | undefined): boolean {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.quick === b.quick && a.full === b.full
}

/** Entries a CLI copy never has: excluded names, links outside or nowhere, special files. */
export function ownDataReasons(inv: Inventory): string[] {
  const groups = new Map<string, string[]>()
  const add = (reason: string, rel: string) => groups.set(reason, [...(groups.get(reason) ?? []), rel])
  for (const [rel, e] of inv.entries) {
    if (!rel) continue
    const excluded = excludedPrefix(rel, inv)
    if (excluded !== null) {
      // One reason per excluded folder or file, not one per entry inside it.
      if (excluded !== rel) continue
      const name = rel.split("/").pop() as string
      if (name === ".git") add("has .git history", rel)
      else if (CLI_EXCLUDED_DIRS.has(name)) add(`has a cache folder (${name})`, rel)
      else add("has metadata.json", rel)
      continue
    }
    if (e.kind === "symlink" && e.resolves === "outside") add("has a link outside the folder", `${rel} -> ${e.target}`)
    else if (e.kind === "symlink" && e.resolves === "dangling") add("has a dangling link", `${rel} -> ${e.target}`)
    else if (e.kind !== "dir" && e.kind !== "file" && e.kind !== "symlink") add(`has a special file (${e.kind})`, rel)
  }
  return [...groups].map(([reason, rels]) => withExamples(reason, rels))
}

/**
 * The path of the first component of `rel` that the CLI never copies, or null. A `.git` file
 * (a worktree pointer) counts like a `.git` folder.
 */
function excludedPrefix(rel: string, inv: Inventory): string | null {
  const parts = rel.split("/")
  for (let i = 0; i < parts.length; i++) {
    const at = parts.slice(0, i + 1).join("/")
    const kind = inv.entries.get(at)?.kind
    if (CLI_EXCLUDED_FILES.has(parts[i]) || parts[i] === ".git" || (kind === "dir" && CLI_EXCLUDED_DIRS.has(parts[i])))
      return at
  }
  return null
}

export interface InventoryComparison {
  identical: boolean
  /** entries that differ between the folders (own data of the copy included) */
  differences: number
  reasons: string[]
}

/**
 * A copy against the canonical folder. Identical only when both inventories hold exactly the
 * same entries with the same kinds, permission bits, sizes, bytes and link texts, and the copy
 * holds nothing a CLI copy never has (ownDataReasons). Mtimes are not compared.
 *
 * No exception is made for files the CLI writes on install: copyDirectory (skills 1.9.0) adds
 * nothing of its own. It copies regular files with the source's permission bits (mode & 0o777),
 * creates folders with mkdir, follows links that stay inside the source and drops the rest,
 * and leaves out metadata.json, .git, __pycache__ and __pypackages__. Copies it makes for two
 * agents in one install are therefore equal entry for entry. (For eve it rewrites the
 * SKILL.md frontmatter: such a copy differs, and stays opt-in.)
 */
export function compareInventories(canonical: Inventory, copy: Inventory): InventoryComparison {
  const reasons = ownDataReasons(copy)
  const own = new Set([...copy.entries.keys()].filter((rel) => rel && excludedPrefix(rel, copy) !== null))
  const ignoredInCanonical = new Set([...canonical.entries.keys()].filter((rel) => rel && excludedPrefix(rel, canonical) !== null))
  // Entries ownDataReasons already names are not reported a second time below.
  const flagged = new Set(
    [...copy.entries]
      .filter(([rel, e]) => own.has(rel) || (e.kind === "symlink" && e.resolves !== "inside") || !["dir", "file", "symlink"].includes(e.kind))
      .map(([rel]) => rel)
  )
  const differing = new Set(flagged)
  const buckets = new Map<string, string[]>()
  const add = (reason: string, rel: string, key = rel) => {
    buckets.set(reason, [...(buckets.get(reason) ?? []), rel])
    differing.add(key)
  }
  const noun = (e: InventoryEntry) => (e.kind === "dir" ? "folder" : e.kind === "file" ? "file" : e.kind === "symlink" ? "link" : "entry")
  for (const [rel, e] of copy.entries) {
    if (flagged.has(rel)) continue
    const c = canonical.entries.get(rel)
    if (!c || ignoredInCanonical.has(rel)) {
      add(`${noun(e)} only in the copy`, rel || ".")
      continue
    }
    if (c.kind !== e.kind) add("entry changed kind", `${rel || "."} (${c.kind} -> ${e.kind})`, rel)
    else if (e.kind === "file" && (c.size !== e.size || c.sha256 !== e.sha256)) add("file changed", rel)
    else if (e.kind === "symlink" && c.target !== e.target) add("link points elsewhere", `${rel} -> ${e.target}`, rel)
    else if (c.mode !== e.mode)
      add("permissions differ", `${rel || "."} (${(c.mode ?? 0).toString(8)} -> ${(e.mode ?? 0).toString(8)})`, rel)
  }
  for (const [rel, c] of canonical.entries)
    if (!ignoredInCanonical.has(rel) && !copy.entries.has(rel)) add(`${noun(c)} missing from the copy`, rel, `-${rel}`)
  for (const [reason, rels] of buckets) reasons.push(withExamples(countable(reason, rels.length), rels))
  return { identical: reasons.length === 0, differences: differing.size, reasons }
}

/** "file changed" -> "1 file changed" / "3 files changed"; "permissions differ" stays. */
function countable(reason: string, n: number): string {
  const m = /^(file|folder|link|entry)( .*)$/.exec(reason)
  if (!m) return reason
  const plural = m[1] === "entry" ? "entries" : `${m[1]}s`
  return `${n} ${n === 1 ? m[1] : plural}${m[2]}`
}

function withExamples(reason: string, rels: string[]): string {
  const shown = rels.slice(0, 2).join(", ")
  return `${reason} (${shown}${rels.length > 2 ? `, +${rels.length - 2} more` : ""})`
}

/**
 * The Git tree id of the folder, as GitHub records it for a skill path (the lock's 40-hex
 * skillFolderHash): file modes 100644 / 100755 (owner execute bit), 120000 for links (blob of
 * the link text), 40000 for folders, entries in Git's order. Null for a special file, which a
 * Git tree cannot hold. An empty folder hashes as an empty tree, which Git never stores, so it
 * never matches.
 */
export function gitTreeHash(inv: Inventory): string | null {
  if (!inv.content) return null
  const children = new Map<string, string[]>()
  for (const rel of inv.entries.keys()) {
    if (!rel) continue
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""
    children.set(parent, [...(children.get(parent) ?? []), rel])
  }
  const tree = (dir: string): string | null => {
    const items: { name: string; sort: Buffer; mode: string; id: string }[] = []
    for (const rel of children.get(dir) ?? []) {
      const e = inv.entries.get(rel) as InventoryEntry
      const name = rel.slice(rel.lastIndexOf("/") + 1)
      let mode: string
      let id: string | null
      if (e.kind === "dir") [mode, id] = ["40000", tree(rel)]
      else if (e.kind === "file") [mode, id] = [(e.mode ?? 0) & 0o100 ? "100755" : "100644", e.blob ?? null]
      else if (e.kind === "symlink") {
        const text = Buffer.from(e.target ?? "")
        mode = "120000"
        id = createHash("sha1").update(`blob ${text.length}\0`).update(text).digest("hex")
      } else return null
      if (!id) return null
      items.push({ name, sort: Buffer.from(e.kind === "dir" ? `${name}/` : name), mode, id })
    }
    items.sort((a, b) => Buffer.compare(a.sort, b.sort))
    const body = Buffer.concat(items.flatMap((i) => [Buffer.from(`${i.mode} ${i.name}\0`), Buffer.from(i.id, "hex")]))
    return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex")
  }
  return tree("")
}
