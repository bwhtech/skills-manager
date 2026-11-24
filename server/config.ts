import { readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const home = homedir()
const root = resolve(import.meta.dir, "..")

/**
 * Test hook: SKILLS_MANAGER_TEST_CRASH_AFTER_STAGE=1 kills the server (SIGKILL) right after a
 * removal job has staged a group's ticked copies, to leave an interrupted removal behind.
 * Honored only when NODE_ENV=test or HOME is not the user's own home from the passwd
 * database (a fixture HOME). Never set it for the production unit.
 */
export function testCrashAllowed(env: Record<string, string | undefined>, home: string, passwdHome: string | null): boolean {
  if (env.SKILLS_MANAGER_TEST_CRASH_AFTER_STAGE !== "1") return false
  return env.NODE_ENV === "test" || (passwdHome !== null && resolve(passwdHome) !== resolve(home))
}

/**
 * The user's home from the passwd database, or null. Not os.userInfo().homedir: Bun returns
 * $HOME there, so a fixture HOME would look like the real one.
 */
function passwdHome(): string | null {
  const uid = process.getuid?.()
  if (uid === undefined) return null
  let line = ""
  try {
    const out = Bun.spawnSync(["getent", "passwd", String(uid)], { stdout: "pipe", stderr: "ignore" })
    line = out.exitCode === 0 ? out.stdout.toString().trim() : ""
  } catch {
    // No getent: fall through to /etc/passwd. If that fails too, the fixture-HOME gate stays off.
  }
  if (!line) {
    try {
      line = readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.split(":")[2] === String(uid)) ?? ""
    } catch {
      return null
    }
  }
  return line.split(":")[5] || null
}

/** Static settings, read once from the environment. */
export const config = {
  port: Number(process.env.PORT ?? 3530),
  host: process.env.HOST ?? "127.0.0.1",
  /**
   * Host names the API answers to, besides localhost, 127.0.0.1 and [::1] (any port).
   * Env SKILLS_MANAGER_ALLOWED_HOSTS (comma-separated host names, no ports). Default: none.
   */
  allowedHosts: parseList(process.env.SKILLS_MANAGER_ALLOWED_HOSTS) ?? [],
  /**
   * Folders besides HOME whose files /api/open and /api/file may show (and whose Markdown files
   * they may save). Env SKILLS_MANAGER_FILE_ROOTS (comma-separated absolute paths). Default: none.
   */
  extraFileRoots: parsePaths(process.env.SKILLS_MANAGER_FILE_ROOTS),
  home,
  root,
  skillsBin: process.env.SKILLS_BIN ?? join(root, "node_modules/.bin/skills"),
  /** The CLI chunk that exports the agent table (skills 1.9.0 layout). */
  skillsAgentsModule: join(root, "node_modules/skills/dist/_chunks/remove.mjs"),
  stateFile: join(home, ".config/skills-manager/state.json"),
  /** Test hook SKILLS_MANAGER_TEST_CRASH_AFTER_STAGE (see testCrashAllowed). */
  testCrashAfterStage:
    process.env.SKILLS_MANAGER_TEST_CRASH_AFTER_STAGE === "1" && testCrashAllowed(process.env, home, passwdHome()),
  globalLock: join(home, ".agents/.skill-lock.json"),
  canonicalSkillsDir: join(home, ".agents/skills"),
  claudeHome: process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"),
  codexHome: process.env.CODEX_HOME?.trim() || join(home, ".codex"),
  scanDepth: 4,
  /** Directories the project scan never enters. Env SKILLS_MANAGER_SCAN_SKIP (comma-separated). */
  scanSkipPaths: parsePaths(process.env.SKILLS_MANAGER_SCAN_SKIP),
  skillCacheTtlMs: 10_000,
  cliTimeoutMs: 120_000,
  /** Upstream checkouts for update previews. Wiped at startup. */
  previewCacheDir:
    process.env.SKILLS_MANAGER_PREVIEW_DIR?.trim() ||
    join(tmpdir(), "skills-manager-preview"),
  previewTtlMs: 10 * 60_000,
  previewFetchTimeoutMs: 60_000,
  previewMaxFetches: 3,
}

/** A comma-separated env value as a list, or undefined when unset or empty. */
function parseList(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean)
  return items?.length ? items : undefined
}

/** A comma-separated list of paths; `~` and `~/…` expand to HOME, relative paths are dropped. */
function parsePaths(value: string | undefined): string[] {
  return (parseList(value) ?? [])
    .map((p) => (p === "~" || p.startsWith("~/") ? join(home, p.slice(1)) : p))
    .filter((p) => p.startsWith("/"))
    .map((p) => resolve(p))
}

export const projectLockName = "skills-lock.json"
