import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons"

export function ValidationBanner({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b bg-destructive/8 px-4 py-2 text-xs text-destructive dark:bg-destructive/15"
    >
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="mt-px size-3.5 shrink-0" />
      <ul className="flex flex-col gap-0.5">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  )
}

export function WarningLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
      <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} className="size-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  )
}
