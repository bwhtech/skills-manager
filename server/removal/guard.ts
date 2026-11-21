import { lstat } from "node:fs/promises"
import type {
  RemovalPlan,
  ScopeKey,
  ShownRemovalPlan,
  UpstreamSkillRef,
} from "../../shared/api.ts"
import { config } from "../config.ts"
import {
  lockFingerprint,
  readScopeLock,
  readScopeLockStrict,
  type LockEntry,
  type LockReader,
  type StrictLockReader,
} from "../discovery/locks.ts"
import { cleanLine } from "../lib/ansi.ts"
import { HttpError, badRequest } from "../lib/errors.ts"
import type { UpstreamState } from "../preview/service.ts"
import { sameIdentity } from "./inventory.ts"
import {
  agentSkillsDirs,
  invalidNameReason,
  planRemovals,
  type AgentTable,
  type Candidate,
  type CliNameFns,
  type PlannedRemoval,
  type RemovalIntent,
} from "./plan.ts"

export type ShownPlans = ReadonlyMap<string, ShownRemovalPlan>

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
  /**
   * reads the lock after `skills remove`; throws on a missing, unreadable or malformed file,
   * and lists every raw key (default readScopeLockStrict; with only readLock set, readLock)
   */
  readLockStrict?: StrictLockReader
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

/** A group re-checked right before its `skills remove` call. */
export type Rechecked =
  | { ok: true; snapshot: Map<string, string[]> }
  | { ok: false; reason: string }

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
  /** the home the plans resolve user-scope paths in */
  readonly home: string
  private readonly readLock: LockReader
  private readonly readLockStrict: StrictLockReader

  constructor(private readonly deps: RemovalDeps) {
    this.home = deps.home ?? config.home
    this.readLock = deps.readLock ?? readScopeLock
    this.readLockStrict = deps.readLockStrict ?? deps.readLock ?? readScopeLockStrict
  }

  /**
   * Plans for the given names, from the disk and lock file as they are now. `gone`: per name,
   * the ticked copies, planned as if deleted.
   */
  async plans(
    scope: ScopeKey,
    names: string[],
    options: { intent?: RemovalIntent; gone?: ReadonlyMap<string, Iterable<string>> } = {}
  ): Promise<PlannedRemoval[]> {
    if (names.length === 0) return []
    const cli = await this.cli()
    const lock = await this.readLock(scope)
    return planRemovals(
      { scope, home: this.home, agents: cli.agents, cli, lock, ...options },
      names
    )
  }

  /** The agent skills dirs of the user scope and of these projects (where trash dirs can be). */
  async skillsDirs(projects: readonly string[]): Promise<string[]> {
    return agentSkillsDirs((await this.cli()).agents, this.home, projects)
  }

  /** The public plans of every deletion record (for UpdateStatus.removalPlans). */
  async statusPlans(refs: UpstreamSkillRef[]): Promise<RemovalPlan[]> {
    const byScope = new Map<ScopeKey, string[]>()
    for (const ref of refs) byScope.set(ref.scope, [...(byScope.get(ref.scope) ?? []), ref.name])
    const out: RemovalPlan[] = []
    for (const [scope, names] of byScope) {
      const plans = await this.plans(scope, names).catch((err: Error) =>
        names.map((name): PlannedRemoval => ({
          scope,
          name,
          willDelete: [],
          kept: [],
          blocked: `Could not work out what would be removed: ${err.message}`,
          agents: [],
          intent: "cleanup" as const,
          copies: [],
          deleteCopies: [],
          identities: {},
          fingerprint: "",
          candidates: [],
        }))
      )
      for (const plan of plans) {
        const record = this.deps.records.record(scope, plan.name)
        out.push(
          toPublic(
            record || (plan.blocked && !plan.blockedUnlessCopies)
              ? plan
              : {
                  ...plan,
                  willDelete: [],
                  blocked: "No current evidence that it was deleted upstream; run a check",
                  blockedUnlessCopies: false,
                }
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
    shown: ShownPlans
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
    const plans = await this.plans(scope, names, { gone: tickedOf(shown) })
    for (const plan of plans) {
      const refusal = checkShown(plan, shown.get(plan.name) as ShownRemovalPlan)
      if (refusal) throw refusal
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
    shown: ShownPlans,
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
    for (const plan of await this.plans(scope, stable, { gone: tickedOf(shown) })) {
      const refusal = checkShown(plan, shown.get(plan.name) ?? { willDelete: [] })
      if (refusal) {
        log(`Kept ${plan.name}: ${refusal.detail ?? refusal.message}`)
        failed.push(plan.name)
        continue
      }
      log(`Confirmed ${plan.name} is deleted upstream. Will delete: ${plan.willDelete.length ? plan.willDelete.join(", ") : "(no folders; only the lock entry)"}`)
      logCopies(plan, log)
      const key = plan.agents.join(" ")
      const group = groups.get(key) ?? { agents: plan.agents, plans: [] }
      group.plans.push(plan)
      groups.set(key, group)
    }
    return { groups: [...groups.values()], failed, kept }
  }

  /**
   * Right before a group's `skills remove` call: plan each name again and compare with the
   * confirmed plan. The lock entry must be unchanged, and so must the -a list, willDelete and
   * every path the CLI could look at (all agents' cleanup paths, eve subagent dirs, the
   * canonical folder), and every promoted copy must still have the identity the plan checked.
   * Returns, per name, a snapshot of those paths for verify.
   *
   * Two phases. "present" (before the ticked copies are staged): planned with them as gone,
   * and each one must still be a copy of the name with the identity the plan recorded.
   * "staged" (default, after staging): planned from the disk as it is; none of the ticked
   * copies may be at its path.
   *
   * The CLI works out its paths again when it runs, so a folder made by the same user between
   * this snapshot and the CLI's own scan can still be deleted without notice. That race is
   * accepted: the snapshot shrinks it to the time it takes to start the CLI, and verify then
   * fails the job for any snapshotted path that went missing.
   */
  async recheck(
    scope: ScopeKey,
    plans: PlannedRemoval[],
    options: { copies?: "present" | "staged" } = {}
  ): Promise<Rechecked> {
    const present = options.copies === "present"
    const lock = await this.readLock(scope).catch(() => null)
    const snapshot = new Map<string, string[]>()
    const byIntent = new Map<RemovalIntent, PlannedRemoval[]>()
    for (const plan of plans) byIntent.set(plan.intent, [...(byIntent.get(plan.intent) ?? []), plan])
    for (const [intent, group] of byIntent) {
      const gone = present ? new Map(group.map((p) => [p.name, p.deleteCopies])) : undefined
      const fresh = await this.plans(scope, group.map((p) => p.name), { intent, ...(gone ? { gone } : {}) })
      for (const [i, plan] of group.entries()) {
        const now = fresh[i]
        const entry = lock?.skills.get(plan.name)
        if (!entry || lockFingerprint(plan.name, entry) !== plan.fingerprint)
          return { ok: false, reason: `the lock entry of ${plan.name} changed` }
        if (now.blocked) return { ok: false, reason: `${plan.name}: ${now.blocked}` }
        if (now.agents.join(" ") !== plan.agents.join(" "))
          return { ok: false, reason: `${plan.name}: the agents to pass changed (${now.agents.join(" ")})` }
        const changed = setDiff(plan.willDelete, now.willDelete)
        if (changed) return { ok: false, reason: `${plan.name}: what would be deleted changed (${changed})` }
        const moved = setDiff(plan.candidates.map(candidateKey), now.candidates.map(candidateKey))
        if (moved) return { ok: false, reason: `${plan.name}: the paths skills remove could touch changed (${moved})` }
        for (const p of plan.promoted ?? [])
          if (!sameIdentity(plan.identities[p.path], now.identities[p.path]))
            return { ok: false, reason: `${plan.name}: ${p.path} changed since it was checked` }
        if (present) {
          const off = plan.deleteCopies.filter(
            (path) => !now.copies.some((c) => c.path === path) || !sameIdentity(plan.identities[path], now.identities[path])
          )
          if (off.length) return { ok: false, reason: `${plan.name}: ticked copies changed since they were checked: ${off.join(", ")}` }
        } else {
          const left = plan.deleteCopies.filter((path) => now.copies.some((c) => c.path === path))
          if (left.length) return { ok: false, reason: `${plan.name}: ticked copies are still there: ${left.join(", ")}` }
        }
        snapshot.set(plan.name, now.candidates.map((c) => c.path))
      }
    }
    return { ok: true, snapshot }
  }

  /**
   * After `skills remove`: no "Could not remove" or failure line, every willDelete path and
   * ticked copy gone, the lock file readable and without the entry, every kept path and
   * unticked copy still there, and no other snapshotted path gone.
   */
  async verify(
    scope: ScopeKey,
    plans: PlannedRemoval[],
    output: string,
    exitCode: number,
    snapshot: ReadonlyMap<string, readonly string[]> = new Map()
  ): Promise<Verified> {
    const lines = output.split("\n").map((line) => cleanLine(line).trim())
    const warnings = lines.filter((line) => INCOMPLETE.some((re) => re.test(line)))
    let lock: Awaited<ReturnType<StrictLockReader>> | null = null
    let lockError: string | null = null
    try {
      lock = await this.readLockStrict(scope)
    } catch (err) {
      lockError = (err as Error).message
    }
    const exists = async (path: string) => !!(await lstat(path).catch(() => null))
    const cli = await this.cli()
    const removed: string[] = []
    const incomplete: Verified["incomplete"] = []
    for (const plan of plans) {
      const problems: string[] = []
      if (exitCode !== 0) problems.push(`skills remove exited with ${exitCode}`)
      for (const w of warnings) problems.push(`the CLI said: ${w}`)
      for (const path of [...plan.willDelete, ...plan.deleteCopies])
        if (await exists(path)) problems.push(`still on disk: ${path}`)
      for (const k of plan.kept)
        if (!(await exists(k.path))) problems.push(`missing, but it was to be kept: ${k.path}`)
      for (const c of plan.copies)
        if (!plan.deleteCopies.includes(c.path) && !(await exists(c.path)))
          problems.push(`missing, but it was to be kept: ${c.path} (a copy that was not ticked)`)
      const allowed = new Set([...plan.willDelete, ...plan.deleteCopies])
      for (const path of snapshot.get(plan.name) ?? [])
        if (!allowed.has(path) && !(await exists(path)))
          problems.push(`deleted although it was not to be: ${path}`)
      if (lockError) problems.push(lockError)
      else if (lock) {
        const left = stillLocked(lock, plan.name, cli.sanitizeName)
        if (left.length)
          problems.push(
            left.length === 1 && left[0] === plan.name && lock.skills.has(plan.name)
              ? "still in the lock file"
              : `still in the lock file: ${left.map((key) => `"${key}"${lock?.skills.has(key) ? "" : " (malformed entry)"}`).join(", ")}`
          )
      }
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

/**
 * Why a plan (made with the ticked copies as gone) must not run with what the dialog showed,
 * else null. 400: a ticked path that is not a copy of the name, or a copy too large to remove
 * here (tooLargeToRemove: refused at request time, never mid-job). 409 removal_plan_changed: the
 * copies or their identical flags changed, or the plan would delete a path the dialog did not
 * show. 409 removal_blocked: a blocking copy is not ticked, or the name is blocked otherwise.
 */
export function checkShown(plan: PlannedRemoval, shown: ShownRemovalPlan): HttpError | null {
  const ticked = shown.copies ?? []
  const current = new Map(plan.copies.map((c) => [c.path, c]))
  if (shown.shownCopies) {
    const listed = new Map(shown.shownCopies.map((c) => [c.path, c.identical]))
    const stray = ticked.filter((path) => !listed.has(path))
    if (stray.length)
      return badRequest(`${plan.name}: copies lists ${stray.join(", ")}, which the dialog did not show as a copy of it`)
    const changes: string[] = []
    for (const [path, identical] of listed) {
      const now = current.get(path)
      if (!now) changes.push(`${path} is no longer a separate copy`)
      else if (now.identical !== identical)
        changes.push(`${path} is now ${now.identical ? "identical" : `different (${now.reason ?? "differs"})`}`)
    }
    for (const path of current.keys()) if (!listed.has(path)) changes.push(`${path} is a new copy`)
    if (changes.length)
      return new HttpError(
        409,
        "removal_plan_changed",
        `${plan.name}: its separate copies changed since the dialog: ${changes.join("; ")}. Open the dialog again.`
      )
  }
  const notCopies = ticked.filter((path) => !current.has(path))
  if (notCopies.length)
    return badRequest(`${plan.name}: ${notCopies.join(", ")} is not a separate copy of it that can be deleted`)
  const tooLarge = ticked.filter((path) => current.get(path)?.tooLargeToRemove || !plan.identities[path])
  if (tooLarge.length)
    return badRequest(`${plan.name}: Too large to remove safely here — delete it by hand: ${tooLarge.join(", ")}`)
  if (plan.blockCode === "collision") return new HttpError(409, "removal_conflict", plan.blocked)
  if (plan.blockedUnlessCopies) {
    const unticked = plan.copies.filter((c) => c.blocking && !ticked.includes(c.path)).map((c) => c.path)
    return new HttpError(
      409,
      "removal_blocked",
      `${plan.name}: it stays while its separate ${unticked.length === 1 ? "copy is" : "copies are"} not ticked: ${unticked.join(", ")}. ${plan.blocked}`
    )
  }
  if (plan.blocked) return new HttpError(409, "removal_blocked", `${plan.name}: ${plan.blocked}`)
  const allowed = new Set(shown.willDelete)
  const extra = plan.willDelete.filter((path) => !allowed.has(path))
  if (extra.length)
    return new HttpError(
      409,
      "removal_plan_changed",
      `${plan.name}: would also delete ${extra.join(", ")}, which the dialog did not show. Open the dialog again.`
    )
  return null
}

/** The job log lines for a plan's copies and kept paths. */
export function logCopies(plan: PlannedRemoval, log: (line: string) => void): void {
  for (const path of plan.deleteCopies) log(`  will delete the separate copy ${path}`)
  for (const c of plan.copies)
    if (!plan.deleteCopies.includes(c.path)) log(`  kept: separate copy (not ticked) at ${c.path}`)
  for (const k of plan.kept) log(`  kept: ${k.reason} at ${k.path}`)
}

/**
 * Raw lock keys that still stand for `name` after `skills remove`, by the CLI's own key
 * matching: the exact key it deletes (removeSkillFromLock), and any key that resolves to the
 * same folder name (resolveSkillsToRemove indexes keys by sanitizeName). Malformed entries
 * count: a key is present whatever its entry holds.
 */
export function stillLocked(
  lock: { skills: ReadonlyMap<string, unknown>; rawKeys?: string[] },
  name: string,
  sanitizeName: (name: string) => string
): string[] {
  const keys = lock.rawKeys ?? [...lock.skills.keys()]
  const sanitized = sanitizeName(name)
  return keys.filter((key) => key === name || sanitizeName(key) === sanitized)
}

function tickedOf(shown: ShownPlans): Map<string, string[]> {
  return new Map([...shown].map(([name, plan]) => [name, plan.copies ?? []]))
}

function candidateKey(c: Candidate): string {
  return `${c.path} (${c.kind})`
}

/** "+a, -b" between two lists of strings, or "" when they hold the same set. */
function setDiff(before: readonly string[], after: readonly string[]): string {
  const a = new Set(before)
  const b = new Set(after)
  return [
    ...[...b].filter((x) => !a.has(x)).map((x) => `+${x}`),
    ...[...a].filter((x) => !b.has(x)).map((x) => `-${x}`),
  ].join(", ")
}

export function toPublic(plan: PlannedRemoval): RemovalPlan {
  return {
    scope: plan.scope,
    name: plan.name,
    willDelete: plan.willDelete,
    kept: plan.kept,
    copies: plan.copies,
    ...(plan.blocked ? { blocked: plan.blocked } : {}),
    ...(plan.blockedUnlessCopies ? { blockedUnlessCopies: true } : {}),
    ...(plan.promoted?.length ? { promoted: plan.promoted } : {}),
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

/** removePlans from a request, as name -> what the dialog showed and ticked. */
export function requireShownPlans(value: unknown): Map<string, ShownRemovalPlan> {
  if (!Array.isArray(value)) throw badRequest("removePlans must be an array")
  const shown = new Map<string, ShownRemovalPlan>()
  for (const item of value) {
    const name = (item ?? {}).name as unknown
    if (typeof name !== "string") throw badRequest("removePlans entries need a name and a willDelete list")
    shown.set(name, requireShownPlan(item, "removePlans entries"))
  }
  return shown
}

/** One ShownRemovalPlan from a request body. 400 when malformed. */
export function requireShownPlan(value: unknown, what = "the request"): ShownRemovalPlan {
  const { willDelete, copies, shownCopies } = (value ?? {}) as Record<string, unknown>
  const strings = (v: unknown) => Array.isArray(v) && v.every((p) => typeof p === "string")
  if (!strings(willDelete)) throw badRequest(`${what} need a name and a willDelete list`)
  if (copies !== undefined && !strings(copies)) throw badRequest(`${what}: copies must be a list of paths`)
  if (
    shownCopies !== undefined &&
    !(
      Array.isArray(shownCopies) &&
      shownCopies.every(
        (c) => c && typeof c === "object" && typeof c.path === "string" && typeof c.identical === "boolean"
      )
    )
  )
    throw badRequest(`${what}: shownCopies must be a list of {path, identical}`)
  return {
    willDelete: willDelete as string[],
    ...(copies ? { copies: [...new Set(copies as string[])] } : {}),
    ...(shownCopies
      ? { shownCopies: (shownCopies as { path: string; identical: boolean }[]).map(({ path, identical }) => ({ path, identical })) }
      : {}),
  }
}

interface PinnedCli {
  agents?: AgentTable
  sanitizeName?: CliNameFns["sanitizeName"]
  resolveSkillsToRemove?: CliNameFns["resolveSkillsToRemove"]
  computeSkillFolderHash?: CliNameFns["computeSkillFolderHash"]
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
    ...(mod.computeSkillFolderHash ? { computeSkillFolderHash: mod.computeSkillFolderHash } : {}),
  }
}
