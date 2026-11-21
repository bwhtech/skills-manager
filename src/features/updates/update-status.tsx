import { HugeiconsIcon } from "@hugeicons/react"
import { CircleArrowUp02Icon, RefreshIcon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { ScopeKey, UpdateStatus as Status } from "@shared/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { errorMessage, useCheckUpdates, useScopes, useUpdates } from "@/lib/api"
import { basename, plural, scopeLabel, timeAgo } from "@/lib/format"
import { navigate } from "@/lib/hash-state"
import { ui } from "@/lib/ui-store"

/** Skill names with an update, counted per scope. */
export function countUpdatesByScope(status: Status | undefined): Map<ScopeKey, number> {
  const counts = new Map<ScopeKey, number>()
  for (const item of status?.available ?? []) counts.set(item.scope, (counts.get(item.scope) ?? 0) + 1)
  return counts
}

/** The update counts per scope, for the sidebar. */
export function useUpdateCounts() {
  return countUpdatesByScope(useUpdates().data)
}

export interface OtherScope {
  scope: ScopeKey
  name: string
  count: number
}

/**
 * Update check state and actions for the scope on screen; shared by the
 * desktop header and the phone menu. Counts are for this scope; other scopes
 * with updates are listed apart, so a count never reads as "updates here".
 * Check failures count across scopes and are labeled as errors.
 */
export function useUpdateActions(scope: ScopeKey) {
  const updates = useUpdates()
  const check = useCheckUpdates()
  const projects = useScopes().data?.projects
  const status = updates.data
  const checking = !!status?.checking || check.isPending
  const scopeName = scopeLabel(scope, projects)
  const inScope = status?.available.filter((item) => item.scope === scope) ?? []
  const others: OtherScope[] = [...countUpdatesByScope(status)]
    .filter(([other]) => other !== scope)
    .map(([other, count]) => ({ scope: other, name: scopeLabel(other, projects), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const otherTotal = others.reduce((sum, other) => sum + other.count, 0)
  const failed = status?.failed ?? []

  const refresh = () =>
    check.mutate(undefined, {
      onError: (error) => toast.error("Could not start the update check", { description: errorMessage(error) }),
    })

  // Opens the confirm dialog with a per-skill preview; the dialog runs the update.
  const updateAll = () => ui.openUpdateAll(scope)

  /** "3 updates in User", or "User is up to date" */
  const headline = !status?.checkedAt
    ? "Not checked yet"
    : inScope.length
      ? `${plural(inScope.length, "update")} in ${scopeName}`
      : `${scopeName} is up to date`
  /** "62 in other projects", or "" */
  const otherLine = otherTotal ? `${otherTotal} in ${otherScopesLabel(others)}` : ""
  /** when the last check ran */
  const summary = status?.checkedAt ? `Checked ${timeAgo(status.checkedAt)}` : "Not checked yet"
  /** check failures: errors, never counted as updates */
  const errorLine = status?.error ? "Some checks failed" : ""

  return {
    status,
    checking,
    scopeName,
    inScope,
    others,
    otherTotal,
    failed,
    headline,
    otherLine,
    summary,
    errorLine,
    refresh,
    updateAll,
  }
}

function otherScopesLabel(others: OtherScope[]) {
  const user = others.some((other) => other.scope === "user")
  const projects = others.some((other) => other.scope !== "user")
  if (user && projects) return "User and other projects"
  if (user) return "User"
  return others.length === 1 ? others[0].name : "other projects"
}

export function UpdateStatus({ scope, scopeName }: { scope: ScopeKey; scopeName: string }) {
  const actions = useUpdateActions(scope)
  const { status, checking, inScope, otherTotal, summary, errorLine, refresh, updateAll } = actions
  const showBadge = !!status && (inScope.length > 0 || otherTotal > 0 || !!status.error)

  return (
    <div className="flex items-center gap-1.5">
      {showBadge && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1"
                aria-label={`${actions.headline}${actions.otherLine ? `, ${actions.otherLine}` : ""}. Show details`}
              />
            }
          >
            <ScopeBadge actions={actions} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <UpdateOverview actions={actions} />
          </DropdownMenuContent>
        </DropdownMenu>
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
        <TooltipContent>{checking ? "Checking for updates…" : `Check for updates · ${summary}${errorLine ? ` · ${errorLine}` : ""}`}</TooltipContent>
      </Tooltip>
    </div>
  )
}

type Actions = ReturnType<typeof useUpdateActions>

/** This scope's count; other scopes only as a quieter outline when this one has none. */
function ScopeBadge({ actions }: { actions: Actions }) {
  const { status, inScope, otherTotal } = actions
  if (inScope.length > 0) {
    return (
      <Badge className="h-6 px-2 tabular-nums">
        {plural(inScope.length, "update")}
        {status?.error && " · errors"}
      </Badge>
    )
  }
  if (otherTotal > 0) {
    return (
      <Badge variant="outline" className="h-6 px-2 font-normal text-muted-foreground tabular-nums">
        {actions.otherLine}
        {status?.error && " · errors"}
      </Badge>
    )
  }
  return (
    <Badge variant="destructive" className="h-6 px-2">
      Check errors
    </Badge>
  )
}

const MAX_LISTED = 8

/**
 * The menu body: this scope's state, the other scopes with updates (each
 * opens that scope), and the check errors. Used by the desktop badge and
 * the phone menu.
 */
export function UpdateOverview({ actions, compact = false }: { actions: Actions; compact?: boolean }) {
  const { others, failed, status } = actions
  const listed = others.slice(0, compact ? 5 : MAX_LISTED)
  return (
    <>
      {!compact && (
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">{actions.headline}</span>
            <span className="text-xs font-normal">
              {actions.summary}
              {actions.errorLine && ` · ${actions.errorLine}`}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
      )}
      {others.length > 0 && (
        <>
          {!compact && <DropdownMenuSeparator />}
          <DropdownMenuGroup>
            <DropdownMenuLabel>{actions.otherLine}</DropdownMenuLabel>
            {listed.map((other) => (
              <DropdownMenuItem key={other.scope} onClick={() => navigate({ scope: other.scope })}>
                <span className="min-w-0 flex-1 truncate">{other.name}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                  {plural(other.count, "update")}
                </span>
              </DropdownMenuItem>
            ))}
            {others.length > listed.length && (
              <DropdownMenuLabel className="font-normal">
                and {others.length - listed.length} more: see the counts in the sidebar
              </DropdownMenuLabel>
            )}
          </DropdownMenuGroup>
        </>
      )}
      {status?.error && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-destructive">
              {failed.length ? `Check errors (${failed.length})` : "Check errors"}
            </DropdownMenuLabel>
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto px-2 pb-1.5 text-xs text-muted-foreground">
              {failed.length === 0 && <li className="break-words">{status.error}</li>}
              {failed.slice(0, 8).map((item, i) => (
                <li key={i} className="break-all">
                  ✗ {item.name}: {item.reason}
                  {item.scope !== "user" && ` (${basename(item.scope)})`}
                </li>
              ))}
              {failed.length > 8 && <li>and {failed.length - 8} more</li>}
            </ul>
          </DropdownMenuGroup>
        </>
      )}
    </>
  )
}
