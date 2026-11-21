import { HugeiconsIcon } from "@hugeicons/react"
import { AlertCircleIcon, CheckmarkCircle02Icon, RefreshIcon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { previewFailure } from "@/lib/api"
import { cn } from "@/lib/utils"

/** 413 preview_too_large: shown as a note, not as a failure. */
export const TOO_LARGE_LABEL = "Preview too large to show — update still possible"

export function PreviewLoading({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)} aria-busy="true">
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner />
        Fetching upstream…
      </p>
      <Skeleton className="h-4 w-72 max-w-full rounded-lg" />
      <Skeleton className="h-14 rounded-2xl" />
      <Skeleton className="h-9 rounded-2xl" />
    </div>
  )
}

/**
 * A failed preview. 400 and 409 mean the update cannot run (the caller disables
 * Confirm). 413 means only the preview is too large: the update can still run,
 * and a retry would fail the same way. 502, 504 and the rest are fetch
 * problems that a retry may fix.
 */
export function PreviewError({
  error,
  onRetry,
  retrying,
  className,
}: {
  error: unknown
  onRetry: () => void
  retrying: boolean
  className?: string
}) {
  const { status, message, blocking, tooLarge } = previewFailure(error)
  const retryable = !blocking && !tooLarge
  const title = blocking
    ? "This skill cannot be updated"
    : tooLarge
      ? TOO_LARGE_LABEL
      : status === 504
      ? "Fetching upstream timed out"
      : status === 502
        ? "Could not fetch upstream"
        : "Could not load the preview"
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-2xl border px-3 py-2.5 text-sm",
        blocking ? "border-destructive/30 bg-destructive/10" : "border-border bg-muted/50",
        className
      )}
    >
      <HugeiconsIcon
        icon={AlertCircleIcon}
        strokeWidth={2}
        className={cn("mt-0.5 size-4 shrink-0", blocking ? "text-destructive" : "text-muted-foreground")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium">{title}</span>
        <span className="text-xs break-words text-muted-foreground">{message}</span>
        {retryable && (
          <span className="text-xs text-muted-foreground">You can retry, or update without a preview.</span>
        )}
      </div>
      {retryable && (
        <Button variant="outline" size="sm" className="shrink-0" disabled={retrying} onClick={onRetry}>
          {retrying ? <Spinner /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />}
          Retry
        </Button>
      )}
    </div>
  )
}

export function UpToDateNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-center gap-2 text-sm", className)}>
      <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-4 text-emerald-600 dark:text-emerald-400" />
      Already up to date with upstream. The files on disk match the latest version.
    </p>
  )
}
