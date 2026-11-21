import { homedir } from "node:os"
import { join, resolve } from "node:path"

const home = homedir()
const root = resolve(import.meta.dir, "..")

/** Static settings, read once from the environment. */
export const config = {
  port: Number(process.env.PORT ?? 3530),
  host: process.env.HOST ?? "127.0.0.1",
  home,
  root,
  skillsBin: process.env.SKILLS_BIN ?? join(root, "node_modules/.bin/skills"),
  /** The CLI chunk that exports the agent table (skills 1.9.0 layout). */
  skillsAgentsModule: join(root, "node_modules/skills/dist/_chunks/remove.mjs"),
  stateFile: join(home, ".config/skills-manager/state.json"),
  globalLock: join(home, ".agents/.skill-lock.json"),
  canonicalSkillsDir: join(home, ".agents/skills"),
  claudeHome: process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"),
  codexHome: process.env.CODEX_HOME?.trim() || join(home, ".codex"),
  scanDepth: 4,
  /** Directories the project scan never enters. */
  scanSkipPaths: [join(home, "pilot"), "/mnt/data/cache"],
  skillCacheTtlMs: 10_000,
  cliTimeoutMs: 120_000,
}

export const projectLockName = "skills-lock.json"
