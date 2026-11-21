import type { Job } from "../shared/api.ts"

export type JobLog = (line: string) => void

export interface JobSpec {
  kind: Job["kind"]
  title: string
  command: string
  cwd: string
  /** does the work and returns an exit code */
  run: (log: JobLog) => Promise<number>
}

export type JobEvent =
  { type: "line"; line: string } | { type: "done"; job: Job }
type Listener = (event: JobEvent) => void

const KEEP = 50

/**
 * In-memory jobs. Runs one at a time in order, because CLI mutations share
 * lock files and skills dirs.
 */
export class JobManager {
  private readonly jobs: Job[] = []
  private readonly listeners = new Map<string, Set<Listener>>()
  private tail: Promise<void> = Promise.resolve()
  private active = 0

  constructor(private readonly onFinished: (job: Job) => void = () => {}) {}

  enqueue(spec: JobSpec): Job {
    const job: Job = {
      id: crypto.randomUUID(),
      kind: spec.kind,
      title: spec.title,
      command: spec.command,
      cwd: spec.cwd,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      log: [],
    }
    this.jobs.unshift(job)
    this.prune()
    if (this.active > 0)
      this.append(job, "Waiting for the previous job to finish…")
    this.active++
    this.tail = this.tail.then(() => this.execute(job, spec))
    return job
  }

  list(): Job[] {
    return this.jobs.slice(0, KEEP)
  }

  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id)
  }

  /** Returns an unsubscribe function. */
  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set()
    set.add(listener)
    this.listeners.set(id, set)
    return () => set.delete(listener)
  }

  private async execute(job: Job, spec: JobSpec): Promise<void> {
    job.startedAt = new Date().toISOString()
    this.append(job, `$ ${spec.command}`)
    let code: number
    try {
      code = await spec.run((line) => this.append(job, line))
    } catch (err) {
      this.append(job, `Error: ${(err as Error).message}`)
      code = 1
    }
    job.exitCode = code
    job.status = code === 0 ? "success" : "error"
    job.endedAt = new Date().toISOString()
    this.active--
    this.emit(job.id, { type: "done", job })
    this.listeners.delete(job.id)
    try {
      this.onFinished(job)
    } catch (err) {
      console.error(err)
    }
  }

  private append(job: Job, line: string): void {
    job.log.push(line)
    this.emit(job.id, { type: "line", line })
  }

  private emit(id: string, event: JobEvent): void {
    for (const listener of this.listeners.get(id) ?? []) listener(event)
  }

  // Never drop a job that is still running or waiting.
  private prune(): void {
    while (this.jobs.length > KEEP) {
      const oldest = this.jobs.findLastIndex((j) => j.status !== "running")
      if (oldest < 0) return
      this.jobs.splice(oldest, 1)
    }
  }
}
