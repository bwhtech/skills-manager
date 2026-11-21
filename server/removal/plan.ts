import { readdirSync } from "node:fs"
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { RemovalPlan, ScopeKey } from "../../shared/api.ts"
import type { SkillLock } from "../discovery/locks.ts"

/** One entry of the skills CLI agent table (skills 1.9.0, _chunks/remove.mjs `agents`). */
export interface CliAgentDef {
  name: string
  displayName?: string
  skillsDir: string
  globalSkillsDir?: string
  globalReadsCanonical?: boolean
  detectInstalled: (cwd?: string) => Promise<boolean>
}

export type AgentTable = Record<string, CliAgentDef>

/** The pure helpers of the pinned CLI that removeCommand resolves names with. */
export interface CliNameFns {
  sanitizeName(name: string): string
  resolveSkillsToRemove(
    requested: string[],
    folderNames: string[],
    lockKeys: string[],
    sourceByKey: Record<string, string | undefined>
  ): string[]
}

/** Everything a plan reads. Production passes the CLI's own table and functions. */
export interface RemovalEnv {
  scope: ScopeKey
  home: string
  agents: AgentTable
  cli: CliNameFns
  /** the scope's lock file, read just before planning */
  lock: SkillLock
}

export type BlockCode =
  | "invalid_name"
  | "not_locked"
  | "collision"
  | "still_used"
  | "no_target"

/** A plan plus what the server needs to run it. */
export interface PlannedRemoval extends RemovalPlan {
  /** the agents to pass with -a; empty when blocked */
  agents: string[]
  blockCode?: BlockCode
}

const CANONICAL = join(".agents", "skills")
const EVE_SUBAGENTS = join("agent", "subagents")

/**
 * What `skills remove -s <name> -a <agents> -y [-g]` would delete, for each name. Mirrors
 * removeCommand and removeInstalledSkills in skills 1.9.0 (_chunks/remove.mjs):
 *
 * - Names resolve through resolveSkillsToRemove, which indexes folder names and lock keys by
 *   sanitizeName (later keys win). A name that shares its sanitized form with another lock
 *   key, or resolves to anything but itself, is blocked ("collision").
 * - For each agent passed with -a, the CLI rm -rf's its install path and, at user scope,
 *   join(globalSkillsDir, sanitized) (in a project: join(cwd, skillsDir, sanitized), and the
 *   eve subagent dirs). It never checks what those paths are. So -a lists only agents whose
 *   existing paths are all the canonical folder or links to it. Anything else is kept.
 * - The canonical folder and the lock entry go only when no installed agent outside -a still
 *   has its install path. When one does (an independent copy), the CLI keeps both and still
 *   says "Successfully removed": the plan is blocked ("still_used") instead.
 */
export async function planRemovals(
  env: RemovalEnv,
  names: string[]
): Promise<PlannedRemoval[]> {
  const ctx = await context(env)
  const plans: PlannedRemoval[] = []
  for (const name of names) plans.push(await planOne(env, ctx, name))
  return plans
}

interface Context {
  global: boolean
  cwd: string
  lockKeys: string[]
  folders: string[]
  sourceByKey: Record<string, string | undefined>
  detected: Set<string>
}

async function context(env: RemovalEnv): Promise<Context> {
  const global = env.scope === "user"
  const cwd = global ? env.home : env.scope
  const lockKeys = [...env.lock.skills.keys()]
  const sourceByKey = Object.fromEntries(
    lockKeys.map((key) => [key, env.lock.skills.get(key)?.source])
  )
  const detected = new Set<string>()
  await Promise.all(
    Object.entries(env.agents).map(async ([id, agent]) => {
      if (await agent.detectInstalled(cwd).catch(() => false)) detected.add(id)
    })
  )
  return {
    global,
    cwd,
    lockKeys,
    folders: await scanInstalledNames(env, global, cwd),
    sourceByKey,
    detected,
  }
}

async function planOne(
  env: RemovalEnv,
  ctx: Context,
  name: string
): Promise<PlannedRemoval> {
  const blocked = (blockCode: BlockCode, reason: string, kept: Kept[] = []) => ({
    scope: env.scope,
    name,
    willDelete: [],
    kept,
    blocked: reason,
    blockCode,
    agents: [],
  })
  const invalid = invalidNameReason(name)
  if (invalid) return blocked("invalid_name", invalid)
  if (!env.lock.skills.has(name))
    return blocked("not_locked", `${name} is not in the lock file of this scope`)
  const sanitized = env.cli.sanitizeName(name)
  const clash = ctx.lockKeys.find(
    (key) => key !== name && env.cli.sanitizeName(key) === sanitized
  )
  if (clash !== undefined)
    return blocked(
      "collision",
      `"${name}" and the lock key "${clash}" both map to the folder name "${sanitized}"; skills remove could act on the wrong skill`
    )
  const resolved = env.cli.resolveSkillsToRemove(
    [name],
    ctx.folders,
    ctx.lockKeys,
    ctx.sourceByKey
  )
  if (resolved.length !== 1 || resolved[0] !== name)
    return blocked(
      "collision",
      `skills remove would resolve "${name}" to ${resolved.length ? resolved.map((r) => `"${r}"`).join(", ") : "nothing"}`
    )

  const canonical = join(canonicalDir(ctx.global, ctx.cwd, env.home), sanitized)
  const canonicalInfo = await lstat(canonical).catch(() => null)
  const canonicalReal = await realpath(canonical).catch(() => null)
  const verdicts = new Map<string, Verdict>()
  const verdict = async (path: string) => {
    let v = verdicts.get(path)
    if (!v) {
      v = await classify(path, canonical, canonicalReal)
      verdicts.set(path, v)
    }
    return v
  }

  interface AgentView {
    id: string
    label: string
    existing: string[]
    safe: boolean
    installPath: string
    installExists: boolean
  }
  const views: AgentView[] = []
  for (const [id, agent] of Object.entries(env.agents)) {
    const installPath = join(agentBaseDir(agent, ctx.global, ctx.cwd, env.home), sanitized)
    const existing: string[] = []
    let safe = true
    for (const path of cleanupPaths(env, agent, id, sanitized, installPath, ctx)) {
      if (path === canonical) continue
      const v = await verdict(path)
      if (v.kind === "missing") continue
      existing.push(path)
      if (v.kind !== "safe") safe = false
    }
    views.push({
      id,
      label: agent.displayName ?? id,
      existing,
      safe,
      installPath,
      installExists: !!(await lstat(installPath).catch(() => null)),
    })
  }

  const targets = views.filter(
    (v) => v.safe && (v.existing.length > 0 || (ctx.detected.has(v.id) && v.installExists))
  )
  const targetIds = new Set(targets.map((v) => v.id))
  const kept: Kept[] = []
  for (const [path, v] of verdicts)
    if (v.kind === "independent") kept.push({ path, reason: v.reason })
  kept.sort((a, b) => a.path.localeCompare(b.path))

  // removeInstalledSkills: an installed agent outside -a that still has its install path.
  const stillUsed = views.filter(
    (v) => ctx.detected.has(v.id) && !targetIds.has(v.id) && v.installExists
  )
  if (stillUsed.length > 0) {
    const by = stillUsed[0]
    const keptAll = canonicalInfo
      ? [
          ...kept,
          {
            path: canonical,
            reason: `the skills CLI keeps the canonical folder and the lock entry while ${by.label} still has ${by.installPath}`,
          },
        ]
      : kept
    return blocked(
      "still_used",
      `${by.label} has an independent folder at ${by.installPath}. The skills CLI would keep ${canonical} and the lock entry while it exists, so nothing can be removed cleanly. Move or delete that folder by hand first.`,
      keptAll
    )
  }

  let agents = targets.map((v) => v.id)
  if (agents.length === 0) {
    // -a needs one agent; without it the CLI targets every agent. Any agent with nothing on
    // disk under this name is a no-op target.
    const idle = views.find((v) => v.id === "universal" && v.existing.length === 0) ??
      views.find((v) => v.existing.length === 0)
    if (!idle) return blocked("no_target", "No agent can be targeted without touching another folder", kept)
    agents = [idle.id]
  }
  const willDelete = new Set<string>()
  for (const v of targets) for (const path of v.existing) willDelete.add(path)
  if (canonicalInfo) willDelete.add(canonical)
  return {
    scope: env.scope,
    name,
    willDelete: [...willDelete].sort(),
    kept,
    agents,
  }
}

interface Kept {
  path: string
  reason: string
}

type Verdict =
  | { kind: "missing" }
  | { kind: "safe" }
  | { kind: "independent"; reason: string }

/**
 * The canonical folder (also through a linked parent dir), a link to it (also a dangling one),
 * or something else, which is never ours to delete.
 */
async function classify(
  path: string,
  canonical: string,
  canonicalReal: string | null
): Promise<Verdict> {
  const info = await lstat(path).catch(() => null)
  if (!info) return { kind: "missing" }
  const real = await realpath(path).catch(() => null)
  if (canonicalReal && real === canonicalReal) return { kind: "safe" }
  if (info.isSymbolicLink()) {
    const target = resolve(dirname(path), await readlink(path).catch(() => ""))
    if (target === canonical) return { kind: "safe" }
    return {
      kind: "independent",
      reason: real ? `link to another folder (${real})` : `broken link to ${target}`,
    }
  }
  if (info.isDirectory()) return { kind: "independent", reason: "independent copy" }
  return { kind: "independent", reason: "not a skill folder" }
}

/** Why the CLI must never get this name: a flag look-alike or a control character. */
export function invalidNameReason(name: string): string | null {
  if (name.length === 0 || name.length > 255) return "name is empty or too long"
  if (name.startsWith("-")) return "name starts with -"
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name))
    return "name has a control character or a line break"
  return null
}

/** getCanonicalSkillsDir */
function canonicalDir(global: boolean, cwd: string, home: string): string {
  return join(global ? home : cwd, CANONICAL)
}

function isUniversal(agent: CliAgentDef): boolean {
  return agent.skillsDir === ".agents/skills"
}

/** getAgentBaseDir (without an eve subagent) */
function agentBaseDir(
  agent: CliAgentDef,
  global: boolean,
  cwd: string,
  home: string
): string {
  const readsCanonical = global
    ? isUniversal(agent) && agent.globalReadsCanonical !== false
    : isUniversal(agent)
  if (readsCanonical) return canonicalDir(global, cwd, home)
  if (global) return agent.globalSkillsDir ?? join(home, agent.skillsDir)
  return join(cwd, agent.skillsDir)
}

/** pathsToCleanup in removeInstalledSkills, for one agent. */
function cleanupPaths(
  env: RemovalEnv,
  agent: CliAgentDef,
  id: string,
  sanitized: string,
  installPath: string,
  ctx: Context
): string[] {
  const paths = new Set([installPath])
  if (ctx.global && agent.globalSkillsDir) paths.add(join(agent.globalSkillsDir, sanitized))
  else {
    paths.add(join(ctx.cwd, agent.skillsDir, sanitized))
    if (id === "eve")
      for (const sub of eveSubagents(ctx.cwd))
        paths.add(join(eveSkillsDir(env, ctx.cwd, sub), sanitized))
  }
  return [...paths]
}

/** getEveSubagentSkillsDir */
function eveSkillsDir(env: RemovalEnv, cwd: string, subagent: string): string {
  return join(cwd, EVE_SUBAGENTS, env.cli.sanitizeName(subagent), "skills")
}

/** getEveSubagents */
function eveSubagents(cwd: string): string[] {
  try {
    return readdirSync(join(cwd, EVE_SUBAGENTS), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** scanInstalledSkillNames: folder names (with a SKILL.md) in every skills dir of the scope. */
async function scanInstalledNames(
  env: RemovalEnv,
  global: boolean,
  cwd: string
): Promise<string[]> {
  const names = new Set<string>()
  const scan = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const path = join(dir, entry.name)
      const isDir =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && !!(await stat(path).catch(() => null))?.isDirectory())
      if (!isDir) continue
      if (!(await stat(join(path, "SKILL.md")).catch(() => null))?.isFile()) continue
      names.add(entry.name)
    }
  }
  await scan(canonicalDir(global, cwd, env.home))
  for (const agent of Object.values(env.agents)) {
    if (global) {
      if (agent.globalSkillsDir !== undefined) await scan(agent.globalSkillsDir)
    } else await scan(join(cwd, agent.skillsDir))
  }
  if (!global)
    for (const sub of eveSubagents(cwd)) await scan(eveSkillsDir(env, cwd, sub))
  return [...names].sort()
}
