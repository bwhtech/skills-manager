import type { Dirent } from "node:fs"
import { constants } from "node:fs"
import { access, lstat, open, readdir, realpath, stat } from "node:fs/promises"
import { dirname, extname, join, relative } from "node:path"
import type { FileContent, SkillFileEntry } from "../../shared/api.ts"
import { HttpError, notFound } from "../lib/errors.ts"
import { MAX_TEXT_BYTES, isInside, readTextFile, realpathOrNull } from "../lib/files.ts"
import { requireRelativePath } from "../lib/validate.ts"

const MAX_ENTRIES = 500
const MARKDOWN = /\.md$/i
export const MARKDOWN_ONLY = "Only Markdown files can be edited"
/** Folders a skill file tree skips. */
export const SKIP_DIRS = new Set([".git", "node_modules"])
const TEXT_EXT = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".rb",
  ".go",
  ".rs",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".xml",
  ".svg",
  ".csv",
  ".tsv",
  ".sql",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".vue",
  ".svelte",
  ".lua",
  ".php",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".graphql",
  ".gql",
  ".lock",
  ".gitignore",
])
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
  ".webm",
  ".wasm",
  ".so",
  ".dylib",
  ".exe",
  ".bin",
  ".pyc",
])

/** Files of a skill folder, sorted, capped. Symlinked dirs are not entered. `root` must be a real path. */
export async function listSkillFiles(root: string): Promise<SkillFileEntry[]> {
  const out: SkillFileEntry[] = []
  await walk(root, root, out)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Real path of the skill's SKILL.md, or null when it is missing, not a file,
 * or a link that leads out of the skill folder. `root` must be a real path.
 */
export async function containedSkillMd(root: string): Promise<string | null> {
  const real = await realpath(join(root, "SKILL.md")).catch(() => null)
  if (!real || real === root || !isInside(root, real)) return null
  const info = await stat(real).catch(() => null)
  return info?.isFile() ? real : null
}

/** SKILL.md of a skill folder, read only if it stays inside the folder. */
export async function readSkillMd(root: string): Promise<FileContent> {
  const real = await containedSkillMd(root)
  if (!real) throw notFound("SKILL.md is missing or links outside the skill folder")
  return readTextFile(real)
}

/** A text file inside the skill folder. The real path must stay inside it. */
export async function readSkillFile(
  root: string,
  rawPath: unknown
): Promise<FileContent> {
  const rel = requireRelativePath(rawPath)
  if (rel.split("/").some((p) => SKIP_DIRS.has(p)))
    throw notFound("File not found")
  const real = await realpath(join(root, rel)).catch(() => null)
  if (!real || !isInside(root, real)) throw notFound("File not found")
  const info = await stat(real)
  if (!info.isFile()) throw notFound("Not a file")
  if (!(await isTextFile(real, info.size)))
    throw new HttpError(415, "binary", "Only text files can be shown")
  return readTextFile(real)
}

/** 403 read_only: the file exists but may not be saved. */
export function readOnly(detail: string): HttpError {
  return new HttpError(403, "read_only", detail)
}

/**
 * Real path of a file of the skill folder that a save may write, or the HttpError that says
 * why not: 404 when missing (nothing is ever created), 403 read_only otherwise. The file
 * must be listed in the folder's files as text (so not under a symlinked dir or a skipped
 * one), its asked and real names must end in .md (any case), its real path must stay inside
 * the folder, and it must be a regular file of at most 1 MB with no NUL bytes. `root` must be
 * a real path. Says nothing about the skill's origin: the caller checks `editable`.
 */
export async function editableSkillFile(root: string, rel: string): Promise<string> {
  if (rel.split("/").some((p) => SKIP_DIRS.has(p))) throw notFound("File not found")
  const path = join(root, rel)
  if (!(await lstat(path).catch(() => null))) throw notFound("File not found")
  if (!MARKDOWN.test(rel)) throw readOnly(MARKDOWN_ONLY)
  const real = await realpathOrNull(path)
  if (!real) throw notFound("File not found")
  if (real === root || !isInside(root, real))
    throw readOnly("Only files inside the skill folder can be edited")
  if (!MARKDOWN.test(real)) throw readOnly(MARKDOWN_ONLY)
  const info = await stat(real)
  if (!info.isFile()) throw notFound("Not a file")
  if (info.size > MAX_TEXT_BYTES) throw readOnly("Files larger than 1 MB cannot be edited")
  if (await hasNulByte(real, MAX_TEXT_BYTES)) throw readOnly("Binary files cannot be edited")
  const listed = (await listSkillFiles(root)).some((entry) => entry.path === rel && entry.isText)
  if (!listed) throw readOnly("Only files listed in the skill folder can be edited")
  return real
}

/** editableSkillFile passes, and this process can replace the file (temp file + rename). */
export async function isEditableSkillFile(root: string, rel: string): Promise<boolean> {
  const real = await editableSkillFile(root, rel).catch(() => null)
  if (!real) return false
  const writable = (p: string) => access(p, constants.W_OK).then(() => true, () => false)
  return (await writable(real)) && (await writable(dirname(real)))
}

async function walk(
  root: string,
  dir: string,
  out: SkillFileEntry[]
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, path, out)
      continue
    }
    // Links that point out of the folder are not part of the skill.
    if (entry.isSymbolicLink()) {
      const real = await realpath(path).catch(() => null)
      if (!real || !isInside(root, real)) continue
    }
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) continue
    out.push({
      path: relative(root, path),
      size: info.size,
      isText: await isTextFile(path, info.size),
    })
  }
}

async function isTextFile(path: string, size: number): Promise<boolean> {
  if (size > MAX_TEXT_BYTES) return false
  const ext = extname(path).toLowerCase()
  if (TEXT_EXT.has(ext)) return true
  if (BINARY_EXT.has(ext)) return false
  return !(await hasNulByte(path))
}

/** True when the first `bytes` bytes hold a NUL byte (or the file cannot be opened). */
export async function hasNulByte(path: string, bytes = 4096): Promise<boolean> {
  const handle = await open(path, "r").catch(() => null)
  if (!handle) return true
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}
