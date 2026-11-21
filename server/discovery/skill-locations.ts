import { readdir, readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import type { ScopeKey } from "../../shared/api.ts"
import { config } from "../config.ts"
import { isDirectory, pathExists } from "../lib/files.ts"
import type { AgentRegistry } from "./agents.ts"
import { containedSkillMd } from "./skill-files.ts"

export type LocationKind = "agent" | "plugin" | "synced" | "system"

/** One place a skill folder appears. Several can share a realPath. */
export interface SkillLocation {
  path: string
  realPath: string
  /** the skills dir the location was found in (path is a direct child) */
  root: string
  scope: ScopeKey
  /** agent ids that see the skill through this location */
  agents: string[]
  kind: LocationKind
  pluginName?: string
}

interface PluginInstall {
  scope?: string
  installPath?: string
  projectPath?: string
}

/** Finds skill folders in agent skills dirs, plugins, synced and system dirs. */
export class SkillLocator {
  constructor(private readonly agents: AgentRegistry) {}

  async user(): Promise<SkillLocation[]> {
    const jobs: Promise<SkillLocation[]>[] = []
    const globalDirs = this.agents.globalDirs()
    for (const [dir, readers] of globalDirs)
      jobs.push(this.collect(dir, "user", readers, "agent"))
    const codexSkills = join(config.codexHome, "skills")
    if (!globalDirs.has(codexSkills))
      jobs.push(this.collect(codexSkills, "user", ["codex"], "agent"))
    jobs.push(
      this.collect(join(codexSkills, ".system"), "user", ["codex"], "system")
    )
    jobs.push(this.synced())
    jobs.push(this.plugins())
    return (await Promise.all(jobs)).flat()
  }

  async project(root: string): Promise<SkillLocation[]> {
    const jobs: Promise<SkillLocation[]>[] = []
    for (const [rel, readers] of this.agents.projectDirs()) {
      // Generic dirs like "skills" are often source folders, not installs.
      const generic = !rel.startsWith(".")
      if (generic && !readers.some((id) => this.agents.isDetected(id))) continue
      jobs.push(this.collect(join(root, rel), root, readers, "agent"))
    }
    return (await Promise.all(jobs)).flat()
  }

  private async synced(): Promise<SkillLocation[]> {
    const root = join(config.claudeHome, "skills/synced")
    const groups = await readdir(root, { withFileTypes: true }).catch(() => [])
    const jobs = groups
      .filter((g) => g.isDirectory())
      .map((g) =>
        this.collect(join(root, g.name), "user", ["claude-code"], "synced")
      )
    return (await Promise.all(jobs)).flat()
  }

  // Only the installed version of each plugin, not marketplace clones.
  private async plugins(): Promise<SkillLocation[]> {
    let raw: { plugins?: Record<string, PluginInstall[]> }
    try {
      raw = JSON.parse(
        await readFile(
          join(config.claudeHome, "plugins/installed_plugins.json"),
          "utf8"
        )
      )
    } catch {
      return []
    }
    const jobs: Promise<SkillLocation[]>[] = []
    for (const [key, installs] of Object.entries(raw.plugins ?? {})) {
      const pluginName = key.split("@")[0]
      for (const install of Array.isArray(installs) ? installs : []) {
        if (typeof install.installPath !== "string") continue
        const scope =
          install.scope === "project" && install.projectPath
            ? install.projectPath
            : "user"
        const dir = join(install.installPath, "skills")
        jobs.push(
          this.collect(dir, scope, ["claude-code"], "plugin", pluginName)
        )
      }
    }
    return (await Promise.all(jobs)).flat()
  }

  private async collect(
    dir: string,
    scope: ScopeKey,
    readers: string[],
    kind: LocationKind,
    pluginName?: string
  ): Promise<SkillLocation[]> {
    const agents = this.agents.pickVisible(readers)
    const folders = await listSkillFolders(dir)
    return folders.map((f) => ({
      ...f,
      root: dir,
      scope,
      agents,
      kind,
      ...(pluginName ? { pluginName } : {}),
    }))
  }
}

/**
 * Child folders (or symlinks to folders) that hold a SKILL.md. Hidden ones
 * are skipped, and so are folders whose SKILL.md links out of the folder:
 * the server never reads a file outside a skill folder as its SKILL.md.
 */
export async function listSkillFolders(
  dir: string
): Promise<{ path: string; realPath: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return null
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return null
      const path = join(dir, entry.name)
      if (!(await pathExists(join(path, "SKILL.md")))) return null
      if (entry.isSymbolicLink() && !(await isDirectory(path))) return null
      const real = await realpath(path).catch(() => null)
      if (!real) return null
      if (!(await containedSkillMd(real))) return null
      return { path, realPath: real }
    })
  )
  return out.filter((x) => x !== null)
}
