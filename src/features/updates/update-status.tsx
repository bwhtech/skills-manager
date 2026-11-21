import { HugeiconsIcon } from "@hugeicons/react"
import { CircleArrowUp02Icon, RefreshIcon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { ScopeKey } from "@shared/api"
import { InfoTip } from "@/components/info-tip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { errorMessage, useCheckUpdates, useUpdates } from "@/lib/api"
import { basename, plural, timeAgo } from "@/lib/format"
import { ui } from "@/lib/ui-store"

/** Update check state and actions for a scope; shared by the desktop header and the phone menu. */
export function useUpdateActions(scope: ScopeKey) {
  const updates = useUpdates()
  const check = useCheckUpdates()
  const status = updates.data
  const checking = !!status?.checking || check.isPending
  const total = status?.available.length ?? 0
  const inScope = status?.available.filter((item) => item.scope === scope) ?? []
  const failed = status?.failed ?? []

  const refresh = () =>
    check.mutate(undefined, {
      onError: (error) => toast.error("Could not start the update check", { description: errorMessage(error) }),
    })

  // Opens the confirm dialog with a per-skill preview; the dialog runs the update.
  const updateAll = () => ui.openUpdateAll(scope)

  const summary = status?.error
    ? `Some checks failed: ${status.error}`
    : status?.checkedAt
      ? `Checked ${timeAgo(status.checkedAt)}`
      : "Not checked yet"

  return { status, checking, total, inScope, failed, summary, refresh, updateAll }
}

export function UpdateStatus({ scope, scopeName }: { scope: ScopeKey; scopeName: string }) {
  const { status, checking, total, inScope, failed, summary, refresh, updateAll } = useUpdateActions(scope)

  return (
    <div className="flex items-center gap-1.5">
      {status && (total > 0 || status.error) && (
        <InfoTip
          render={
            <Badge
              variant={status.error ? "destructive" : "default"}
              tabIndex={0}
              className="h-6 px-2 tabular-nums"
            />
          }
          contentClassName="max-w-sm"
          content={
            <div className="flex flex-col gap-1">
              <span>{summary}</span>
              {total > 0 && (
                <span className="opacity-80">
                  {status.available.slice(0, 12).map((item) => item.name).join(", ")}
                  {total > 12 ? ` and ${total - 12} more` : ""}
                </span>
              )}
              {failed.length > 0 && (
                <ul className="flex flex-col gap-0.5 opacity-80">
                  {failed.slice(0, 8).map((item, i) => (
                    <li key={i} className="break-all">
                      ✗ {item.name}: {item.reason}
                      {item.scope !== "user" && ` (${basename(item.scope)})`}
                    </li>
                  ))}
                  {failed.length > 8 && <li>and {failed.length - 8} more</li>}
                </ul>
              )}
            </div>
          }
        >
          {status.error && total === 0 ? "Check failed" : plural(total, "update")}
          {status.error && total > 0 && " · some failed"}
        </InfoTip>
      )}
      {inScope.length > 0 && (
        <Button size="sm" className="h-7" onClick={updateAll}>
          <HugeiconsIcon icon={CircleArrowUp02Icon} strokeWidth={2} />
          <span className="hidden xl:inline">Update all in {scopeName}</span>
          <span className="xl:hidden">Update {inScope.length}</span>
        </Button>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={checking ? "Checking for updates" : "Check for updates"}
              disabled={checking}
              onClick={refresh}
            />
          }
        >
          {checking ? <Spinner /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />}
        </TooltipTrigger>
        <TooltipContent>{checking ? "Checking for updates…" : `Check for updates · ${summary}`}</TooltipContent>
      </Tooltip>
    </div>
  )
}
