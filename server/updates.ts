import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ScopeKey, UpdateStatus } from "../shared/api.ts"
import { parseCheckOutput, type CheckFailure } from "./cli/parsers.ts"
import type { SkillsCli } from "./cli/skills-cli.ts"
import { config, projectLockName } from "./config.ts"
import type { ProjectService } from "./discovery/projects.ts"
import { cleanLine } from "./lib/ansi.ts"

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
    failed: [],
  }
  private again = false

  constructor(
    private readonly cli: SkillsCli,
    private readonly projects: ProjectService
  ) {}

  get(): UpdateStatus {
    return {
      ...this.status,
      available: [...this.status.available],
      failed: [...(this.status.failed ?? [])],
    }
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
    const failed: NonNullable<UpdateStatus["failed"]> = []
    const errors: string[] = []
    for (const scope of this.scopes()) {
      const result = await this.checkScope(scope)
      for (const name of result.updates) available.push({ scope, name })
      for (const f of result.failures) failed.push({ scope, ...f })
      if (result.error) errors.push(result.error)
    }
    this.status = {
      checking: true,
      checkedAt: new Date().toISOString(),
      available,
      error: errors.length ? errors.join("\n") : null,
      failed,
    }
  }

  private scopes(): ScopeKey[] {
    const projects = this.projects
      .paths()
      .filter((p) => existsSync(join(p, projectLockName)))
    return ["user", ...projects]
  }

  /** Names with updates, what could not be checked, and a summary error. */
  private async checkScope(scope: ScopeKey): Promise<ScopeCheck> {
    const user = scope === "user"
    const label = user ? "user scope" : scope
    const args = ["check", user ? "-g" : "-p"]
    try {
      const res = await this.cli.capture(args, user ? config.home : scope)
      if (res.timedOut) return failedCheck(`${label}: skills check timed out`)
      return interpretCheck(label, res.exitCode, res.output)
    } catch (err) {
      return failedCheck(`${label}: ${(err as Error).message}`)
    }
  }
}

export interface ScopeCheck {
  updates: string[]
  failures: CheckFailure[]
  error: string | null
}

function failedCheck(error: string): ScopeCheck {
  return { updates: [], failures: [], error }
}

/**
 * Exit code 1 is normal when updates are available, but the CLI also exits 1
 * when checks fail. Failures are read from the output, whatever the exit code.
 */
export function interpretCheck(
  label: string,
  exitCode: number | null,
  output: string
): ScopeCheck {
  const report = parseCheckOutput(output)
  const { updates, failures } = report
  if (report.failCount > 0 || failures.length > 0) {
    const n = report.failCount || failures.length
    const what = report.failCount
      ? `${n} skill${n === 1 ? "" : "s"}`
      : `${n} source${n === 1 ? "" : "s"}`
    return { updates, failures, error: `${label}: ${what} could not be checked` }
  }
  if (exitCode === 0 || (exitCode === 1 && report.explainsExit))
    return { updates, failures, error: null }
  const last = output
    .split("\n")
    .map((l) => cleanLine(l).trim())
    .filter(Boolean)
    .pop()
  const detail = last ? `: ${last}` : ""
  return {
    updates,
    failures,
    error: `${label}: skills check exited with ${exitCode}${detail}`,
  }
}

