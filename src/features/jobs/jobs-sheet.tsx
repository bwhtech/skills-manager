import { useEffect } from "react"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage, useJobs } from "@/lib/api"
import { ui, useUi } from "@/lib/ui-store"
import { JobDetail } from "./job-detail"
import { JobList } from "./job-list"
import { watchJob } from "./job-store"

export function JobsSheet() {
  const { jobsOpen, selectedJobId } = useUi()
  const jobs = useJobs()

  // Stream every running job, so its end shows a toast and refreshes data
  // even when the drawer is closed.
  useEffect(() => {
    for (const job of jobs.data ?? []) if (job.status === "running") watchJob(job.id)
  }, [jobs.data])

  const list = jobs.data ?? []
  const found = list.find((job) => job.id === selectedJobId)
  // A job that was just started may not be in the list yet.
  const waiting = !!selectedJobId && !found && jobs.isFetching
  const selected = found ?? (waiting ? null : (list[0] ?? null))

  return (
    <Sheet open={jobsOpen} onOpenChange={ui.setJobsOpen}>
      {/* Phones: full width; header and log clear the notch and the home indicator. */}
      <SheetContent
        side="right"
        className="w-full gap-0 data-[side=right]:sm:max-w-2xl max-sm:data-[side=right]:w-full max-sm:data-[side=right]:border-l-0 pr-[env(safe-area-inset-right)] *:data-[slot=sheet-close]:top-[calc(1rem+env(safe-area-inset-top))] *:data-[slot=sheet-close]:right-[calc(1rem+env(safe-area-inset-right))] pointer-coarse:*:data-[slot=sheet-close]:size-11"
      >
        <SheetHeader className="pt-[calc(1.5rem+env(safe-area-inset-top))] pb-3 max-sm:px-4">
          <SheetTitle>Jobs</SheetTitle>
          <SheetDescription>Output of skills CLI runs on this server.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-sm:gap-3 max-sm:px-4 max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {jobs.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : jobs.isError ? (
            <p className="text-sm text-destructive">Could not load jobs: {errorMessage(jobs.error)}</p>
          ) : list.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No jobs yet</EmptyTitle>
                <EmptyDescription>Installs, updates and removals show their output here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="max-h-[30%] shrink-0 overflow-auto overscroll-contain">
                <JobList jobs={list} selectedId={selected?.id ?? null} onSelect={ui.selectJob} />
              </div>
              {waiting && <Skeleton className="min-h-0 flex-1" />}
              {selected && <JobDetail key={selected.id} job={selected} />}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
