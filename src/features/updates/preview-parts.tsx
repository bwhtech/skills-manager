import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, FileAddIcon, FileEditIcon, FileRemoveIcon } from "@hugeicons/core-free-icons"
import type { UpdateFileChange, UpdatePreview } from "@shared/api"
import { plural } from "@/lib/format"
import { cn } from "@/lib/utils"
import { OVERWRITE_WARNING } from "./copy"


const STATUS = {
  added: { icon: FileAddIcon, label: "Added", className: "text-emerald-600 dark:text-emerald-400" },
  removed: { icon: FileRemoveIcon, label: "Removed", className: "text-red-600 dark:text-red-400" },
  modified: { icon: FileEditIcon, label: "Modified", className: "text-amber-600 dark:text-amber-400" },
} as const

export function FileStatusIcon({ status, className }: { status: UpdateFileChange["status"]; className?: string }) {
  const { icon, label, className: color } = STATUS[status]
  return (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={2}
      aria-label={label}
      role="img"
      className={cn("size-4 shrink-0", color, className)}
    />
  )
}

/** "+12 −40", green and red; a side is left out when it is 0 (both 0 shows nothing). */
export function LineCounts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null
  return (
    <span className={cn("shrink-0 font-mono text-xs tabular-nums", className)}>
      {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added.toLocaleString()}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-red-600 dark:text-red-400">−{removed.toLocaleString()}</span>}
    </span>
  )
}

/** "3 files changed · 1 added · 18 removed", without the line counts. */
export function summaryText(summary: UpdatePreview["summary"]) {
  const total = summary.added + summary.removed + summary.modified
  const parts = [`${plural(total, "file")} changed`]
  if (summary.modified) parts.push(`${summary.modified} modified`)
  if (summary.added) parts.push(`${summary.added} added`)
  if (summary.removed) parts.push(`${summary.removed} removed`)
  return parts.join(" · ")
}

export function PreviewSummary({ preview, className }: { preview: UpdatePreview; className?: string }) {
  const { summary } = preview
  return (
    <p className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm", className)}>
      <span>{summaryText(summary)}</span>
      {(summary.linesAdded > 0 || summary.linesRemoved > 0) && (
        <>
          <span aria-hidden className="text-muted-foreground">·</span>
          <LineCounts added={summary.linesAdded} removed={summary.linesRemoved} className="text-sm" />
        </>
      )}
    </p>
  )
}

/** Shown when the update replaces or deletes files that are on disk now. */
export function overwritesFiles(preview: UpdatePreview) {
  return preview.summary.modified > 0 || preview.summary.removed > 0
}

export function OverwriteWarning({ detail, className }: { detail?: string; className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200",
        className
      )}
    >
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{OVERWRITE_WARNING}</span>
        {detail && <span className="text-xs opacity-85">{detail}</span>}
      </div>
    </div>
  )
}

/** The commit or tree hash, short like git prints it. */
export function shortRef(ref: string | null) {
  return ref ? ref.slice(0, 7) : null
}

/** A web page for an "owner/repo" source, or the lock file's URL if it is one. */
export function sourceHref(source: string, sourceUrl?: string) {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return `https://github.com/${source}`
  if (sourceUrl && /^https?:\/\//.test(sourceUrl)) return sourceUrl.replace(/\.git$/, "")
  return null
}
