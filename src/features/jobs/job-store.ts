import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import type { Job } from "@shared/api"
import { api, invalidateAfterJob } from "@/lib/api"
import { queryClient } from "@/lib/query-client"
import { ui } from "@/lib/ui-store"

// Live logs of running jobs. One EventSource per running job, shared by
// everything that shows it. Finished jobs are read from GET /api/jobs.

export interface LiveJob {
  lines: string[]
  /** set when the "done" event arrived */
  job: Job | null
}

const live = new Map<string, LiveJob>()
const sources = new Map<string, EventSource>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function update(jobId: string, patch: Partial<LiveJob>) {
  const current = live.get(jobId) ?? { lines: [], job: null }
  live.set(jobId, { ...current, ...patch })
  emit()
}

/** Start streaming a job's log. Safe to call many times. */
export function watchJob(jobId: string) {
  if (sources.has(jobId) || live.get(jobId)?.job) return

  const source = new EventSource(api.jobEventsUrl(jobId))
  sources.set(jobId, source)

  // The server replays the whole log on every connect, so start fresh
  // each time (this also covers automatic reconnects).
  source.addEventListener("open", () => update(jobId, { lines: [] }))
  source.addEventListener("line", (event) => {
    const line = parseLine((event as MessageEvent<string>).data)
    const current = live.get(jobId)
    update(jobId, { lines: [...(current?.lines ?? []), line] })
  })
  source.addEventListener("done", (event) => {
    source.close()
    sources.delete(jobId)
    const job = JSON.parse((event as MessageEvent<string>).data) as Job
    update(jobId, { job })
    onFinished(job)
  })
}

function parseLine(data: string) {
  try {
    const value: unknown = JSON.parse(data)
    return typeof value === "string" ? value : data
  } catch {
    return data
  }
}

function onFinished(job: Job) {
  invalidateAfterJob(queryClient)
  const action = { label: "Show log", onClick: () => ui.openJobs(job.id) }
  if (job.status === "success") {
    toast.success(job.title, { description: "Finished", action })
  } else {
    toast.error(job.title, {
      description: `Failed${job.exitCode === null ? "" : ` (exit ${job.exitCode})`}`,
      action,
    })
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLiveJob(jobId: string | null): LiveJob | null {
  return useSyncExternalStore(subscribe, () => (jobId ? (live.get(jobId) ?? null) : null))
}

/** Start a job's stream and show it in the jobs drawer. */
export function showJob(jobId: string) {
  watchJob(jobId)
  ui.openJobs(jobId)
}
