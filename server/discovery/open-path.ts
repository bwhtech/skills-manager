import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import type { OpenResult, SaveRequest, SaveResponse, ViewedFileContent } from "../../shared/api.ts"
import { HttpError, badRequest, forbidden, notFound } from "../lib/errors.ts"
import { MAX_TEXT_BYTES, isInside, readTextFile, realpathOrNull, saveTextFile } from "../lib/files.ts"
import { SECRET_REFUSAL, looksSecret } from "../lib/secret-paths.ts"
import { decodePathId, requireRelativePath } from "../lib/validate.ts"
import type { InstructionService } from "./instructions.ts"
import type { IndexedSkill } from "./skill-index.ts"
import { SKIP_DIRS, hasNulByte } from "./skill-files.ts"

type SkillRef = Pick<IndexedSkill, "id" | "realPath" | "scope" | "scopes">

export interface OpenDeps {
  home: string
  /** folders whose files may be shown (HOME and /mnt/data) */
  roots: string[]
  skills: () => Promise<SkillRef[]>
  instructions: Pick<InstructionService, "find" | "findByRealPath">
}

/** Never shown, even when a root contains them. */
const SYSTEM_DIRS = ["/proc", "/dev", "/sys"]
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const MARKDOWN = /\.md$/i

export const READ_ONLY_REFUSAL = "Only Markdown files can be edited here"
const OUTSIDE = "Only files under HOME and /mnt/data can be opened"

/** Strips a Markdown anchor (#section) and a trailing :line or :line:col. */
export function parseRawPath(raw: string): { path: string; line?: number } {
  let path = raw.trim()
  const anchor = path.indexOf("#")
  if (anchor > 0) path = path.slice(0, anchor)
  const match = LINE_SUFFIX.exec(path)
  if (!match) return { path }
  const line = Number(match[1])
  return { path: path.slice(0, match.index), ...(line > 0 ? { line } : {}) }
}

/**
 * Resolves paths written in documents to something the UI can open, and shows
 * those files. Of the plain files, only existing Markdown files can be saved.
 */
export class PathOpener {
  private realRoots: Promise<string[]> | null = null

  constructor(private readonly deps: OpenDeps) {}

  async open(rawPath: unknown, from: unknown): Promise<OpenResult> {
    if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0") || rawPath.length > 4096)
      throw badRequest("path is required")
    const { path, line } = parseRawPath(rawPath)
    if (!path || URL_SCHEME.test(path)) throw badRequest("Not a file path")
    const absolute = await this.absolute(path, from)
    const real = await this.checkedFile(absolute)
    const at = line ? { line } : {}

    const skill = (await this.deps.skills())
      .filter((s) => real !== s.realPath && isInside(s.realPath, real))
      .sort((a, b) => b.realPath.length - a.realPath.length)[0]
    if (skill) {
      const file = relative(skill.realPath, real)
      if (!file.split("/").some((part) => SKIP_DIRS.has(part)))
        return { kind: "skill-file", skillId: skill.id, file, scope: skill.scope, scopes: skill.scopes, ...at }
    }
    const doc = await this.deps.instructions.findByRealPath(real)
    if (doc) return { kind: "instruction", id: doc.id, scope: doc.scope, ...at }
    // The path as written reads better than the real one (/mnt/data is a link to a volume).
    return { kind: "file", path: absolute, ...at }
  }

  /** A regular text file by absolute path; `editable` for Markdown files the server may write. */
  async read(rawPath: unknown): Promise<ViewedFileContent> {
    const path = requireAbsolute(rawPath)
    const real = await this.checkedFile(path)
    return { ...(await readTextFile(real)), editable: await isWritableMarkdown(path, real) }
  }

  /**
   * Saves an existing Markdown file (by the name asked and the real name). Writes the real
   * path, so a symlink keeps pointing at the file it wrote. Under the save lock the checks
   * run again: the path must still lead to the same real file.
   */
  async save(rawPath: unknown, req: SaveRequest): Promise<SaveResponse> {
    const path = requireAbsolute(rawPath)
    const real = await this.checkedFile(path, { outside: () => forbidden("Only files under HOME and /mnt/data can be edited") })
    if (!MARKDOWN.test(path) || !MARKDOWN.test(real)) throw new HttpError(403, "read_only", READ_ONLY_REFUSAL)
    const guard = async () => {
      if ((await this.checkedFile(path)) !== real) throw new HttpError(409, "moved", "The file was moved or replaced; reload it")
    }
    return saveTextFile(real, req, { guard })
  }

  private async absolute(path: string, from: unknown): Promise<string> {
    if (path === "~" || path.startsWith("~/")) return join(this.deps.home, path.slice(1))
    if (isAbsolute(path)) return normalize(path)
    return resolve(await this.baseDir(from), path)
  }

  /** The folder a relative path in the `from` document starts at. */
  private async baseDir(from: unknown): Promise<string> {
    if (typeof from !== "string" || !from) throw badRequest("A relative path needs `from`: the document it is in")
    if (isAbsolute(from)) return dirname(normalize(from))
    const colon = from.indexOf(":")
    if (colon < 0) return dirname((await this.deps.instructions.find(from)).path)
    const root = decodePathId(from.slice(0, colon))
    const file = requireRelativePath(from.slice(colon + 1))
    const skill = (await this.deps.skills()).find((s) => s.realPath === root)
    if (!skill) throw notFound("Unknown skill")
    return dirname(join(skill.realPath, file))
  }

  /**
   * The real path of a showable text file, or the HttpError that says why not.
   * `outside` makes the error for a real path outside the roots (default 404).
   */
  private async checkedFile(path: string, options: { outside?: () => HttpError } = {}): Promise<string> {
    const roots = await this.roots()
    const secret = (p: string) => [this.deps.home, ...roots].some((home) => looksSecret(p, home))
    // The asked path first, so a refusal does not tell whether a secret file exists.
    if (secret(path)) throw forbidden(SECRET_REFUSAL)
    const real = await realpathOrNull(path)
    if (!real) throw notFound(`No such file: ${path}`)
    if (SYSTEM_DIRS.some((dir) => isInside(dir, real)) || !roots.some((root) => isInside(root, real)))
      throw options.outside?.() ?? notFound(OUTSIDE)
    if (secret(real)) throw forbidden(SECRET_REFUSAL)
    const info = await stat(real)
    if (!info.isFile()) throw notFound(`Not a file: ${path}`)
    if (info.size > MAX_TEXT_BYTES) throw new HttpError(413, "too_large", "File is larger than 1 MB")
    if (await hasNulByte(real, 8192)) throw new HttpError(415, "binary", "Not shown: a binary file")
    return real
  }

  private roots(): Promise<string[]> {
    this.realRoots ??= Promise.all(this.deps.roots.map(realpathOrNull)).then((roots) =>
      roots.filter((root): root is string => root !== null)
    )
    return this.realRoots
  }
}

function requireAbsolute(rawPath: unknown): string {
  if (typeof rawPath !== "string" || !isAbsolute(rawPath) || rawPath.includes("\0"))
    throw badRequest("path must be absolute")
  return normalize(rawPath)
}

/** A Markdown file (asked and real name) that this process can write, in place. */
async function isWritableMarkdown(path: string, real: string): Promise<boolean> {
  if (!MARKDOWN.test(path) || !MARKDOWN.test(real)) return false
  // The save writes a temp file next to the file, then renames it over it.
  const writable = (p: string) => access(p, constants.W_OK).then(() => true, () => false)
  return (await writable(real)) && (await writable(dirname(real)))
}
