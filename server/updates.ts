import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  updateTargetsOverlap,
  type ScopeKey,
  type UpdateStatus,
  type UpdateTarget,
  type UpstreamSkillRef,
} from "../shared/api.ts"
import {
  parseCheckOutput,
  type CheckFailure,
  type UpstreamSkill,
} from "./cli/parsers.ts"
import type { SkillsCli } from "./cli/skills-cli.ts"
import { config, projectLockName } from "./config.ts"
import {
  lockFingerprint,
  readScopeLock,
  type LockReader,
  type SkillLock,
} from "./discovery/locks.ts"
import type { ProjectService } from "./discovery/projects.ts"
import { cleanLine } from "./lib/ansi.ts"

/**
 * Runs `skills check` for the user scope and every project with a
 * skills-lock.json. One check at a time; a request during a check queues
 * one more run.
 */
export class UpdateChecker {
  private status: Required<Omit<UpdateStatus, "removalPlans">> = {
    checking: false,
    checkedAt: null,
    available: [],
    error: null,
    failed: [],
    deletedUpstream: [],
    ambiguousUpstream: [],
    scopeErrors: [],
  }
  private again = false
  /** updates that succeeded while a check ran: that check's results for them are stale */
  private updatedDuringRun: UpdateTarget[] = []
  /** deleted-upstream skills removed while a check ran: same */
  private removedDuringRun: UpdateTarget[] = []
  /**
   * The evidence behind each deletedUpstream entry: `${scope}\n${name}` -> fingerprint of the
   * lock entry it was found deleted for. An entry without one is never removed.
   */
  private bindings = new Map<string, string>()

  constructor(
    private readonly cli: SkillsCli,
    private readonly projects: ProjectService,
    private readonly readLock: LockReader = readScopeLock
  ) {}

  get(): UpdateStatus {
    return {
      ...this.status,
      available: [...this.status.available],
      failed: [...this.status.failed],
      deletedUpstream: [...this.status.deletedUpstream],
      ambiguousUpstream: [...this.status.ambiguousUpstream],
      scopeErrors: [...this.status.scopeErrors],
    }
  }

  has(scope: ScopeKey, names: string[]): boolean {
    return this.status.available.some(
      (a) => a.scope === scope && names.includes(a.name)
    )
  }

  /** The skill (by CLI name) is known to be deleted upstream in that scope. */
  isDeleted(scope: ScopeKey, name: string): boolean {
    return this.status.deletedUpstream.some((d) => sameSkill(d, scope, name))
  }

  /**
   * The deletion record for exactly this lock key, with the fingerprint of the lock entry it
   * was observed for. Null when there is none: then the name must not be removed.
   */
  record(
    scope: ScopeKey,
    name: string
  ): { ref: UpstreamSkillRef; fingerprint: string } | null {
    const ref = this.status.deletedUpstream.find(
      (d) => d.scope === scope && d.name === name
    )
    const fingerprint = this.bindings.get(bindingKey(scope, name))
    return ref && fingerprint ? { ref, fingerprint } : null
  }

  /** Drops a deletion record: its evidence no longer holds. */
  invalidate(scope: ScopeKey, name: string): void {
    this.bindings.delete(bindingKey(scope, name))
    this.status = {
      ...this.status,
      deletedUpstream: this.status.deletedUpstream.filter(
        (d) => !(d.scope === scope && d.name === name)
      ),
    }
  }

  /**
   * Drops every deletion record (of the given scopes, default all) whose lock entry is gone
   * or changed since it was observed: a reinstall, an update, a remove.
   */
  async reconcile(scopes?: ScopeKey[]): Promise<void> {
    const wanted = new Set(
      scopes ?? this.status.deletedUpstream.map((d) => d.scope)
    )
    for (const scope of wanted) {
      const lock = await this.readLock(scope).catch(() => null)
      for (const d of this.status.deletedUpstream) {
        if (d.scope !== scope) continue
        const entry = lock?.skills.get(d.name)
        const now = entry ? lockFingerprint(d.name, entry) : null
        if (now === null || now !== this.bindings.get(bindingKey(scope, d.name)))
          this.invalidate(scope, d.name)
      }
    }
  }

  /**
   * Skills found deleted (or ambiguous) upstream outside a check: in an update job's output,
   * or by a preview. Each deleted one is bound to its lock entry in `lock` (read now when
   * omitted); without an entry it is not recorded. A later finding contradicts an earlier one:
   * ambiguous clears deleted and the other way round. The next check is the truth again.
   */
  async noteUpstream(
    scope: ScopeKey,
    found: { deleted?: UpstreamSkill[]; ambiguous?: UpstreamSkill[] },
    lock?: SkillLock
  ): Promise<void> {
    const current = lock ?? (await this.readLock(scope).catch(() => null))
    const bound: UpstreamSkill[] = []
    for (const item of found.deleted ?? []) {
      const entry = current?.skills.get(item.name)
      if (!entry) continue
      this.bindings.set(bindingKey(scope, item.name), lockFingerprint(item.name, entry))
      bound.push(item)
    }
    const ambiguousNames = new Set((found.ambiguous ?? []).map((a) => a.name))
    const deletedNames = new Set(bound.map((d) => d.name))
    for (const name of ambiguousNames) this.bindings.delete(bindingKey(scope, name))
    const deleted = mergeRefs(
      this.status.deletedUpstream.filter(
        (d) => !(d.scope === scope && ambiguousNames.has(d.name))
      ),
      scope,
      bound
    )
    const ambiguous = mergeRefs(
      this.status.ambiguousUpstream.filter(
        (a) => !(a.scope === scope && deletedNames.has(a.name))
      ),
      scope,
      found.ambiguous
    )
    this.status = {
      ...this.status,
      deletedUpstream: deleted,
      ambiguousUpstream: ambiguous,
      available: this.status.available.filter(
        (a) => !deleted.some((d) => sameSkill(d, a.scope, a.name))
      ),
    }
  }

  /** A preview found the skill upstream: an earlier deleted or ambiguous finding is stale. */
  notePresent(scope: ScopeKey, name: string): void {
    this.invalidate(scope, name)
    this.status = {
      ...this.status,
      ambiguousUpstream: this.status.ambiguousUpstream.filter(
        (a) => !(a.scope === scope && a.name === name)
      ),
    }
  }

  /** What an update job printed: the deleted and ambiguous skills of the sources it fetched. */
  async noteJobOutput(scope: ScopeKey, output: string): Promise<void> {
    const report = parseCheckOutput(output)
    if (report.deleted.length || report.ambiguous.length)
      await this.noteUpstream(scope, report)
  }

  /**
   * A remove of deleted-upstream skills succeeded: drop them from deletedUpstream at once,
   * as markUpdated does for `available`. A check running now is pruned too.
   */
  markRemoved(scope: ScopeKey, names: string[]): void {
    if (names.length === 0) return
    const target: UpdateTarget = { scope, names }
    for (const name of names) this.bindings.delete(bindingKey(scope, name))
    this.status = {
      ...this.status,
      deletedUpstream: withoutUpdated(this.status.deletedUpstream, [target]),
    }
    if (this.status.checking) this.removedDuringRun.push(target)
  }

  /**
   * An update job succeeded: drop its skills from `available` at once
   * (names empty = every skill in the scope), so the skill list stops
   * flagging them before the next check ends. Failed entries stay, and so do
   * `except` (lock keys whose source failed in the job). A check that runs now
   * started before the update, so its result is pruned too; the caller starts
   * a new check after this.
   */
  markUpdated(scope: ScopeKey, names: string[], except: string[] = []): void {
    const skip = new Set(except.map((n) => n.toLowerCase()))
    let target: UpdateTarget = { scope, names }
    if (skip.size > 0) {
      const base = names.length
        ? names
        : this.status.available.filter((a) => a.scope === scope).map((a) => a.name)
      target = { scope, names: base.filter((n) => !skip.has(n.toLowerCase())) }
      if (target.names.length === 0) return
    }
    this.status = {
      ...this.status,
      available: withoutUpdated(this.status.available, [target]),
    }
    if (this.status.checking) this.updatedDuringRun.push(target)
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
    this.updatedDuringRun = []
    this.removedDuringRun = []
    const available: UpdateStatus["available"] = []
    const failed: NonNullable<UpdateStatus["failed"]> = []
    const deleted: UpstreamSkillRef[] = []
    const ambiguous: UpstreamSkillRef[] = []
    const scopeErrors: NonNullable<UpdateStatus["scopeErrors"]> = []
    const bindings = new Map<string, string>()
    for (const scope of this.scopes()) {
      // A deletion counts only for the lock entry the check saw: unchanged before and after.
      const before = await this.readLock(scope).catch(() => null)
      const result = await this.checkScope(scope)
      const after = await this.readLock(scope).catch(() => null)
      for (const name of result.updates) available.push({ scope, name })
      for (const f of result.failures) failed.push({ scope, ...f })
      for (const d of result.deleted) {
        const a = after?.skills.get(d.name)
        const b = before?.skills.get(d.name)
        if (!a || !b) continue
        const fingerprint = lockFingerprint(d.name, a)
        if (fingerprint !== lockFingerprint(d.name, b)) continue
        bindings.set(bindingKey(scope, d.name), fingerprint)
        deleted.push({ scope, ...d })
      }
      for (const a of result.ambiguous) ambiguous.push({ scope, ...a })
      if (result.error) scopeErrors.push({ scope, error: result.error })
    }
    this.bindings = bindings
    const errors = scopeErrors.map((e) => e.error)
    this.status = {
      checking: true,
      checkedAt: new Date().toISOString(),
      available: withoutUpdated(available, this.updatedDuringRun).filter(
        (a) => !deleted.some((d) => sameSkill(d, a.scope, a.name))
      ),
      error: errors.length ? errors.join("\n") : null,
      failed,
      deletedUpstream: withoutUpdated(deleted, this.removedDuringRun),
      ambiguousUpstream: ambiguous,
      scopeErrors,
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

function bindingKey(scope: ScopeKey, name: string): string {
  return `${scope}\n${name}`
}

function withoutUpdated<T extends { scope: ScopeKey; name: string }>(
  available: T[],
  updated: UpdateTarget[]
): T[] {
  return available.filter(
    (item) =>
      !updated.some((target) =>
        updateTargetsOverlap(target, { scope: item.scope, names: [item.name] })
      )
  )
}

/** Same scope and CLI name (names compare without case, as update targets do). */
function sameSkill(
  ref: { scope: ScopeKey; name: string },
  scope: ScopeKey,
  name: string
): boolean {
  return ref.scope === scope && ref.name.toLowerCase() === name.toLowerCase()
}

function mergeRefs(
  list: UpstreamSkillRef[],
  scope: ScopeKey,
  found: UpstreamSkill[] = []
): UpstreamSkillRef[] {
  const out = [...list]
  for (const item of found)
    if (!out.some((r) => sameSkill(r, scope, item.name)))
      out.push({ scope, ...item })
  return out
}

export interface ScopeCheck {
  updates: string[]
  failures: CheckFailure[]
  deleted: UpstreamSkill[]
  ambiguous: UpstreamSkill[]
  error: string | null
}

function failedCheck(error: string): ScopeCheck {
  return { updates: [], failures: [], deleted: [], ambiguous: [], error }
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
  const { updates, failures, deleted, ambiguous } = report
  const found = { updates, failures, deleted, ambiguous }
  // The CLI counts a skill gone from its download as failed; here it is deleted upstream.
  const failCount = Math.max(0, report.failCount - report.goneFromDownload)
  if (failCount > 0 || failures.length > 0) {
    const n = failCount || failures.length
    const what = failCount
      ? `${n} skill${n === 1 ? "" : "s"}`
      : `${n} source${n === 1 ? "" : "s"}`
    return { ...found, error: `${label}: ${what} could not be checked` }
  }
  if (exitCode === 0 || (exitCode === 1 && report.explainsExit))
    return { ...found, error: null }
  const last = output
    .split("\n")
    .map((l) => cleanLine(l).trim())
    .filter(Boolean)
    .pop()
  const detail = last ? `: ${last}` : ""
  return {
    ...found,
    error: `${label}: skills check exited with ${exitCode}${detail}`,
  }
}

