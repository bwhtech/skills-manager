import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import type {
  ScopeKey,
  SkillOrigin,
  SkillSource,
  SkillSummary,
} from "../../shared/api.ts"
import { encodeId } from "../../shared/api.ts"
import type { SkillsCli } from "../cli/skills-cli.ts"
import { config } from "../config.ts"
import { parseFrontmatter, stringField } from "../lib/frontmatter.ts"
import type { AgentRegistry } from "./agents.ts"
import { cliListing, type CliListed } from "./cli-listing.ts"
import { containedSkillMd } from "./skill-files.ts"
import {
  readGlobalLock,
  readProjectLock,
  toSkillSource,
  type SkillLock,
} from "./locks.ts"
import type { ProjectService } from "./projects.ts"
import {
  SkillLocator,
  type LocationKind,
  type SkillLocation,
} from "./skill-locations.ts"

/** One place a skill folder appears, with the skills dir it was found in. */
export interface SkillPlacement {
  path: string
  root: string
  scope: ScopeKey
}

/** A discovered skill. `cliName` is the name the skills CLI knows it by. */
export interface IndexedSkill extends Omit<SkillSummary, "updateAvailable"> {
  cliName: string
  folderName: string
  placements: SkillPlacement[]
}

interface ScopeContext {
  lock: SkillLock
  listed: Map<string, CliListed>
}

const KIND_PRIORITY: LocationKind[] = ["system", "synced", "plugin", "agent"]

/** All skills across scopes, deduplicated by real path, cached with a short TTL. */
export class SkillIndex {
  private cache: { at: number; skills: IndexedSkill[] } | null = null
  private building: Promise<IndexedSkill[]> | null = null
  private generation = 0
  private readonly locator: SkillLocator

  constructor(
    private readonly agents: AgentRegistry,
    private readonly projects: ProjectService,
    private readonly cli: SkillsCli
  ) {
    this.locator = new SkillLocator(agents)
  }

  /** Serves a stale list while it refreshes; after invalidate() it waits for a fresh one. */
  async all(): Promise<IndexedSkill[]> {
    if (this.cache && Date.now() - this.cache.at < config.skillCacheTtlMs)
      return this.cache.skills
    const refresh = this.refresh()
    return this.cache ? this.cache.skills : refresh
  }

  private refresh(): Promise<IndexedSkill[]> {
    if (this.building) return this.building
    const build = this.build()
    this.building = build
    build
      .finally(() => {
        if (this.building === build) this.building = null
      })
      .catch(() => {})
    return build
  }

  invalidate(): void {
    this.cache = null
    this.building = null
    this.generation++
  }

  private async build(): Promise<IndexedSkill[]> {
    const generation = this.generation
    const scopes: ScopeKey[] = ["user", ...this.projects.paths()]
    const perScope = await Promise.all(
      scopes.map((scope) => this.buildScope(scope))
    )
    const skills = dedupe(perScope.flat()).sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.realPath.localeCompare(b.realPath)
    )
    if (generation === this.generation) this.cache = { at: Date.now(), skills }
    return skills
  }

  private async buildScope(scope: ScopeKey): Promise<IndexedSkill[]> {
    const locations =
      scope === "user"
        ? await this.locator.user()
        : await this.locator.project(scope)
    if (locations.length === 0) return []
    const ctx = await this.scopeContext(scope, locations)
    const groups = groupByRealPath(locations)
    return Promise.all(
      [...groups.values()].map((locs) => this.toSkill(locs, ctx))
    )
  }

  private async scopeContext(
    scope: ScopeKey,
    locations: SkillLocation[]
  ): Promise<ScopeContext> {
    const user = scope === "user"
    const lock = user ? await readGlobalLock() : await readProjectLock(scope)
    const needsCli = locations.some((l) => l.kind === "agent")
    const listed = needsCli
      ? await cliListing(this.cli, user ? config.home : scope, user)
      : new Map()
    return { lock, listed }
  }

  private async toSkill(
    locs: SkillLocation[],
    ctx: ScopeContext
  ): Promise<IndexedSkill> {
    const first = locs[0]
    const realPath = first.realPath
    const folderName = basename(realPath)
    const meta = await readMeta(realPath)
    const name = meta.name || folderName
    const kind =
      KIND_PRIORITY.find((k) => locs.some((l) => l.kind === k)) ?? "agent"
    const listed = ctx.listed.get(realPath)
    const lockName = [folderName, meta.name, listed?.name].find(
      (n) => n && ctx.lock.skills.has(n)
    )
    const origin = originOf(
      kind,
      lockName !== undefined || listed?.tracked === true
    )
    const agents = new Set(locs.flatMap((l) => l.agents))
    for (const label of listed?.agents ?? []) {
      const id = this.agents.idForLabel(label)
      if (id) agents.add(id)
    }
    const skill: IndexedSkill = {
      id: encodeId(realPath),
      name,
      description: meta.description,
      realPath,
      locations: [...new Set(locs.map((l) => l.path))].sort(),
      agents: [...agents].sort(),
      scope: first.scope,
      scopes: [...new Set(locs.map((l) => l.scope))],
      origin,
      editable: origin === "npx" || origin === "manual",
      cliName: lockName ?? listed?.name ?? name,
      folderName,
      placements: locs.map(({ path, root, scope }) => ({ path, root, scope })),
    }
    if (origin === "npx") {
      const source = lockName
        ? toSkillSource(ctx.lock.skills.get(lockName)!)
        : listedSource(listed)
      if (source) skill.source = source
    }
    const pluginName = locs.find((l) => l.pluginName)?.pluginName
    if (origin === "plugin" && pluginName) skill.pluginName = pluginName
    return skill
  }
}

function originOf(kind: LocationKind, tracked: boolean): SkillOrigin {
  if (kind !== "agent") return kind
  return tracked ? "npx" : "manual"
}

function listedSource(listed: CliListed | undefined): SkillSource | undefined {
  if (!listed?.source) return undefined
  const out: SkillSource = { source: listed.source }
  if (listed.sourceUrl) out.sourceUrl = listed.sourceUrl
  if (listed.sourceType) out.sourceType = listed.sourceType
  return out
}

function groupByRealPath(
  locations: SkillLocation[]
): Map<string, SkillLocation[]> {
  const groups = new Map<string, SkillLocation[]>()
  for (const loc of locations)
    groups.set(loc.realPath, [...(groups.get(loc.realPath) ?? []), loc])
  return groups
}

/**
 * A project can link to a user skill. The first scope (user) stays the
 * owning `scope`; locations, agents, placements and scope membership merge.
 */
export function dedupe(skills: IndexedSkill[]): IndexedSkill[] {
  const byPath = new Map<string, IndexedSkill>()
  for (const skill of skills) {
    const existing = byPath.get(skill.realPath)
    if (!existing) {
      byPath.set(skill.realPath, skill)
      continue
    }
    existing.locations = [
      ...new Set([...existing.locations, ...skill.locations]),
    ].sort()
    existing.agents = [...new Set([...existing.agents, ...skill.agents])].sort()
    existing.scopes = [...new Set([...existing.scopes, ...skill.scopes])]
    existing.placements = [...existing.placements, ...skill.placements]
  }
  return [...byPath.values()]
}

async function readMeta(
  realPath: string
): Promise<{ name: string; description: string }> {
  try {
    const skillMd = await containedSkillMd(realPath)
    if (!skillMd) return { name: "", description: "" }
    const text = await readFile(skillMd, "utf8")
    const { data } = parseFrontmatter(text)
    return {
      name: stringField(data, "name"),
      description: stringField(data, "description"),
    }
  } catch {
    return { name: "", description: "" }
  }
}
