import { SkillActions } from "./actions.ts"
import { Catalog } from "./catalog.ts"
import { SkillsCli, readGithubToken } from "./cli/skills-cli.ts"
import { config } from "./config.ts"
import { AgentRegistry } from "./discovery/agents.ts"
import { InstructionService } from "./discovery/instructions.ts"
import { ProjectService } from "./discovery/projects.ts"
import { SkillIndex } from "./discovery/skill-index.ts"
import { JobManager } from "./jobs.ts"
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
}

export async function createServices(): Promise<Services> {
  const cli = new SkillsCli()
  cli.setGithubToken(readGithubToken())
  const projects = new ProjectService(new StateStore(config.stateFile))
  const [agents] = await Promise.all([AgentRegistry.load(), projects.init()])
  const skills = new SkillIndex(agents, projects, cli)
  const updates = new UpdateChecker(cli, projects)
  const jobs = new JobManager(() => {
    skills.invalidate()
    updates.start()
  })
  return {
    agents,
    projects,
    skills,
    instructions: new InstructionService(projects),
    updates,
    jobs,
    actions: new SkillActions(cli, jobs),
    catalog: new Catalog(cli),
  }
}
