import { mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type {
  FileContent,
  InstructionFile,
  InstructionFileName,
  InstructionLinkRef,
  LinkInstructionRequest,
  LinkInstructionResponse,
  SaveInstructionRequest,
  SaveResponse,
  ScopeKey,
  SyncCandidate,
  SyncPreview,
  UnlinkInstructionRequest,
  UnlinkInstructionResponse,
} from "../../shared/api.ts"
import { encodeId } from "../../shared/api.ts"
import { config } from "../config.ts"
import { HttpError, notFound } from "../lib/errors.ts"
import {
  contentHash,
  readTextFile,
  realpathOrNull,
  resolveLink,
  saveTextFile,
} from "../lib/files.ts"
import { countLineChanges } from "../preview/line-diff.ts"
import {
  backupPathFor,
  checkLink,
  linkFile,
  unlinkFile,
  type LinkEnd,
} from "./instruction-links.ts"
import type { ProjectService } from "./projects.ts"

interface Slot {
  fileName: InstructionFileName
  dir: string
  agentLabel: string
}

/** Where user-level files live; a seam for tests with a temp HOME. */
export interface InstructionDirs {
  home: string
  claudeHome: string
  codexHome: string
}

/** A described file plus what link matching needs. */
interface Entry {
  file: InstructionFile
  /** real path of a regular (non-link) file that exists */
  real: string | null
}

/** CLAUDE.md, CLAUDE.local.md and AGENTS.md at user and project level. */
export class InstructionService {
  constructor(
    private readonly projects: Pick<ProjectService, "paths">,
    private readonly dirs: InstructionDirs = config
  ) {}

  /** The scope's files, with links resolved against every known file. */
  async list(scope: ScopeKey): Promise<InstructionFile[]> {
    const all = await this.all()
    return all.filter((f) => f.scope === scope)
  }

  /** Only paths the server derives itself can be found. */
  async find(id: string): Promise<InstructionFile> {
    const file = (await this.all()).find((f) => f.id === id)
    if (!file) throw notFound("Unknown instruction file")
    return file
  }

  /** Cheap: no link matching across scopes. */
  async countExisting(scope: ScopeKey): Promise<number> {
    const entries = await Promise.all(
      this.slotsFor(scope).map((slot) => describe(scope, slot))
    )
    return entries.filter((e) => e.file.exists).length
  }

  async read(id: string): Promise<FileContent> {
    const file = await this.find(id)
    if (!file.exists) throw notFound("File does not exist")
    return readTextFile(file.linkTarget ?? file.path)
  }

  /** Writes to the link target when the file is a symlink. */
  async save(id: string, req: SaveInstructionRequest): Promise<SaveResponse> {
    const file = await this.find(id)
    const target = file.linkTarget ?? file.path
    if (req.create) {
      if (file.exists)
        throw new HttpError(409, "exists", "The file already exists")
      return createFile(target, req.content)
    }
    if (!file.exists)
      throw notFound("File does not exist; send create: true to make it")
    return saveTextFile(target, req)
  }

  /** What linking other files to the target :id would do. */
  async syncPreview(targetId: string): Promise<SyncPreview> {
    const all = await this.all()
    const target = all.find((f) => f.id === targetId)
    if (!target) throw notFound("Unknown instruction file")
    const targetEnd = await this.end(target)
    const targetContent = await readTarget(target)
    const scopes = new Set([target.scope, "user"])
    const candidates = await Promise.all(
      all
        .filter((f) => f.id !== target.id && scopes.has(f.scope))
        .map((f) => this.candidate(f, targetEnd, targetContent))
    )
    return {
      target,
      targetContent: targetContent.content,
      targetHash: targetContent.hash,
      candidates,
    }
  }

  async link(
    id: string,
    req: LinkInstructionRequest
  ): Promise<LinkInstructionResponse> {
    if (!req || typeof req.targetId !== "string")
      throw new HttpError(400, "bad_request", "targetId must be a string")
    if (req.backup !== true)
      throw new HttpError(400, "bad_request", "backup must be true")
    if (req.baseHash !== undefined && typeof req.baseHash !== "string")
      throw new HttpError(400, "bad_request", "baseHash must be a string")
    const all = await this.all()
    const source = all.find((f) => f.id === id)
    const target = all.find((f) => f.id === req.targetId)
    if (!source || !target) throw notFound("Unknown instruction file")
    const { backupPath } = await linkFile(
      await this.end(source),
      await this.end(target),
      { baseHash: req.baseHash, home: this.dirs.home }
    )
    return { file: await this.find(id), backupPath }
  }

  async unlink(
    id: string,
    req: UnlinkInstructionRequest
  ): Promise<UnlinkInstructionResponse> {
    if (!req || (req.mode !== "copy" && req.mode !== "empty"))
      throw new HttpError(400, "bad_request", 'mode must be "copy" or "empty"')
    const file = await this.find(id)
    await unlinkFile(file.path, req.mode)
    return { file: await this.find(id) }
  }

  private async candidate(
    file: InstructionFile,
    target: LinkEnd,
    targetContent: FileContent
  ): Promise<SyncCandidate> {
    const base: SyncCandidate = {
      file,
      identical: false,
      linesAdded: 0,
      linesRemoved: 0,
      backupPath: null,
    }
    const source = await this.end(file)
    const problem = checkLink(source, target)
    if (problem) return { ...base, blocked: problem.detail }
    if (!file.exists) {
      return {
        ...base,
        linesAdded: countLineChanges("", targetContent.content).linesAdded,
      }
    }
    let content: FileContent
    try {
      content = await readTextFile(file.path)
    } catch (err) {
      if (err instanceof HttpError) return { ...base, blocked: err.detail }
      throw err
    }
    const counts = countLineChanges(content.content, targetContent.content)
    return {
      ...base,
      ...counts,
      content: content.content,
      hash: content.hash,
      identical: content.hash === targetContent.hash,
      backupPath: await backupPathFor(file.path),
    }
  }

  private async end(file: InstructionFile): Promise<LinkEnd> {
    const link = await resolveLink(file.path)
    return {
      id: file.id,
      path: file.path,
      isLink: link.isLink,
      exists: link.exists,
      real: link.exists ? await realpathOrNull(file.path) : null,
    }
  }

  /** Every known file in every scope, each id once, with links matched. */
  private async all(): Promise<InstructionFile[]> {
    const scopes: ScopeKey[] = ["user", ...this.projects.paths()]
    const described = await Promise.all(
      scopes.flatMap((scope) =>
        this.slotsFor(scope).map((slot) => describe(scope, slot))
      )
    )
    const seen = new Set<string>()
    const entries = described.filter((e) => {
      if (seen.has(e.file.id)) return false
      seen.add(e.file.id)
      return true
    })
    matchLinks(entries)
    return entries.map((e) => e.file)
  }

  private slotsFor(scope: ScopeKey): Slot[] {
    if (scope === "user") {
      return [
        {
          fileName: "CLAUDE.md",
          dir: this.dirs.claudeHome,
          agentLabel: "Claude Code",
        },
        {
          fileName: "AGENTS.md",
          dir: this.dirs.codexHome,
          agentLabel: "Codex",
        },
      ]
    }
    return [
      { fileName: "CLAUDE.md", dir: scope, agentLabel: "Claude Code" },
      {
        fileName: "CLAUDE.local.md",
        dir: scope,
        agentLabel: "Claude Code (local, not committed)",
      },
      {
        fileName: "AGENTS.md",
        dir: scope,
        agentLabel: "Codex and other agents",
      },
    ]
  }
}

async function describe(scope: ScopeKey, slot: Slot): Promise<Entry> {
  const path = join(slot.dir, slot.fileName)
  const link = await resolveLink(path)
  const file: InstructionFile = {
    id: encodeId(path),
    scope,
    fileName: slot.fileName,
    agentLabel: slot.agentLabel,
    path,
    exists: link.exists,
  }
  if (link.isLink) {
    file.linkTarget = link.target
    if (!link.exists) file.linkBroken = true
  }
  const real = !link.isLink && link.exists ? await realpathOrNull(path) : null
  return { file, real }
}

function ref(file: InstructionFile): InstructionLinkRef {
  const { id, scope, path, fileName, agentLabel } = file
  return { id, scope, path, fileName, agentLabel }
}

/**
 * Sets linkTargetId on links whose target is a known file, and linkedFrom on
 * those targets. A target matches by its path, or by the real path of a
 * regular file (a link through a symlinked dir). Regular files win.
 */
function matchLinks(entries: Entry[]): void {
  const byPath = new Map<string, InstructionFile>()
  const byReal = new Map<string, InstructionFile>()
  for (const { file, real } of entries) {
    if (file.linkTarget) continue
    if (!byPath.has(file.path)) byPath.set(file.path, file)
    if (real && !byReal.has(real)) byReal.set(real, file)
  }
  for (const { file } of entries) {
    if (!file.linkTarget) continue
    const target = byPath.get(file.linkTarget) ?? byReal.get(file.linkTarget)
    if (!target || target.id === file.id) continue
    file.linkTargetId = target.id
    file.linkTargetFile = ref(target)
    target.linkedFrom = [...(target.linkedFrom ?? []), ref(file)]
  }
}

async function readTarget(target: InstructionFile): Promise<FileContent> {
  if (target.linkTarget)
    throw new HttpError(
      400,
      "target_is_link",
      `${target.path} is a symlink. Sync to the file it points at instead.`
    )
  if (!target.exists)
    throw new HttpError(400, "target_missing", "The target file does not exist")
  return readTextFile(target.path)
}

async function createFile(
  target: string,
  content: unknown
): Promise<SaveResponse> {
  if (typeof content !== "string")
    throw new HttpError(400, "bad_request", "content must be a string")
  await mkdir(dirname(target), { recursive: true })
  try {
    await writeFile(target, content, { flag: "wx", mode: 0o644 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      throw new HttpError(409, "exists", "The file already exists")
    throw err
  }
  return { mtimeMs: (await stat(target)).mtimeMs, hash: contentHash(content) }
}
