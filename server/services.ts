import { SkillActions } from "./actions.ts"
import { Catalog } from "./catalog.ts"
import { SkillsCli, readGithubToken } from "./cli/skills-cli.ts"
import { config } from "./config.ts"
import { AgentRegistry } from "./discovery/agents.ts"
import { InstructionService } from "./discovery/instructions.ts"
import type { LockReader } from "./discovery/locks.ts"
import { ProjectService } from "./discovery/projects.ts"
import { SkillIndex } from "./discovery/skill-index.ts"
import { JobManager } from "./jobs.ts"
import { UpdatePreviewService } from "./preview/service.ts"
import { RemovalGuard } from "./removal/guard.ts"
import { RemovalRecovery } from "./removal/recovery.ts"
import { StateStore } from "./state.ts"
import { UpdateChecker } from "./updates.ts"

/** Everything the routes need, wired once at boot. */
export interface Services {
  agents: AgentRegistry
  projects: ProjectService
  skills: SkillIndex
  instructions: InstructionService
  updates: UpdateChecker
  jobs: JobManager
  actions: SkillActions
  catalog: Catalog
  previews: UpdatePreviewService
  removals: RemovalGuard
  recovery: RemovalRecovery
  /** test seam: how routes read a scope's lock file (default readScopeLock) */
  readLock?: LockReader
}

export async function createServices(): Promise<Services> {
  const cli = new SkillsCli()
  const token = readGithubToken()
  cli.setGithubToken(token)
  const previews = new UpdatePreviewService(
    {
      root: config.previewCacheDir,
      ttlMs: config.previewTtlMs,
      maxConcurrent: config.previewMaxFetches,
      timeoutMs: config.previewFetchTimeoutMs,
    },
    undefined,
    token
  )
  const projects = new ProjectService(new StateStore(config.stateFile))
  const [agents] = await Promise.all([
    AgentRegistry.load(),
    projects.init(),
    previews.init(),
  ])
  const skills = new SkillIndex(agents, projects, cli)
  const updates = new UpdateChecker(cli, projects)
  const removals = new RemovalGuard({
    records: updates,
    upstream: (scope, name, entry) => previews.upstreamState(scope, name, entry),
  })
  const jobs = new JobManager(() => {
    skills.invalidate()
    updates.start()
  })
  const recovery = new RemovalRecovery({
    home: config.home,
    running: () => jobs.unfinished().map((job) => job.id),
    skillsDirs: () => removals.skillsDirs(projects.paths()),
  })
  return {
    agents,
    projects,
    skills,
    instructions: new InstructionService(projects),
    updates,
    jobs,
    actions: new SkillActions(
      cli,
      jobs,
      {
        // Both run before the job manager's re-check below starts.
        afterUpdate: (scope, names, outcome, output) => {
          previews.invalidate(scope, names)
          void updates.noteJobOutput(scope, output)
          if (outcome.ok) updates.markUpdated(scope, names, outcome.failed)
        },
        afterRemove: (scope, removed, attempted) => {
          previews.invalidate(scope, attempted)
          updates.markRemoved(scope, removed)
        },
        ...(config.testCrashAfterStage
          ? {
              stage: {
                afterGroupStaged: (paths: string[]) => {
                  console.error(`SKILLS_MANAGER_TEST_CRASH_AFTER_STAGE: killing the server after staging ${paths.join(", ")}`)
                  process.kill(process.pid, "SIGKILL")
                },
              },
            }
          : {}),
      },
      removals
    ),
    catalog: new Catalog(cli),
    previews,
    removals,
    recovery,
  }
}
