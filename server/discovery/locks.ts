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
  /** project lock: hash of the installed folder */
  computedHash?: string
  /** commit the skill was installed from, when known */
  commit?: string
  installedAt?: string
  updatedAt?: string
}

export interface SkillLock {
  skills: Map<string, LockEntry>
  lastSelectedAgents: string[]
}

/** The lock of a scope: the global lock for "user", else the project's skills-lock.json. */
export type LockReader = (scope: string) => Promise<SkillLock>

export const readScopeLock: LockReader = (scope) =>
  scope === "user" ? readGlobalLock() : readProjectLock(scope)

/**
 * Identity of a lock entry: the key and every field that a reinstall or an update rewrites.
 * Two equal fingerprints mean the entry was not touched in between.
 */
export function lockFingerprint(key: string, entry: LockEntry): string {
  return JSON.stringify([
    key,
    entry.source,
    entry.sourceUrl ?? null,
    entry.sourceType ?? null,
    entry.skillPath ?? null,
    entry.ref ?? null,
    entry.skillName ?? null,
    entry.skillFolderHash ?? null,
    entry.computedHash ?? null,
    entry.commit ?? null,
    entry.sourceBaseUrl ?? null,
    entry.wellKnownDigest ?? null,
    entry.installedAt ?? null,
    entry.updatedAt ?? null,
  ])
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

export async function readLock(path: string): Promise<SkillLock> {
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
      computedHash: str(entry.computedHash),
      commit: str(entry.commit),
      installedAt: str(entry.installedAt),
      updatedAt: str(entry.updatedAt),
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
