import { lstat, realpath, rm, unlink } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import type { InstallRequest, Job, UpdateRunRequest } from "../shared/api.ts"
import type { SkillsCli } from "./cli/skills-cli.ts"
import { config } from "./config.ts"
import type {
  IndexedSkill,
  SkillPlacement,
} from "./discovery/skill-index.ts"
import { forbidden } from "./lib/errors.ts"
import { isInside, realpathOrNull } from "./lib/files.ts"
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
      run: (log) => removeManualSkill(skill, log),
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
 * Removes a hand-made skill. A folder is deleted recursively only when it
 * really lives in an approved skills dir: the location is a plain directory
 * (not a link), and its skills dir resolves to the same path without going
 * through a symlink (neither the dir itself nor a parent between the scope
 * root and the dir). A location that is a symlink is unlinked, keeping its
 * target, but only inside such an approved dir. Anything reached through an
 * alias into another directory is left alone.
 */
export async function removeManualSkill(
  skill: Pick<IndexedSkill, "realPath" | "placements">,
  log: JobLog,
  home = config.home
): Promise<number> {
  const approved = new Map<string, boolean>()
  const isApproved = async (p: SkillPlacement) => {
    if (!approved.has(p.root))
      approved.set(p.root, await isApprovedSkillsDir(p, home))
    return approved.get(p.root)!
  }
  let removed = false
  let owner: string | null = null
  for (const placement of skill.placements) {
    const info = await lstat(placement.path).catch(() => null)
    if (!info) continue
    if (!(await isApproved(placement))) {
      log(`Kept ${placement.path}: its skills dir links outside the scope.`)
      continue
    }
    if (info.isSymbolicLink()) {
      await unlink(placement.path)
      removed = true
      log(`Removed link ${placement.path}`)
      continue
    }
    const real = await realpath(placement.path).catch(() => null)
    if (info.isDirectory() && real === skill.realPath) owner = placement.path
  }
  if (owner === null) {
    if (removed) log(`Kept ${skill.realPath}: it lives outside the skills dirs.`)
    else log(`Nothing removed: ${skill.realPath} is not in a skills dir.`)
    return removed ? 0 : 1
  }
  if (isUnsafeToDelete(owner, home)) {
    log(`Refused to delete ${owner}`)
    return 1
  }
  await rm(owner, { recursive: true })
  log(`Deleted ${owner}`)
  return 0
}

/**
 * The skills dir resolves to the path discovery expects: no component from
 * the scope root (home or the project) down to the dir is a symlink. The scope
 * root itself may sit behind a link; it is resolved once and trusted.
 */
async function isApprovedSkillsDir(
  placement: SkillPlacement,
  home: string
): Promise<boolean> {
  const root = resolve(placement.root)
  if (dirname(resolve(placement.path)) !== root) return false
  const scopeRoot = placement.scope === "user" ? home : placement.scope
  const base = isInside(scopeRoot, root) ? scopeRoot : dirname(root)
  const [realBase, realRoot] = await Promise.all([
    realpathOrNull(base),
    realpathOrNull(root),
  ])
  if (!realBase || !realRoot) return false
  return realRoot === join(realBase, relative(base, root))
}

function isUnsafeToDelete(path: string, home: string): boolean {
  const p = resolve(path)
  return p === home || isInside(p, home) || p.split("/").length < 4
}

function scopeLabel(scope: string): string {
  return scope === "user" ? "user" : (scope.split("/").pop() ?? scope)
}
