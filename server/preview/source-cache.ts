import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { cacheKey, type SourceSpec } from "./plan.ts"

/** A SKILL.md in a fetched source. */
export interface SkillMdRef {
  /** source-relative posix path, e.g. skills/foo/SKILL.md */
  path: string
  /** the skill name, when the source tells it without reading the file */
  name?: string
}

/** A fetched source on disk. */
export interface Checkout {
  /** commit sha, if known */
  readonly ref: string | null
  listSkillMds(): Promise<SkillMdRef[]>
  /** absolute path of a repo-relative folder, fetched on demand */
  folder(path: string): Promise<string>
}

/** Fetches `spec` into the empty dir `dir`. Must give up by `signal`. */
export type Fetcher = (
  spec: SourceSpec,
  dir: string,
  signal: AbortSignal
) => Promise<Checkout>

export interface Lease {
  checkout: Checkout
  fetchedAt: string
  release(): void
}

export interface SourceCacheOptions {
  root: string
  ttlMs: number
  maxConcurrent: number
  timeoutMs: number
}

interface Entry {
  key: string
  dir: string
  checkout: Checkout
  fetchedAt: string
  users: number
  expired: boolean
  timer: ReturnType<typeof setTimeout>
}

/**
 * One fetch per (source, ref), shared by every skill from it. Concurrent
 * requests for one key share one fetch; at most `maxConcurrent` fetches run
 * at once. Entries expire after the TTL; a dir is deleted once no preview
 * still reads it.
 */
export class SourceCache {
  private readonly entries = new Map<string, Entry>()
  private readonly inFlight = new Map<string, Promise<Entry>>()
  private readonly slots: Semaphore

  constructor(
    private readonly fetcher: Fetcher,
    private readonly options: SourceCacheOptions
  ) {
    this.slots = new Semaphore(options.maxConcurrent)
  }

  /** Deletes what an earlier run left behind. Call once at startup. */
  async init(): Promise<void> {
    await rm(this.options.root, { recursive: true, force: true })
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
  }

  async acquire(spec: SourceSpec): Promise<Lease> {
    const key = cacheKey(spec)
    const entry = this.entries.get(key) ?? (await this.fetchShared(key, spec))
    entry.users++
    let released = false
    return {
      checkout: entry.checkout,
      fetchedAt: entry.fetchedAt,
      release: () => {
        if (released) return
        released = true
        entry.users--
        if (entry.expired && entry.users === 0) void this.dispose(entry)
      },
    }
  }

  /** Runs fn inside a fetch slot: for follow-up fetches like sparse checkouts. */
  limit<T>(fn: () => Promise<T>): Promise<T> {
    return this.slots.run(fn)
  }

  invalidate(key: string): void {
    const entry = this.entries.get(key)
    if (entry) this.expire(entry)
  }

  invalidateAll(): void {
    for (const entry of [...this.entries.values()]) this.expire(entry)
  }

  get size(): number {
    return this.entries.size
  }

  private fetchShared(key: string, spec: SourceSpec): Promise<Entry> {
    const running = this.inFlight.get(key)
    if (running) return running
    const fetching = this.slots.run(() => this.fetch(key, spec))
    this.inFlight.set(key, fetching)
    const clear = () => {
      if (this.inFlight.get(key) === fetching) this.inFlight.delete(key)
    }
    fetching.then(clear, clear)
    return fetching
  }

  private async fetch(key: string, spec: SourceSpec): Promise<Entry> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
    const dir = await mkdtemp(join(this.options.root, "src-"))
    const signal = AbortSignal.timeout(this.options.timeoutMs)
    let checkout: Checkout
    try {
      checkout = await this.fetcher(spec, dir, signal)
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    const entry: Entry = {
      key,
      dir,
      checkout,
      fetchedAt: new Date().toISOString(),
      users: 0,
      expired: false,
      timer: setTimeout(() => this.expire(entry), this.options.ttlMs),
    }
    entry.timer.unref?.()
    this.entries.set(key, entry)
    return entry
  }

  private expire(entry: Entry): void {
    if (entry.expired) return
    entry.expired = true
    clearTimeout(entry.timer)
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    if (entry.users === 0) void this.dispose(entry)
  }

  private async dispose(entry: Entry): Promise<void> {
    await rm(entry.dir, { recursive: true, force: true }).catch((err) =>
      console.error(`could not delete ${entry.dir}:`, err)
    )
  }
}

/** Runs at most `max` tasks at once, in arrival order. */
export class Semaphore {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max)
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active++
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}
