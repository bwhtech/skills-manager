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
  /** "copy" or "symlink": how the CLI installed the skill (newer CLI versions record it) */
  installMode?: string
  installedAt?: string
  updatedAt?: string
}

export interface SkillLock {
  skills: Map<string, LockEntry>
  lastSelectedAgents: string[]
}

/** The lock of a scope: the global lock for "user", else the project's skills-lock.json. */
export type LockReader = (scope: string) => Promise<SkillLock>

/**
 * A lock read for verification: also every key of the raw `skills` object, whatever its entry
 * holds. `skills` drops entries without a string `source`; `rawKeys` does not.
 */
export interface StrictLock extends SkillLock {
  rawKeys: string[]
}

export type StrictLockReader = (scope: string) => Promise<SkillLock & { rawKeys?: string[] }>

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

type RawLock = {
  skills?: Record<string, Partial<LockEntry>>
  lastSelectedAgents?: unknown
}

/** A missing, unreadable or malformed lock reads as empty. For display and planning. */
export async function readLock(path: string): Promise<SkillLock> {
  let raw: RawLock
  try {
    raw = JSON.parse(await readFile(path, "utf8"))
  } catch {
    return { skills: new Map(), lastSelectedAgents: [] }
  }
  return parseLock(raw)
}

/**
 * For verification after `skills remove`, which always writes the lock back: throws when the
 * file is missing, unreadable, not JSON, or has no `skills` object. A valid lock with no
 * entries is a valid empty result. `rawKeys` lists every own key of `skills`, malformed
 * entries included, so that verification never reads a malformed entry as "removed".
 */
export async function readLockStrict(path: string): Promise<StrictLock> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err) {
    throw new Error(`could not read the lock file ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`, {
      cause: err,
    })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`the lock file ${path} is not valid JSON`, { cause: err })
  }
  const skills = (raw as RawLock | null)?.skills
  if (!raw || typeof raw !== "object" || !skills || typeof skills !== "object" || Array.isArray(skills))
    throw new Error(`the lock file ${path} has no skills object`)
  return { ...parseLock(raw as RawLock), rawKeys: Object.keys(skills) }
}

/** readLockStrict for a scope: the global lock for "user", else the project's lock. */
export const readScopeLockStrict: (scope: string) => Promise<StrictLock> = (scope) =>
  readLockStrict(scope === "user" ? config.globalLock : join(scope, projectLockName))

function parseLock(raw: RawLock): SkillLock {
  const lock: SkillLock = { skills: new Map(), lastSelectedAgents: [] }
  if (!raw || typeof raw !== "object") return lock
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
      installMode: str(entry.installMode),
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
