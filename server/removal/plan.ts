import { readdirSync } from "node:fs"
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import type { RemovalCopy, RemovalPlan, ScopeKey } from "../../shared/api.ts"
import { verifiedSkillsDir } from "../actions.ts"
import { config } from "../config.ts"
import { lockFingerprint, type LockEntry, type SkillLock } from "../discovery/locks.ts"
import { isDotProjectDir } from "../discovery/skill-locations.ts"
import { HttpError } from "../lib/errors.ts"
import { isInside } from "../lib/files.ts"
import { collectFiles, diffLocalFolders, type DiffLimits } from "../preview/folder-diff.ts"
import { PREVIEW_LIMITS } from "../preview/limits.ts"

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
  /** computeSkillFolderHash: the hash a project lock stores as computedHash */
  computeSkillFolderHash?(dir: string): Promise<string>
}

/** Everything a plan reads. Production passes the CLI's own table and functions. */
export interface RemovalEnv {
  scope: ScopeKey
  home: string
  agents: AgentTable
  cli: CliNameFns
  /** the scope's lock file, read just before planning */
  lock: SkillLock
  /**
   * "cleanup" (default): a deleted-upstream removal, where every independent copy is opt-in.
   * "remove": an explicit Remove of the skill, where a copy that matches what the CLI
   * installed for the lock entry is part of the install (see CopyJudge.matchesInstall).
   */
  intent?: RemovalIntent
  /** per name: ticked copies, planned as if they were already deleted */
  gone?: ReadonlyMap<string, Iterable<string>>
  /** test seam: the folder comparison limits (default PREVIEW_LIMITS) */
  diffLimits?: DiffLimits
}

export type RemovalIntent = "cleanup" | "remove"

export type BlockCode =
  | "invalid_name"
  | "not_locked"
  | "collision"
  | "still_used"
  | "no_target"
  | "copies"

/** A plan plus what the server needs to run it. */
export interface PlannedRemoval extends RemovalPlan {
  intent: RemovalIntent
  /** the agents to pass with -a; empty when blocked */
  agents: string[]
  blockCode?: BlockCode
  copies: RemovalCopy[]
  /** ticked copies (env.gone that are copies of this plan): deleted before skills remove */
  deleteCopies: string[]
  /** lockFingerprint of the entry the plan was made from ("" when not locked) */
  fingerprint: string
  /**
   * Every existing path skills remove could look at for this name (each agent's cleanup paths,
   * eve subagent dirs, the canonical folder), with its verdict; ticked copies left out.
   */
  candidates: Candidate[]
}

export interface Candidate {
  path: string
  kind: "safe" | "copy" | "independent" | "canonical"
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
 * - Independent copies in a verified agent skills dir are listed in `copies`, never in
 *   willDelete. A name blocked only by copies is "copies" (blockedUnlessCopies): planned with
 *   those copies gone (env.gone), it is a normal plan.
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
  const entry = env.lock.skills.get(name)
  const base = {
    scope: env.scope,
    name,
    intent: env.intent ?? "cleanup",
    fingerprint: entry ? lockFingerprint(name, entry) : "",
  }
  const blocked = (
    blockCode: BlockCode,
    reason: string,
    kept: Kept[] = [],
    copies: RemovalCopy[] = []
  ): PlannedRemoval => ({
    ...base,
    willDelete: [],
    kept,
    copies,
    blocked: reason,
    blockCode,
    agents: [],
    deleteCopies: [],
    candidates: [],
  })
  const invalid = invalidNameReason(name)
  if (invalid) return blocked("invalid_name", invalid)
  if (!entry) return blocked("not_locked", `${name} is not in the lock file of this scope`)
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
  const canonicalIsDir = !!(await stat(canonical).catch(() => null))?.isDirectory()
  const judge = new CopyJudge(env, ctx, entry, canonicalIsDir ? canonical : null)
  const verdicts = new Map<string, Verdict>()
  const verdict = async (path: string) => {
    let v = verdicts.get(path)
    if (!v) {
      v = await classify(path, canonical, canonicalReal, judge)
      verdicts.set(path, v)
    }
    return v
  }
  const owners = new Map<string, string[]>()

  const evaluate = async (gone: ReadonlySet<string>): Promise<Evaluation> => {
    const views: AgentView[] = []
    for (const [id, agent] of Object.entries(env.agents)) {
      const label = agent.displayName ?? id
      const installPath = join(agentBaseDir(agent, ctx.global, ctx.cwd, env.home), sanitized)
      const existing: string[] = []
      let safe = true
      for (const path of cleanupPaths(env, agent, id, sanitized, installPath, ctx)) {
        if (path === canonical) continue
        const labels = owners.get(path) ?? []
        if (!labels.includes(label)) owners.set(path, [...labels, label])
        if (gone.has(path)) continue
        const v = await verdict(path)
        if (v.kind === "missing") continue
        existing.push(path)
        if (v.kind !== "safe") safe = false
      }
      views.push({
        id,
        label,
        existing,
        safe,
        installPath,
        installExists: !gone.has(installPath) && !!(await lstat(installPath).catch(() => null)),
      })
    }
    const targets = views.filter(
      (v) => v.safe && (v.existing.length > 0 || (ctx.detected.has(v.id) && v.installExists))
    )
    const targetIds = new Set(targets.map((v) => v.id))
    // removeInstalledSkills: an installed agent outside -a that still has its install path.
    const stillUsed = views.filter(
      (v) => ctx.detected.has(v.id) && !targetIds.has(v.id) && v.installExists
    )
    const candidates: Candidate[] = []
    for (const [path, v] of verdicts)
      if (v.kind !== "missing" && !gone.has(path)) candidates.push({ path, kind: v.kind })
    if (canonicalInfo) candidates.push({ path: canonical, kind: "canonical" })
    candidates.sort((a, b) => a.path.localeCompare(b.path))
    return { views, targets, stillUsed, candidates }
  }

  const real = await evaluate(new Set())
  const copyPaths = [...verdicts].filter(([, v]) => v.kind === "copy").map(([path]) => path)
  const ticked = new Set([...(env.gone?.get(name) ?? [])].filter((p) => copyPaths.includes(p)))
  const blocking = new Set(
    real.stillUsed.flatMap((v) => v.existing.filter((p) => verdicts.get(p)?.kind === "copy"))
  )
  const kept: Kept[] = []
  const copies: RemovalCopy[] = []
  for (const [path, v] of verdicts) {
    if (v.kind === "independent") kept.push({ path, reason: v.reason })
    if (v.kind === "copy")
      copies.push({
        path,
        agent: (owners.get(path) ?? []).join(", "),
        ...v.info,
        blocking: blocking.has(path),
      })
  }
  kept.sort((a, b) => a.path.localeCompare(b.path))
  copies.sort((a, b) => a.path.localeCompare(b.path))

  const finish = (e: Evaluation, extra: Partial<PlannedRemoval> = {}): PlannedRemoval | null => {
    let agents = e.targets.map((v) => v.id)
    if (agents.length === 0) {
      // -a needs one agent; without it the CLI targets every agent. Any agent with nothing on
      // disk under this name is a no-op target.
      const idle =
        e.views.find((v) => v.id === "universal" && v.existing.length === 0) ??
        e.views.find((v) => v.existing.length === 0)
      if (!idle) return null
      agents = [idle.id]
    }
    const willDelete = new Set<string>()
    for (const v of e.targets) for (const path of v.existing) willDelete.add(path)
    if (canonicalInfo) willDelete.add(canonical)
    return {
      ...base,
      willDelete: [...willDelete].sort(),
      kept,
      copies,
      agents,
      deleteCopies: [...ticked].sort(),
      candidates: e.candidates,
      ...extra,
    }
  }
  const noTarget = () =>
    blocked("no_target", "No agent can be targeted without touching another folder", kept, copies)

  const used = ticked.size ? await evaluate(ticked) : real
  if (used.stillUsed.length === 0) return finish(used) ?? noTarget()

  const by = real.stillUsed[0]
  const unlock = blocking.size ? await evaluate(new Set([...blocking, ...ticked])) : null
  if (unlock && unlock.stillUsed.length === 0) {
    const missing = [...blocking].filter((p) => !ticked.has(p)).sort()
    const plan = finish(unlock, {
      blocked: `Tick its separate ${missing.length === 1 ? "copy" : "copies"} to remove it: while ${by.label} has its own folder at ${by.installPath}, the skills CLI keeps ${canonical} and the lock entry.`,
      blockCode: "copies",
      blockedUnlessCopies: true,
    })
    if (plan) return { ...plan, agents: [], deleteCopies: [] }
  }
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
    keptAll,
    copies
  )
}

interface AgentView {
  id: string
  label: string
  existing: string[]
  safe: boolean
  installPath: string
  installExists: boolean
}

interface Evaluation {
  views: AgentView[]
  targets: AgentView[]
  stillUsed: AgentView[]
  candidates: Candidate[]
}

interface Kept {
  path: string
  reason: string
}

type CopyInfo = Omit<RemovalCopy, "path" | "agent" | "blocking">

type Verdict =
  | { kind: "missing" }
  | { kind: "safe" }
  | { kind: "copy"; info: CopyInfo }
  | { kind: "independent"; reason: string }

/**
 * The canonical folder (also through a linked parent dir), a link to it (also a dangling one),
 * an independent copy that may be offered for deletion, or something else, which is never ours
 * to delete. In an explicit Remove, a copy that matches the install is part of it ("safe").
 */
async function classify(
  path: string,
  canonical: string,
  canonicalReal: string | null,
  judge: CopyJudge
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
  if (!info.isDirectory()) return { kind: "independent", reason: "not a skill folder" }
  const why = await judge.notOffered(path)
  if (why) return { kind: "independent", reason: why }
  const copy = await judge.compare(path)
  if (judge.explicit && (await judge.matchesInstall(path, copy))) return { kind: "safe" }
  return { kind: "copy", info: copy }
}

/**
 * Which independent folders may be offered as copies, and how they compare with the canonical
 * folder. Offered: a real folder with a SKILL.md, directly in a skills dir inside the scope
 * root (home or the project) that verifiedSkillsDir accepts, not in a plugin, synced or system
 * dir, and in a project only under a dot folder (.claude/skills, .agents/skills).
 */
class CopyJudge {
  readonly explicit: boolean
  private readonly scopeRoot: string
  private readonly protectedDirs: string[]

  constructor(
    private readonly env: RemovalEnv,
    private readonly ctx: Context,
    private readonly entry: LockEntry,
    private readonly canonical: string | null
  ) {
    this.explicit = env.intent === "remove"
    this.scopeRoot = ctx.global ? env.home : ctx.cwd
    const real = env.home === config.home
    const claude = [join(env.home, ".claude"), ...(real ? [config.claudeHome] : [])]
    const codex = [join(env.home, ".codex"), ...(real ? [config.codexHome] : [])]
    this.protectedDirs = [
      ...claude.flatMap((dir) => [join(dir, "skills/synced"), join(dir, "plugins")]),
      ...codex.map((dir) => join(dir, "skills/.system")),
    ]
  }

  async notOffered(path: string): Promise<string | null> {
    const root = dirname(path)
    if (root === this.scopeRoot || !isInside(this.scopeRoot, root))
      return "independent copy outside the agent skills dirs of this scope"
    if (!this.ctx.global && !isDotProjectDir(relative(this.ctx.cwd, root)))
      return "independent copy in a project folder that is not an agent install dir"
    if (this.protectedDirs.some((dir) => isInside(dir, path)))
      return "independent copy in a plugin, synced or system dir"
    if (!(await verifiedSkillsDir({ path, root, scope: this.env.scope }, this.env.home)))
      return "independent copy in a skills dir that links elsewhere"
    if (!(await lstat(join(path, "SKILL.md")).catch(() => null))?.isFile())
      return "independent folder without a SKILL.md"
    return null
  }

  /** The copy against the canonical folder, by files and bytes, with the preview's limits. */
  async compare(path: string): Promise<CopyInfo> {
    const limits = this.env.diffLimits ?? PREVIEW_LIMITS
    if (!this.canonical) {
      const files = await this.count(path)
      return { identical: false, ...files, reason: "no canonical folder to compare with" }
    }
    try {
      const diff = await diffLocalFolders(this.canonical, path, limits)
      const n = diff.files.length
      return n === 0
        ? { identical: true, files: diff.fileCount }
        : { identical: false, files: diff.fileCount, differences: n, reason: `${n === 1 ? "1 file differs" : `${n} files differ`}` }
    } catch (err) {
      const files = await this.count(path)
      if (err instanceof HttpError && err.status === 413)
        return { identical: false, ...files, tooLarge: true, reason: "too large to compare" }
      return { identical: false, ...files, reason: `could not compare (${(err as Error).message})` }
    }
  }

  /**
   * Explicit Remove: the copy is what the CLI installed for this lock entry. Never when the
   * lock says the CLI installed links (installMode "symlink"): a real folder is then not its
   * doing. Otherwise its files equal the canonical folder (copy mode with a universal agent),
   * or, without a canonical folder, its CLI folder hash (computeSkillFolderHash) equals the
   * hash the lock recorded for the install: a project lock's computedHash, or a global lock's
   * skillFolderHash where the CLI stores its own folder hash (a 64-hex SHA-256; GitHub sources
   * store a 40-hex Git tree hash instead, which is not compared).
   */
  async matchesInstall(path: string, copy: CopyInfo): Promise<boolean> {
    if (this.entry.installMode === "symlink") return false
    if (this.canonical) return copy.identical
    const hash = this.env.cli.computeSkillFolderHash
    const recorded = [this.entry.computedHash, this.entry.skillFolderHash].filter(
      (h): h is string => !!h && /^[0-9a-f]{64}$/.test(h)
    )
    if (recorded.length === 0 || !hash || copy.tooLarge) return false
    const size = await this.count(path)
    if (size.tooLarge) return false
    const actual = await hash(path).catch(() => null)
    return !!actual && recorded.includes(actual)
  }

  private async count(path: string): Promise<{ files: number; tooLarge?: boolean }> {
    const max = (this.env.diffLimits ?? PREVIEW_LIMITS).maxFilesPerSide
    try {
      return { files: (await collectFiles(path, { maxFiles: max })).size }
    } catch {
      return { files: max, tooLarge: true }
    }
  }
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
