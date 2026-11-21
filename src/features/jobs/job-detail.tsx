import type { Job } from "@shared/api"
import { CopyButton } from "@/components/copy-button"
import { useEffect } from "react"
import { useLiveJob, watchJob } from "./job-store"
import { JobLog } from "./job-log"
import { JobStatusIcon } from "./job-status-icon"

export function JobDetail({ job }: { job: Job }) {
  const liveJob = useLiveJob(job.id)
  const running = job.status === "running" && !liveJob?.job

  useEffect(() => {
    if (job.status === "running") watchJob(job.id)
  }, [job.id, job.status])

  const finished = liveJob?.job ?? job
  // The live stream replays the whole log, so prefer it once it caught up.
  const lines = liveJob && liveJob.lines.length >= job.log.length ? liveJob.lines : job.log
  const status = running ? "running" : finished.status

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <JobStatusIcon status={status} />
        <h3 className="min-w-0 flex-1 truncate font-medium">{job.title}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {status === "running"
            ? "Running"
            : status === "success"
              ? "Succeeded"
              : `Failed${finished.exitCode === null ? "" : ` · exit ${finished.exitCode}`}`}
        </span>
      </div>
      <div className="flex items-start gap-1 rounded-2xl border px-3 py-2 font-mono text-xs pointer-coarse:items-center">
        <div className="min-w-0 flex-1">
          <div className="break-all">
            <span className="text-muted-foreground select-none">$ </span>
            {job.command}
          </div>
          <div className="mt-1 truncate text-muted-foreground" title={job.cwd}>
            in {job.cwd}
          </div>
        </div>
        <CopyButton value={job.command} label="Copy command" />
      </div>
      <JobLog lines={lines} />
    </div>
  )
}
