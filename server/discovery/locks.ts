import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { SkillSource } from "../../shared/api.ts"
import { config, projectLockName } from "../config.ts"

export interface LockEntry {
  source: string
  sourceUrl?: string
  sourceType?: string
  skillPath?: string
  /** branch, tag or commit the skill was installed from */
  ref?: string
  /** the skill's name in its source, when installed under another name */
  skillName?: string
  /** global lock: version token; `skills update` skips git entries without it */
  skillFolderHash?: string
  /** global lock, well-known sources */
  sourceBaseUrl?: string
  wellKnownDigest?: string
}

export interface SkillLock {
  skills: Map<string, LockEntry>
  lastSelectedAgents: string[]
}

/** ~/.agents/.skill-lock.json */
export function readGlobalLock(): Promise<SkillLock> {
  return readLock(config.globalLock)
}

/** <project>/skills-lock.json */
export function readProjectLock(project: string): Promise<SkillLock> {
  return readLock(join(project, projectLockName))
}

export function toSkillSource(entry: LockEntry): SkillSource {
  const out: SkillSource = { source: entry.source }
  if (entry.sourceUrl) out.sourceUrl = entry.sourceUrl
  if (entry.sourceType) out.sourceType = entry.sourceType
  if (entry.skillPath) out.skillPath = entry.skillPath
  return out
}

async function readLock(path: string): Promise<SkillLock> {
  const lock: SkillLock = { skills: new Map(), lastSelectedAgents: [] }
  let raw: {
    skills?: Record<string, Partial<LockEntry>>
    lastSelectedAgents?: unknown
  }
  try {
    raw = JSON.parse(await readFile(path, "utf8"))
  } catch {
    return lock
  }
  for (const [name, entry] of Object.entries(raw.skills ?? {})) {
    if (!entry || typeof entry.source !== "string") continue
    lock.skills.set(name, {
      source: entry.source,
      sourceUrl: str(entry.sourceUrl),
      sourceType: str(entry.sourceType),
      skillPath: str(entry.skillPath),
      ref: str(entry.ref),
      skillName: str(entry.skillName),
      skillFolderHash: str(entry.skillFolderHash),
      sourceBaseUrl: str(entry.sourceBaseUrl),
      wellKnownDigest: str(entry.wellKnownDigest),
    })
  }
  if (Array.isArray(raw.lastSelectedAgents)) {
    lock.lastSelectedAgents = raw.lastSelectedAgents.filter(
      (a): a is string => typeof a === "string"
    )
  }
  return lock
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
