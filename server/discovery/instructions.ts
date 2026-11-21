import { mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type {
  FileContent,
  InstructionFile,
  InstructionFileName,
  SaveInstructionRequest,
  SaveResponse,
  ScopeKey,
} from "../../shared/api.ts"
import { encodeId } from "../../shared/api.ts"
import { config } from "../config.ts"
import { HttpError, notFound } from "../lib/errors.ts"
import {
  contentHash,
  readTextFile,
  resolveLink,
  saveTextFile,
} from "../lib/files.ts"
import type { ProjectService } from "./projects.ts"

interface Slot {
  fileName: InstructionFileName
  dir: string
  agentLabel: string
}

/** CLAUDE.md, CLAUDE.local.md and AGENTS.md at user and project level. */
export class InstructionService {
  constructor(private readonly projects: ProjectService) {}

  async list(scope: ScopeKey): Promise<InstructionFile[]> {
    return Promise.all(slotsFor(scope).map((slot) => describe(scope, slot)))
  }

  /** Only paths the server derives itself can be found. */
  async find(id: string): Promise<InstructionFile> {
    for (const scope of ["user", ...this.projects.paths()]) {
      const slot = slotsFor(scope).find(
        (s) => encodeId(join(s.dir, s.fileName)) === id
      )
      if (slot) return describe(scope, slot)
    }
    throw notFound("Unknown instruction file")
  }

  async countExisting(scope: ScopeKey): Promise<number> {
    return (await this.list(scope)).filter((f) => f.exists).length
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
}

function slotsFor(scope: ScopeKey): Slot[] {
  if (scope === "user") {
    return [
      {
        fileName: "CLAUDE.md",
        dir: config.claudeHome,
        agentLabel: "Claude Code",
      },
      { fileName: "AGENTS.md", dir: config.codexHome, agentLabel: "Codex" },
    ]
  }
  return [
    { fileName: "CLAUDE.md", dir: scope, agentLabel: "Claude Code" },
    {
      fileName: "CLAUDE.local.md",
      dir: scope,
      agentLabel: "Claude Code (local, not committed)",
    },
    { fileName: "AGENTS.md", dir: scope, agentLabel: "Codex and other agents" },
  ]
}

async function describe(scope: ScopeKey, slot: Slot): Promise<InstructionFile> {
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
  if (link.isLink) file.linkTarget = link.target
  return file
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
