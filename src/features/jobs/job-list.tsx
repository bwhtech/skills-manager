import type { Job } from "@shared/api"
import { timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { JobStatusIcon } from "./job-status-icon"

interface JobListProps {
  jobs: Job[]
  selectedId: string | null
  onSelect: (jobId: string) => void
}

export function JobList({ jobs, selectedId, onSelect }: JobListProps) {
  return (
    <ul className="flex flex-col gap-0.5" aria-label="Jobs">
      {jobs.map((job) => (
        <li key={job.id}>
          <button
            type="button"
            onClick={() => onSelect(job.id)}
            aria-current={job.id === selectedId ? "true" : undefined}
            className={cn(
              "pressable flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm outline-none hover:bg-muted pointer-coarse:h-11 focus-visible:ring-2 focus-visible:ring-ring/50",
              job.id === selectedId && "bg-muted font-medium"
            )}
          >
            <JobStatusIcon status={job.status} />
            <span className="min-w-0 flex-1 truncate">{job.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {timeAgo(job.startedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
