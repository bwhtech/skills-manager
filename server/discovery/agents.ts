import { existsSync } from "node:fs"
import { join } from "node:path"
import type { AgentInfo } from "../../shared/api.ts"
import { config } from "../config.ts"

/** One entry of the skills CLI agent table. */
interface CliAgent {
  name: string
  displayName: string
  skillsDir: string
  globalSkillsDir?: string
  globalReadsCanonical?: boolean
  detectInstalled: (cwd?: string) => Promise<boolean>
}

const CANONICAL_PROJECT_DIR = ".agents/skills"

/**
 * The agents the skills CLI supports. The table is imported from the CLI
 * package itself, so ids and dirs always match the pinned CLI version.
 */
export class AgentRegistry {
  private detected = new Set<string>()

  private constructor(private readonly table: CliAgent[]) {}

  static async load(): Promise<AgentRegistry> {
    const registry = new AgentRegistry(await loadCliTable())
    await registry.refreshDetection()
    return registry
  }

  async refreshDetection(): Promise<void> {
    const results = await Promise.all(
      this.table.map(
        async (a) =>
          [
            a.name,
            await a.detectInstalled(config.home).catch(() => false),
          ] as const
      )
    )
    this.detected = new Set(results.filter(([, ok]) => ok).map(([id]) => id))
  }

  list(): AgentInfo[] {
    return this.table.map((a) => ({
      id: a.name,
      label: a.displayName,
      globalSkillsDir: a.globalSkillsDir ?? null,
      projectSkillsDir: a.skillsDir || null,
      detected: this.detected.has(a.name),
    }))
  }

  has(id: string): boolean {
    return this.table.some((a) => a.name === id)
  }

  isDetected(id: string): boolean {
    return this.detected.has(id)
  }

  idForLabel(label: string): string | undefined {
    return this.table.find((a) => a.displayName === label || a.name === label)
      ?.name
  }

  /** User-level skills dir -> agents that read it. Universal agents also read ~/.agents/skills. */
  globalDirs(): Map<string, string[]> {
    const dirs = new Map<string, string[]>()
    for (const a of this.table) {
      if (a.globalSkillsDir) addTo(dirs, a.globalSkillsDir, a.name)
      if (
        a.skillsDir === CANONICAL_PROJECT_DIR &&
        a.globalReadsCanonical !== false
      ) {
        addTo(dirs, config.canonicalSkillsDir, a.name)
      }
    }
    return dirs
  }

  /** Project-relative skills dir -> agents that read it. */
  projectDirs(): Map<string, string[]> {
    const dirs = new Map<string, string[]>()
    for (const a of this.table)
      if (a.skillsDir) addTo(dirs, a.skillsDir, a.name)
    if (!dirs.has(CANONICAL_PROJECT_DIR)) dirs.set(CANONICAL_PROJECT_DIR, [])
    return dirs
  }

  /**
   * Which of these agents see a skill. Shared dirs like ~/.agents/skills are
   * read by many agents, so only installed ones count; if none is installed,
   * keep them all so the skill is not orphaned.
   */
  pickVisible(readers: string[]): string[] {
    const installed = readers.filter((id) => this.detected.has(id))
    return installed.length > 0 ? installed : readers
  }
}

function addTo(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key) ?? []
  if (!list.includes(id)) list.push(id)
  map.set(key, list)
}

async function loadCliTable(): Promise<CliAgent[]> {
  try {
    const mod: { agents?: Record<string, CliAgent> } = await import(
      config.skillsAgentsModule
    )
    if (mod.agents && Object.keys(mod.agents).length > 0)
      return Object.values(mod.agents)
    console.warn("skills CLI agent table is empty; using fallback")
  } catch (err) {
    console.warn(
      `Could not load the skills CLI agent table: ${(err as Error).message}`
    )
  }
  return fallbackTable()
}

// Used only if the CLI's internal module layout changes.
function fallbackTable(): CliAgent[] {
  const exists = (p: string) => async () => existsSync(p)
  return [
    {
      name: "claude-code",
      displayName: "Claude Code",
      skillsDir: ".claude/skills",
      globalSkillsDir: join(config.claudeHome, "skills"),
      detectInstalled: exists(config.claudeHome),
    },
    {
      name: "codex",
      displayName: "Codex",
      skillsDir: CANONICAL_PROJECT_DIR,
      globalSkillsDir: config.canonicalSkillsDir,
      detectInstalled: exists(config.codexHome),
    },
  ]
}
