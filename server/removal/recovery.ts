import { lstat, readdir, rm, rmdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { InterruptedCopy, InterruptedRemoval, RecoveryResult, RecoveryStatus } from "../../shared/api.ts"
import { HttpError, badRequest, notFound } from "../lib/errors.ts"
import { withPathLock } from "../lib/files.ts"
import { DELETE_LIMITS, fullDigest, takeInventory } from "./inventory.ts"
import { RemovalJournal, isJobId, isOpen, journalDir, readJournals, type JournalItem } from "./journal.ts"
import { TRASH_PREFIX, checkTrashed, isUnsafeToDelete, moveBack, type RestoreHooks } from "./staging.ts"

export interface RecoveryDeps {
  home: string
  /** ids of jobs still queued or running: their journals are not listed or acted on */
  running: () => string[]
  /** skills dirs to look in for trash dirs that no journal covers */
  skillsDirs: () => Promise<string[]>
  /** test seam: around each move back */
  restoreHooks?: RestoreHooks
}

/**
 * Interrupted removals: journals that a removal job left behind (a crash, or copies that could
 * not be moved back or deleted). Reads the disk at each call; nothing is restored or deleted
 * unless asked (restore, delete). See shared/api.ts, Recovery.
 */
export class RemovalRecovery {
  constructor(private readonly deps: RecoveryDeps) {}

  get dir(): string {
    return journalDir(this.deps.home)
  }

  async status(): Promise<RecoveryStatus> {
    const running = new Set(this.deps.running())
    const covered = new Set<string>()
    const interruptedRemovals: InterruptedRemoval[] = []
    for (const journal of await readJournals(this.dir)) {
      const items: InterruptedCopy[] = []
      for (const item of journal.items) {
        if (!isOpen(item) || !wellFormed(item, this.deps.home)) continue
        covered.add(dirname(item.staged))
        if (running.has(journal.jobId)) continue
        const view = await this.view(item)
        if (view) items.push(view)
      }
      if (items.length) interruptedRemovals.push({ jobId: journal.jobId, at: journal.at, items })
    }
    const unknownLeftovers: { path: string }[] = []
    for (const dir of new Set(await this.deps.skillsDirs())) {
      const names = await readdir(dir).catch(() => [] as string[])
      for (const name of names.sort()) {
        const path = join(dir, name)
        if (name.startsWith(TRASH_PREFIX) && !covered.has(path)) unknownLeftovers.push({ path })
      }
    }
    return { interruptedRemovals, unknownLeftovers }
  }

  /** Moves the listed copies back (moveBack: never over anything at the original path). */
  restore(jobId: unknown, staged: unknown): Promise<RecoveryResult> {
    return this.act(jobId, staged, async (item, view, journal) => {
      if (!view.restorable) return { ok: false, message: view.reason ?? "It cannot be moved back." }
      const moved = await moveBack(item.staged, item.original, this.deps.restoreHooks)
      if (moved.ok) {
        await journal.set(item.staged, "restored")
        return { ok: true, message: `Moved back to ${item.original}` }
      }
      // Moved, but not the folder that was set aside: it is out of the trash dir either way.
      if (moved.moved) await journal.set(item.staged, "restored", moved.reason)
      return { ok: false, message: moved.moved ? moved.reason : `${moved.reason}. It is still at ${item.staged}.` }
    })
  }

  /**
   * Deletes the listed copies for good: each must still be in its trash dir in its verified
   * skills dir, with the device, inode and full content digest the journal recorded.
   */
  delete(jobId: unknown, staged: unknown): Promise<RecoveryResult> {
    return this.act(jobId, staged, async (item, view, journal) => {
      if (!view.deletable) return { ok: false, message: view.reason ?? "It cannot be deleted here." }
      const real = await checkTrashed(placementOf(item), item.staged, item, this.deps.home)
      if (!real) return { ok: false, message: "It is not the folder that was set aside any more; nothing was deleted." }
      const inv = await takeInventory(real, DELETE_LIMITS).catch(() => null)
      if (!inv || inv.dev !== item.dev || inv.ino !== item.ino || fullDigest(inv) !== item.full)
        return { ok: false, message: "Its contents changed since it was set aside; nothing was deleted." }
      try {
        await rm(real, { recursive: true })
      } catch (err) {
        const why = (err as Error).message
        await journal.set(item.staged, "purge_failed", why)
        return { ok: false, message: `Partially deleted (${why}); what is left is at ${item.staged}. Delete it by hand.` }
      }
      await rmdir(dirname(real)).catch(() => {})
      await journal.set(item.staged, "deleted")
      return { ok: true, message: `Deleted ${item.staged}` }
    })
  }

  private async act(
    jobId: unknown,
    staged: unknown,
    fn: (item: JournalItem, view: InterruptedCopy, journal: RemovalJournal) => Promise<{ ok: boolean; message: string }>
  ): Promise<RecoveryResult> {
    if (!isJobId(jobId)) throw badRequest("jobId must be the id of a removal job")
    if (!Array.isArray(staged) || staged.length === 0 || !staged.every((p) => typeof p === "string"))
      throw badRequest("staged must be a non-empty list of paths")
    if (this.deps.running().includes(jobId))
      throw new HttpError(409, "job_running", "That removal job is still running; wait for it to finish.")
    const file = join(this.dir, `${jobId}.json`)
    // One action per journal at a time.
    return withPathLock(file, async () => {
      const journal = await RemovalJournal.open(this.dir, jobId)
      if (!journal) throw notFound("No interrupted removal with that job id")
      const items = new Map(journal.items().map((item) => [item.staged, item]))
      const unknown = (staged as string[]).filter((path) => !items.has(path))
      if (unknown.length) throw badRequest(`Not set aside by that job: ${unknown.join(", ")}`)
      const results: RecoveryResult["results"] = []
      for (const path of new Set(staged as string[])) {
        const item = items.get(path) as JournalItem
        const view = isOpen(item) && wellFormed(item, this.deps.home) ? await this.view(item) : null
        if (!view) {
          results.push({ staged: path, ok: false, message: "It is no longer set aside." })
          continue
        }
        results.push({ staged: path, ...(await fn(item, view, journal)) })
      }
      await journal.settle()
      return { results, recovery: await this.status() }
    })
  }

  /** What the disk says about an open journal item. Null when nothing of it is in its trash dir. */
  private async view(item: JournalItem): Promise<InterruptedCopy | null> {
    const at = await lstat(item.staged).catch(() => null)
    // Never moved (a crash right before the move), or moved away by hand: nothing set aside.
    if (!at) return null
    const base = { original: item.original, staged: item.staged }
    if (item.status === "purge_failed")
      return {
        ...base,
        status: "purge_failed",
        restorable: false,
        deletable: false,
        reason: `partially deleted, still in trash: ${item.staged}. Delete it by hand.`,
      }
    if (!(await checkTrashed(placementOf(item), item.staged, item, this.deps.home)))
      return {
        ...base,
        status: "staged",
        restorable: false,
        deletable: false,
        reason: `the folder at ${item.staged} is not the one that was set aside, or its skills dir changed; check it by hand`,
      }
    const occupied = !!(await lstat(item.original).catch(() => null))
    return {
      ...base,
      status: "staged",
      restorable: !occupied,
      deletable: true,
      ...(occupied ? { reason: `something else is at ${item.original} now, so it cannot be moved back` } : {}),
    }
  }
}

function placementOf(item: JournalItem) {
  return { path: item.original, root: dirname(item.original), scope: item.scope }
}

/** A journal item names <skills dir>/.skills-manager-trash-<id>/<name> for <skills dir>/<name>. */
function wellFormed(item: JournalItem, home: string): boolean {
  const trash = dirname(item.staged)
  return (
    dirname(trash) === dirname(item.original) &&
    basename(trash).startsWith(TRASH_PREFIX) &&
    basename(item.staged) === basename(item.original) &&
    !isUnsafeToDelete(item.original, home)
  )
}
