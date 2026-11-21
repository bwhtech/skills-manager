import { lstat, rm, unlink } from "node:fs/promises"
import type { InstallRequest, Job, UpdateRunRequest } from "../shared/api.ts"
import type { SkillsCli } from "./cli/skills-cli.ts"
import { config } from "./config.ts"
import type { IndexedSkill } from "./discovery/skill-index.ts"
import { forbidden } from "./lib/errors.ts"
import type { JobLog, JobManager } from "./jobs.ts"

/** Builds and queues the jobs that change installed skills. */
export class SkillActions {
  constructor(
    private readonly cli: SkillsCli,
    private readonly jobs: JobManager
  ) {}

  install(req: InstallRequest): Job {
    const args = [
      "add",
      req.source,
      "-s",
      ...req.skills,
      "-a",
      ...req.agents,
      "-y",
    ]
    if (req.scope === "user") args.push("-g")
    const count = req.skills.length
    return this.cliJob(
      "install",
      `Install ${req.source} (${count} skill${count === 1 ? "" : "s"})`,
      args,
      req.scope
    )
  }

  update(
    req: Required<Pick<UpdateRunRequest, "scope">> & { names: string[] }
  ): Job {
    const args = [
      "update",
      ...req.names,
      req.scope === "user" ? "-g" : "-p",
      "-y",
    ]
    const what = req.names.length ? req.names.join(", ") : "all skills"
    return this.cliJob(
      "update",
      `Update ${what} (${scopeLabel(req.scope)})`,
      args,
      req.scope
    )
  }

  remove(skill: IndexedSkill): Job {
    if (skill.origin === "npx") {
      const args = ["remove", "-s", skill.cliName, "-y"]
      if (skill.scope === "user") args.push("-g")
      return this.cliJob(
        "remove",
        `Remove ${skill.cliName} (${scopeLabel(skill.scope)})`,
        args,
        skill.scope
      )
    }
    if (skill.origin !== "manual")
      throw forbidden(`${skill.origin} skills cannot be removed here`)
    return this.jobs.enqueue({
      kind: "remove",
      title: `Remove ${skill.name} (${scopeLabel(skill.scope)})`,
      command: `delete ${skill.realPath}`,
      cwd: skill.realPath,
      run: (log) => removeManual(skill, log),
    })
  }

  private cliJob(
    kind: Job["kind"],
    title: string,
    args: string[],
    scope: string
  ): Job {
    const cwd = scope === "user" ? config.home : scope
    return this.jobs.enqueue({
      kind,
      title,
      command: this.cli.display(args),
      cwd,
      run: async (log) => {
        const { exitCode, timedOut } = await this.cli.stream(
          args,
          cwd,
          log,
          config.cliTimeoutMs * 5
        )
        if (timedOut) log("Timed out; the command was stopped.")
        return exitCode
      },
    })
  }
}

/**
 * Removes a hand-made skill. Symlinks to it go first. The folder is deleted
 * only if it sits in a skills dir itself; a folder that is only linked in
 * (e.g. a checkout elsewhere) is kept.
 */
async function removeManual(skill: IndexedSkill, log: JobLog): Promise<number> {
  let ownsFolder = false
  for (const loc of skill.locations) {
    const info = await lstat(loc).catch(() => null)
    if (info?.isDirectory()) ownsFolder = true
    if (!info?.isSymbolicLink()) continue
    await unlink(loc)
    log(`Removed link ${loc}`)
  }
  if (!ownsFolder) {
    log(`Kept ${skill.realPath}: it lives outside the skills folders.`)
    return 0
  }
  if (skill.realPath === config.home || skill.realPath.split("/").length < 4) {
    log(`Refused to delete ${skill.realPath}`)
    return 1
  }
  await rm(skill.realPath, { recursive: true })
  log(`Deleted ${skill.realPath}`)
  return 0
}

function scopeLabel(scope: string): string {
  return scope === "user" ? "user" : (scope.split("/").pop() ?? scope)
}
