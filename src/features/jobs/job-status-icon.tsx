import { HugeiconsIcon } from "@hugeicons/react"
import { CheckmarkCircle02Icon, MultiplicationSignCircleIcon } from "@hugeicons/core-free-icons"
import type { JobStatus } from "@shared/api"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

export function JobStatusIcon({ status, className }: { status: JobStatus; className?: string }) {
  if (status === "running") {
    return <Spinner className={cn("size-4 text-muted-foreground", className)} aria-label="Running" />
  }
  const ok = status === "success"
  return (
    <HugeiconsIcon
      icon={ok ? CheckmarkCircle02Icon : MultiplicationSignCircleIcon}
      strokeWidth={2}
      aria-label={ok ? "Succeeded" : "Failed"}
      className={cn("size-4 shrink-0", ok ? "text-primary-foreground dark:text-primary" : "text-destructive", className)}
    />
  )
}
