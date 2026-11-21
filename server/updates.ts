import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ScopeKey, UpdateStatus } from "../shared/api.ts"
import { parseCheckOutput } from "./cli/parsers.ts"
import type { SkillsCli } from "./cli/skills-cli.ts"
import { config, projectLockName } from "./config.ts"
import type { ProjectService } from "./discovery/projects.ts"

/**
 * Runs `skills check` for the user scope and every project with a
 * skills-lock.json. One check at a time; a request during a check queues
 * one more run.
 */
export class UpdateChecker {
  private status: UpdateStatus = {
    checking: false,
    checkedAt: null,
    available: [],
    error: null,
  }
  private again = false

  constructor(
    private readonly cli: SkillsCli,
    private readonly projects: ProjectService
  ) {}

  get(): UpdateStatus {
    return { ...this.status, available: [...this.status.available] }
  }

  has(scope: ScopeKey, names: string[]): boolean {
    return this.status.available.some(
      (a) => a.scope === scope && names.includes(a.name)
    )
  }

  /** Starts a check in the background and returns at once. */
  start(): UpdateStatus {
    if (this.status.checking) this.again = true
    else void this.loop()
    return this.get()
  }

  private async loop(): Promise<void> {
    this.status = { ...this.status, checking: true }
    do {
      this.again = false
      await this.runOnce()
    } while (this.again)
    this.status = { ...this.status, checking: false }
  }

  private async runOnce(): Promise<void> {
    const available: UpdateStatus["available"] = []
    const errors: string[] = []
    for (const scope of this.scopes()) {
      const result = await this.checkScope(scope)
      if (typeof result === "string") errors.push(result)
      else for (const name of result) available.push({ scope, name })
    }
    this.status = {
      checking: true,
      checkedAt: new Date().toISOString(),
      available,
      error: errors.length ? errors.join("\n") : null,
    }
  }

  private scopes(): ScopeKey[] {
    const projects = this.projects
      .paths()
      .filter((p) => existsSync(join(p, projectLockName)))
    return ["user", ...projects]
  }

  /** Names with updates, or an error message. */
  private async checkScope(scope: ScopeKey): Promise<string[] | string> {
    const user = scope === "user"
    const args = ["check", user ? "-g" : "-p"]
    try {
      const res = await this.cli.capture(args, user ? config.home : scope)
      const label = user ? "user scope" : scope
      if (res.timedOut) return `${label}: skills check timed out`
      // Exit 1 means "updates available" (or local changes), not failure.
      if (res.exitCode !== 0 && res.exitCode !== 1)
        return `${label}: skills check exited with ${res.exitCode}`
      return parseCheckOutput(res.output)
    } catch (err) {
      return `${scope}: ${(err as Error).message}`
    }
  }
}
