import { mkdir, readdir, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { ScopeKey } from "../../shared/api.ts"
import { atomicWrite } from "../lib/files.ts"

/**
 * planned: about to be moved into its trash dir (it may or may not have moved: check the disk);
 * staged: in its trash dir; restored: moved back; deleted: gone for good;
 * purging: a delete started. Written before the delete; if the server stops part way, what is
 *   left may be incomplete, so it is treated like purge_failed and never moved back.
 * purge_failed: the delete threw part way, so what is left in the trash dir is incomplete.
 */
export type JournalStatus = "planned" | "staged" | "restored" | "deleted" | "purging" | "purge_failed"

export interface JournalItem {
  /** where the copy was */
  original: string
  /** where it is moved to: <skills dir>/.skills-manager-trash-<id>/<name> */
  staged: string
  /** the scope of the skills dir (to verify the trash dir again) */
  scope: ScopeKey
  dev: number
  ino: number
  /** CopyIdentity.full: digest of every byte, as checked when it was staged */
  full: string
  status: JournalStatus
  error?: string
}

export interface JournalFile {
  version: 1
  jobId: string
  at: string
  items: JournalItem[]
}

/** Where removal journals live: <home>/.config/skills-manager/removals (shared/api.ts, Recovery). */
export function journalDir(home: string): string {
  return join(home, ".config/skills-manager/removals")
}

const OPEN: ReadonlySet<JournalStatus> = new Set(["planned", "staged", "purging", "purge_failed"])

/** A copy the journal does not record as settled: it may still be in a trash dir. */
export function isOpen(item: JournalItem): boolean {
  return OPEN.has(item.status)
}

/**
 * The journal of one removal job: ~/.config/skills-manager/removals/<jobId>.json, written
 * atomically with mode 600 before anything is moved, and after each step. Deleted once every
 * copy is settled (deleted or moved back). Writes are serialized.
 */
export class RemovalJournal {
  private data: JournalFile | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(
    readonly dir: string,
    readonly jobId: string
  ) {}

  get file(): string {
    return journalPath(this.dir, this.jobId)
  }

  /** Loads an existing journal (recovery actions). Null when there is none. */
  static async open(dir: string, jobId: string): Promise<RemovalJournal | null> {
    const data = await readJournal(journalPath(dir, jobId))
    if (!data) return null
    const journal = new RemovalJournal(dir, jobId)
    journal.data = data
    return journal
  }

  items(): JournalItem[] {
    return this.data?.items.map((item) => ({ ...item })) ?? []
  }

  /** Records a copy as planned, before it is moved. */
  plan(item: Omit<JournalItem, "status">): Promise<void> {
    return this.write(() => {
      this.data ??= { version: 1, jobId: this.jobId, at: new Date().toISOString(), items: [] }
      this.data.items.push({ ...item, status: "planned" })
    })
  }

  set(staged: string, status: JournalStatus, error?: string): Promise<void> {
    return this.write(() => {
      const item = this.data?.items.find((i) => i.staged === staged)
      if (!item) return
      item.status = status
      if (error) item.error = error
      else delete item.error
    })
  }

  /** Forgets a planned copy that was never moved (the move failed or was refused). */
  drop(staged: string): Promise<void> {
    return this.write(() => {
      if (this.data) this.data.items = this.data.items.filter((i) => i.staged !== staged)
    })
  }

  status(staged: string): JournalStatus | null {
    return this.data?.items.find((i) => i.staged === staged)?.status ?? null
  }

  /** Deletes the journal once nothing is open. True when it is gone (or was never written). */
  async settle(): Promise<boolean> {
    await this.queue
    if (!this.data) return true
    if (this.data.items.some(isOpen)) return false
    await unlink(this.file).catch(() => {})
    this.data = null
    return true
  }

  private write(change: () => void): Promise<void> {
    const next = this.queue.then(async () => {
      change()
      if (!this.data) return
      if (this.data.items.length === 0) {
        await unlink(this.file).catch(() => {})
        return
      }
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await atomicWrite(this.file, JSON.stringify(this.data, null, 2) + "\n", 0o600, { durable: true })
    })
    this.queue = next.catch(() => {})
    return next
  }
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID.test(value)
}

function journalPath(dir: string, jobId: string): string {
  if (!isJobId(jobId)) throw new Error(`not a job id: ${jobId}`)
  return join(dir, `${jobId}.json`)
}

/** Every readable journal in `dir`. A malformed one is skipped (its trash dirs then show as unknown). */
export async function readJournals(dir: string): Promise<JournalFile[]> {
  const names = await readdir(dir).catch(() => [])
  const out: JournalFile[] = []
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || !isJobId(name.slice(0, -5))) continue
    const data = await readJournal(join(dir, name))
    if (data) out.push(data)
  }
  return out
}

async function readJournal(path: string): Promise<JournalFile | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<JournalFile>
    if (raw.version !== 1 || !isJobId(raw.jobId) || typeof raw.at !== "string" || !Array.isArray(raw.items)) return null
    const items = raw.items.filter(
      (i): i is JournalItem =>
        !!i &&
        typeof i.original === "string" &&
        typeof i.staged === "string" &&
        typeof i.scope === "string" &&
        typeof i.dev === "number" &&
        typeof i.ino === "number" &&
        typeof i.full === "string" &&
        ["planned", "staged", "restored", "deleted", "purging", "purge_failed"].includes(i.status as string)
    )
    return { version: 1, jobId: raw.jobId, at: raw.at, items }
  } catch {
    return null
  }
}
