// Fixture HOMEs for removal tests: the real pinned CLI runs `skills remove` against them.
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Hono } from "hono"
import type { ScopeKey } from "../../shared/api.ts"
import { SkillActions } from "../actions.ts"
import type { SkillsCli } from "../cli/skills-cli.ts"
import { config } from "../config.ts"
import { readLock, type LockEntry, type LockReader } from "../discovery/locks.ts"
import type { ProjectService } from "../discovery/projects.ts"
import { cleanLine } from "../lib/ansi.ts"
import { handleError } from "../lib/errors.ts"
import { JobManager } from "../jobs.ts"
import type { UpstreamState } from "../preview/service.ts"
import { RemovalGuard } from "../removal/guard.ts"
import type { AgentTable, CliNameFns } from "../removal/plan.ts"
import { updateRoutes } from "../routes/updates.ts"
import type { Services } from "../services.ts"
import { UpdateChecker } from "../updates.ts"

const CLI_BIN = join(config.root, "node_modules/skills/bin/cli.mjs")

export type Reply = { exitCode: number; lines: string[] }

export interface Fixture {
  home: string
  lockPath: string
  readLock: LockReader
  skill(dir: string, name: string): Promise<string>
  link(path: string, target: string): Promise<void>
  writeLock(entries: Record<string, Partial<LockEntry>>): Promise<void>
  /** the CLI's agent table and name helpers as the CLI sees them with HOME = home */
  loadCli(): Promise<{ agents: AgentTable } & CliNameFns>
}

export async function makeFixture(): Promise<Fixture> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "sm-remove-")))
  await mkdir(join(home, ".agents/skills"), { recursive: true })
  await mkdir(join(home, ".claude/skills"), { recursive: true })
  await mkdir(join(home, ".codex"), { recursive: true })
  const lockPath = join(home, ".agents/.skill-lock.json")
  return {
    home,
    lockPath,
    readLock: (scope) => readLock(scope === "user" ? lockPath : join(scope, "skills-lock.json")),
    async skill(dir, name) {
      const path = join(home, dir, name)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, "SKILL.md"), `---\nname: ${JSON.stringify(name)}\ndescription: test\n---\n`)
      return path
    },
    async link(path, target) {
      await mkdir(dirname(path), { recursive: true })
      await symlink(target, path)
    },
    async writeLock(entries) {
      const skills: Record<string, Partial<LockEntry>> = {}
      for (const [name, entry] of Object.entries(entries))
        skills[name] = {
          source: "owner/repo",
          sourceType: "github",
          sourceUrl: "https://github.com/owner/repo.git",
          skillPath: `skills/${name}/SKILL.md`,
          skillFolderHash: "abc",
          ...entry,
        }
      await writeFile(lockPath, JSON.stringify({ version: 3, skills, dismissed: {} }, null, 2))
    },
    loadCli: () => cliTable(home),
  }
}

/** The agent table from a CLI process with HOME = home; detection is a snapshot. */
async function cliTable(home: string): Promise<{ agents: AgentTable } & CliNameFns> {
  const code = `const m = await import(${JSON.stringify(config.skillsAgentsModule)});
const out = {};
for (const [id, a] of Object.entries(m.agents)) out[id] = { name: a.name, displayName: a.displayName,
  skillsDir: a.skillsDir, globalSkillsDir: a.globalSkillsDir, globalReadsCanonical: a.globalReadsCanonical,
  detected: await a.detectInstalled(process.cwd()).catch(() => false) };
console.log(JSON.stringify(out));`
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: home,
    env: { ...cleanEnv(), HOME: home },
    stdout: "pipe",
    stderr: "inherit",
  })
  const raw = JSON.parse(await new Response(proc.stdout).text()) as Record<
    string,
    { detected: boolean } & Omit<AgentTable[string], "detectInstalled">
  >
  const agents: AgentTable = {}
  for (const [id, { detected, ...rest }] of Object.entries(raw))
    agents[id] = { ...rest, detectInstalled: async () => detected }
  const mod = (await import(config.skillsAgentsModule)) as CliNameFns
  return { agents, sanitizeName: mod.sanitizeName, resolveSkillsToRemove: mod.resolveSkillsToRemove }
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("XDG_") && k !== "CLAUDE_CONFIG_DIR" && k !== "CODEX_HOME")
      env[k] = v
  return { ...env, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", FORCE_COLOR: "0" }
}

/**
 * A CLI stand-in: `remove` runs the real pinned CLI with HOME = home; other subcommands
 * print `replies[sub]`. `before[sub]` runs first (to change the disk mid-job). Calls are kept.
 */
export function hybridCli(
  home: string,
  replies: Record<string, Reply>,
  before: Record<string, () => Promise<void> | void> = {}
) {
  const calls: string[][] = []
  const run = async (args: string[], cwd: string, onLine: (line: string) => void) => {
    calls.push(args)
    await before[args[0]]?.()
    if (args[0] !== "remove") {
      const reply = replies[args[0]] ?? { exitCode: 0, lines: [] }
      for (const line of reply.lines) onLine(line)
      return { exitCode: reply.exitCode, timedOut: false }
    }
    const proc = Bun.spawn([process.execPath, CLI_BIN, ...args], {
      cwd: cwd === config.home ? home : cwd,
      env: { ...cleanEnv(), HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    for (const line of `${out}\n${err}`.split("\n")) if (line.trim()) onLine(cleanLine(line))
    return { exitCode: await proc.exited, timedOut: false }
  }
  const cli = {
    display: (args: string[]) => ["skills", ...args].join(" "),
    stream: run,
    capture: async (args: string[], cwd: string) => {
      const lines: string[] = []
      const res = await run(args, cwd, (l) => lines.push(l))
      return { ...res, output: lines.join("\n") }
    },
  } as unknown as SkillsCli
  return { cli, calls }
}

export function deletedCheck(source: string, deleted: string[], ambiguous: string[] = []): Reply {
  return {
    exitCode: 0,
    lines: [
      "Checking for skill updates…",
      `Checking skills from source: ${source}`,
      ...(deleted.length
        ? [
            `Warning: The following skills from ${source} appear to have been deleted upstream:`,
            ...deleted.map((n) => `  • ${n}`),
            "Skipping deletion in non-interactive mode.",
          ]
        : []),
      ...(ambiguous.length
        ? [
            `Warning: Multiple current paths match these skills from ${source}; skipping them rather than deleting or migrating the wrong skill:`,
            ...ambiguous.map((n) => `  • ${n}`),
          ]
        : []),
    ],
  }
}

export interface Wired {
  updates: UpdateChecker
  jobs: JobManager
  actions: SkillActions
  guard: RemovalGuard
  calls: string[][]
  upstream: { state: UpstreamState | Error; asked: string[] }
  run(body: unknown): Promise<Response>
  status(): Promise<import("../../shared/api.ts").UpdateStatus>
}

/** Checker, guard, actions and the /updates routes wired like services.ts, over a fixture. */
export async function wire(
  fx: Fixture,
  replies: Record<string, Reply>,
  before: Record<string, () => Promise<void> | void> = {}
): Promise<Wired> {
  const { cli, calls } = hybridCli(fx.home, replies, before)
  const projects = { paths: () => [], has: () => false } as unknown as ProjectService
  const updates = new UpdateChecker(cli, projects, fx.readLock)
  const upstream: Wired["upstream"] = { state: "deleted", asked: [] }
  const guard = new RemovalGuard({
    home: fx.home,
    loadCli: fx.loadCli,
    readLock: fx.readLock,
    records: updates,
    upstream: async (_scope: ScopeKey, name: string) => {
      upstream.asked.push(name)
      if (upstream.state instanceof Error) throw upstream.state
      return upstream.state
    },
  })
  const jobs = new JobManager(() => {})
  const actions = new SkillActions(
    cli,
    jobs,
    {
      afterUpdate: (scope, names, outcome, output) => {
        void updates.noteJobOutput(scope, output)
        if (outcome.ok) updates.markUpdated(scope, names, outcome.failed)
      },
      afterRemove: (scope, removed) => updates.markRemoved(scope, removed),
    },
    guard,
    fx.readLock
  )
  updates.start()
  while (updates.get().checking) await Bun.sleep(1)
  const app = new Hono()
  app.onError(handleError)
  app.route(
    "/",
    updateRoutes({ updates, projects, actions, removals: guard, readLock: fx.readLock } as unknown as Services)
  )
  return {
    updates,
    jobs,
    actions,
    guard,
    calls,
    upstream,
    run: async (body) =>
      app.request("/updates/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    status: async () => (await (await app.request("/updates")).json()) as import("../../shared/api.ts").UpdateStatus,
  }
}

export async function settle(jobs: JobManager) {
  while (jobs.unfinished().length) await Bun.sleep(5)
  await Bun.sleep(5)
}

/** The willDelete lists from GET /updates, as UpdateRunRequest.removePlans. */
export async function shownPlans(w: Wired, names: string[]) {
  const status = await w.status()
  return names.map((name) => ({
    name,
    willDelete: status.removalPlans?.find((p) => p.name === name)?.willDelete ?? [],
  }))
}
