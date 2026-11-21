import { lstat } from "node:fs/promises"
import type { RemovalPlan, ScopeKey, UpstreamSkillRef } from "../../shared/api.ts"
import { config } from "../config.ts"
import {
  lockFingerprint,
  readScopeLock,
  type LockEntry,
  type LockReader,
} from "../discovery/locks.ts"
import { cleanLine } from "../lib/ansi.ts"
import { HttpError, badRequest } from "../lib/errors.ts"
import type { UpstreamState } from "../preview/service.ts"
import {
  invalidNameReason,
  planRemovals,
  type AgentTable,
  type CliNameFns,
  type PlannedRemoval,
} from "./plan.ts"

/** The deletion records the guard trusts (UpdateChecker). */
export interface DeletionRecords {
  record(scope: ScopeKey, name: string): { ref: UpstreamSkillRef; fingerprint: string } | null
  invalidate(scope: ScopeKey, name: string): void
  notePresent(scope: ScopeKey, name: string): void
  noteUpstream(
    scope: ScopeKey,
    found: { ambiguous?: { name: string; source: string }[] }
  ): Promise<void>
  reconcile(scopes?: ScopeKey[]): Promise<void>
}

export interface RemovalDeps {
  home?: string
  /** the CLI agent table and name helpers; default: the pinned CLI's own */
  loadCli?: () => Promise<{ agents: AgentTable } & CliNameFns>
  readLock?: LockReader
  records: DeletionRecords
  /** a fresh upstream lookup by the CLI's rules (UpdatePreviewService.upstreamState) */
  upstream: (scope: ScopeKey, name: string, entry: LockEntry) => Promise<UpstreamState>
}

/** One `skills remove` call: names that share the same -a list. */
export interface RemoveGroup {
  agents: string[]
  plans: PlannedRemoval[]
}

export interface Prepared {
  groups: RemoveGroup[]
  /** names skipped for a reason that needs a look (fetch error, changed plan) */
  failed: string[]
  /** names skipped because they are not deleted any more (back upstream, reinstalled) */
  kept: string[]
}

export interface Verified {
  removed: string[]
  /** per name, what is wrong after the CLI ran */
  incomplete: { name: string; problems: string[] }[]
}

// removeInstalledSkills catches per-path errors, warns, and still drops the lock entry.
const INCOMPLETE = [
  /Could not remove skill from /,
  /Failed to remove \d+ skill\(s\)/,
  /No matching skills found for/,
  /No skills found to remove/,
]

/**
 * Decides what a deleted-upstream removal may delete, and checks afterwards that it did
 * exactly that. The bar: never delete a path the dialog did not show for a name the user
 * did not tick, and never on stale evidence.
 */
export class RemovalGuard {
  private cliModule: Promise<{ agents: AgentTable } & CliNameFns> | null = null
  private readonly home: string
  private readonly readLock: LockReader

  constructor(private readonly deps: RemovalDeps) {
    this.home = deps.home ?? config.home
    this.readLock = deps.readLock ?? readScopeLock
  }

  /** Plans for the given names, from the disk and lock file as they are now. */
  async plans(scope: ScopeKey, names: string[]): Promise<PlannedRemoval[]> {
    if (names.length === 0) return []
    const cli = await this.cli()
    const lock = await this.readLock(scope)
    return planRemovals(
      { scope, home: this.home, agents: cli.agents, cli, lock },
      names
    )
  }

  /** The public plans of every deletion record (for UpdateStatus.removalPlans). */
  async statusPlans(refs: UpstreamSkillRef[]): Promise<RemovalPlan[]> {
    const byScope = new Map<ScopeKey, string[]>()
    for (const ref of refs) byScope.set(ref.scope, [...(byScope.get(ref.scope) ?? []), ref.name])
    const out: RemovalPlan[] = []
    for (const [scope, names] of byScope) {
      const plans = await this.plans(scope, names).catch((err: Error) =>
        names.map((name) => ({
          scope,
          name,
          willDelete: [],
          kept: [],
          blocked: `Could not work out what would be removed: ${err.message}`,
          agents: [],
        }))
      )
      for (const plan of plans) {
        const record = this.deps.records.record(scope, plan.name)
        out.push(
          toPublic(
            record || plan.blocked
              ? plan
              : { ...plan, willDelete: [], blocked: "No current evidence that it was deleted upstream; run a check" }
          )
        )
      }
    }
    return out
  }

  /**
   * Request time: every name is an exact lock key with a deletion record for its current lock
   * entry, its plan is not blocked, and the plan deletes nothing the dialog did not list.
   * Returns the plans (for the job's command line). Throws 400 or 409.
   */
  async authorize(
    scope: ScopeKey,
    names: string[],
    shown: ReadonlyMap<string, readonly string[]>
  ): Promise<PlannedRemoval[]> {
    await this.deps.records.reconcile([scope])
    const notDeleted = names.filter((name) => !this.deps.records.record(scope, name))
    if (notDeleted.length)
      throw badRequest(
        `Not deleted upstream in this scope (or its lock entry changed since): ${notDeleted.join(", ")}. Only skills in deletedUpstream can be removed here.`
      )
    const missing = names.filter((name) => !shown.has(name))
    if (missing.length)
      throw badRequest(`removePlans must list what the dialog showed for: ${missing.join(", ")}`)
    const plans = await this.plans(scope, names)
    for (const plan of plans) {
      if (plan.blockCode === "collision")
        throw new HttpError(409, "removal_conflict", plan.blocked)
      if (plan.blocked) throw new HttpError(409, "removal_blocked", `${plan.name}: ${plan.blocked}`)
      const extra = beyond(plan, shown.get(plan.name) ?? [])
      if (extra.length)
        throw new HttpError(
          409,
          "removal_plan_changed",
          `${plan.name}: would also delete ${extra.join(", ")}, which the dialog did not show. Open the dialog again.`
        )
    }
    return plans
  }

  /**
   * Job time, right before `skills remove`: for each name, the deletion record must still
   * match the lock entry, a fresh upstream fetch must still find it deleted, and the plan
   * must still be within what the dialog showed. Names that fail are skipped and logged.
   */
  async prepare(
    scope: ScopeKey,
    names: string[],
    shown: ReadonlyMap<string, readonly string[]>,
    log: (line: string) => void
  ): Promise<Prepared> {
    const failed: string[] = []
    const kept: string[] = []
    const confirmed: string[] = []
    const lock = await this.readLock(scope).catch(() => null)
    for (const name of names) {
      const record = this.deps.records.record(scope, name)
      const entry = lock?.skills.get(name)
      if (!record) {
        log(`Kept ${name}: it is no longer listed as deleted upstream.`)
        kept.push(name)
        continue
      }
      if (!entry || lockFingerprint(name, entry) !== record.fingerprint) {
        log(
          entry
            ? `Kept ${name}: its lock entry changed since it was found deleted (reinstalled or updated).`
            : `Kept ${name}: it is no longer in the lock file.`
        )
        this.deps.records.invalidate(scope, name)
        kept.push(name)
        continue
      }
      let state: UpstreamState
      try {
        state = await this.deps.upstream(scope, name, entry)
      } catch (err) {
        const detail = err instanceof HttpError ? (err.detail ?? err.message) : (err as Error).message
        log(`Kept ${name}: could not check its source again (${detail}).`)
        failed.push(name)
        continue
      }
      if (state === "present") {
        log(`Kept ${name}: it is back in its source upstream.`)
        this.deps.records.notePresent(scope, name)
        kept.push(name)
        continue
      }
      if (state === "ambiguous") {
        log(`Kept ${name}: several upstream skills now match it, so skills update skips it.`)
        await this.deps.records.noteUpstream(scope, {
          ambiguous: [{ name, source: record.ref.source }],
        })
        kept.push(name)
        continue
      }
      confirmed.push(name)
    }
    // The fetches take a while: the lock entry must still be the one that was checked.
    const after = confirmed.length ? await this.readLock(scope).catch(() => null) : null
    const stable = confirmed.filter((name) => {
      const entry = after?.skills.get(name)
      const same = !!entry && lockFingerprint(name, entry) === this.deps.records.record(scope, name)?.fingerprint
      if (!same) {
        log(`Kept ${name}: its lock entry changed while its source was checked.`)
        kept.push(name)
      }
      return same
    })
    const groups = new Map<string, RemoveGroup>()
    for (const plan of await this.plans(scope, stable)) {
      if (plan.blocked) {
        log(`Kept ${plan.name}: ${plan.blocked}`)
        failed.push(plan.name)
        continue
      }
      const extra = beyond(plan, shown.get(plan.name) ?? [])
      if (extra.length) {
        log(`Kept ${plan.name}: it would also delete ${extra.join(", ")}, which the dialog did not show.`)
        failed.push(plan.name)
        continue
      }
      log(`Confirmed ${plan.name} is deleted upstream. Will delete: ${plan.willDelete.length ? plan.willDelete.join(", ") : "(no folders; only the lock entry)"}`)
      for (const k of plan.kept) log(`  kept: ${k.reason} at ${k.path}`)
      const key = plan.agents.join(" ")
      const group = groups.get(key) ?? { agents: plan.agents, plans: [] }
      group.plans.push(plan)
      groups.set(key, group)
    }
    return { groups: [...groups.values()], failed, kept }
  }

  /**
   * After `skills remove`: no "Could not remove" or failure line, every willDelete path gone,
   * the lock entry gone, every kept path still there.
   */
  async verify(
    scope: ScopeKey,
    plans: PlannedRemoval[],
    output: string,
    exitCode: number
  ): Promise<Verified> {
    const lines = output.split("\n").map((line) => cleanLine(line).trim())
    const warnings = lines.filter((line) => INCOMPLETE.some((re) => re.test(line)))
    const lock = await this.readLock(scope).catch(() => null)
    const removed: string[] = []
    const incomplete: Verified["incomplete"] = []
    for (const plan of plans) {
      const problems: string[] = []
      if (exitCode !== 0) problems.push(`skills remove exited with ${exitCode}`)
      for (const w of warnings) problems.push(`the CLI said: ${w}`)
      for (const path of plan.willDelete)
        if (await lstat(path).catch(() => null)) problems.push(`still on disk: ${path}`)
      for (const k of plan.kept)
        if (!(await lstat(k.path).catch(() => null)))
          problems.push(`missing, but it was to be kept: ${k.path}`)
      if (!lock) problems.push("could not read the lock file")
      else if (lock.skills.has(plan.name)) problems.push("still in the lock file")
      if (problems.length) incomplete.push({ name: plan.name, problems })
      else removed.push(plan.name)
    }
    return { removed, incomplete }
  }

  private cli(): Promise<{ agents: AgentTable } & CliNameFns> {
    this.cliModule ??= (this.deps.loadCli ?? loadPinnedCli)()
    return this.cliModule
  }
}

/** Paths the plan would delete that the dialog did not list. */
function beyond(plan: PlannedRemoval, shown: readonly string[]): string[] {
  const allowed = new Set(shown)
  return plan.willDelete.filter((path) => !allowed.has(path))
}

function toPublic(plan: PlannedRemoval): RemovalPlan {
  return {
    scope: plan.scope,
    name: plan.name,
    willDelete: plan.willDelete,
    kept: plan.kept,
    ...(plan.blocked ? { blocked: plan.blocked } : {}),
  }
}

/**
 * Removal names from a request: strings that are exact lock keys of the scope (any
 * characters, spaces and Unicode included), never a leading "-" or a control character.
 * 400 otherwise.
 */
export function requireRemovalNames(value: unknown, lockKeys: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) throw badRequest("remove must be an array")
  for (const name of value) {
    if (typeof name !== "string") throw badRequest("remove has an invalid name")
    const invalid = invalidNameReason(name)
    if (invalid) throw badRequest(`remove has an invalid name: ${invalid}`)
    if (!lockKeys.has(name))
      throw badRequest(`Not deleted upstream in this scope: ${name}. Only skills in deletedUpstream can be removed here.`)
  }
  return [...new Set(value as string[])]
}

/** removePlans from a request, as name -> the willDelete list the dialog showed. */
export function requireShownPlans(value: unknown): Map<string, string[]> {
  if (!Array.isArray(value)) throw badRequest("removePlans must be an array")
  const shown = new Map<string, string[]>()
  for (const item of value) {
    const { name, willDelete } = (item ?? {}) as { name?: unknown; willDelete?: unknown }
    if (
      typeof name !== "string" ||
      !Array.isArray(willDelete) ||
      !willDelete.every((p) => typeof p === "string")
    )
      throw badRequest("removePlans entries need a name and a willDelete list")
    shown.set(name, willDelete as string[])
  }
  return shown
}

interface PinnedCli {
  agents?: AgentTable
  sanitizeName?: CliNameFns["sanitizeName"]
  resolveSkillsToRemove?: CliNameFns["resolveSkillsToRemove"]
}

/** The pinned CLI's agent table, sanitizeName and resolveSkillsToRemove (pure exports). */
async function loadPinnedCli(): Promise<{ agents: AgentTable } & CliNameFns> {
  const mod = (await import(config.skillsAgentsModule)) as PinnedCli
  if (!mod.agents || !mod.sanitizeName || !mod.resolveSkillsToRemove)
    throw new Error("This skills CLI version does not expose its remove helpers")
  return {
    agents: mod.agents,
    sanitizeName: mod.sanitizeName,
    resolveSkillsToRemove: mod.resolveSkillsToRemove,
  }
}
