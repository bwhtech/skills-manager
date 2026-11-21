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
import { deletedInScope } from "@/lib/upstream"

export interface ScopeCounts {
  /** skill names with an update */
  updates: number
  /** skills deleted upstream (Update all offers to remove them) */
  deleted: number
}

/** Updates and deleted-upstream skills, counted per scope. */
export function countUpdatesByScope(status: Status | undefined): Map<ScopeKey, ScopeCounts> {
  const counts = new Map<ScopeKey, ScopeCounts>()
  const get = (scope: ScopeKey) => {
    const found = counts.get(scope) ?? { updates: 0, deleted: 0 }
    counts.set(scope, found)
    return found
  }
  for (const item of status?.available ?? []) get(item.scope).updates++
  for (const item of status?.deletedUpstream ?? []) get(item.scope).deleted++
  return counts
}

/** "3 updates · 1 deleted upstream", "1 deleted upstream", "3 updates"; short: "3 updates · 1 deleted". */
export function countsLabel({ updates, deleted }: ScopeCounts, short = false) {
  const gone = deleted && `${deleted} deleted${short ? "" : " upstream"}`
  return [updates && plural(updates, "update"), gone].filter(Boolean).join(" · ")
}

/** The update counts per scope, for the sidebar. */
export function useUpdateCounts() {
  return countUpdatesByScope(useUpdates().data)
}

export interface OtherScope {
  scope: ScopeKey
  name: string
  /** updates plus deleted-upstream skills */
  count: number
  counts: ScopeCounts
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
  const deletedHere = deletedInScope(status, scope)
  const counts: ScopeCounts = { updates: inScope.length, deleted: deletedHere.length }
  /** updates plus deleted-upstream skills here: what Update all acts on */
  const actionable = counts.updates + counts.deleted
  const others: OtherScope[] = [...countUpdatesByScope(status)]
    .filter(([other]) => other !== scope)
    .map(([other, c]) => ({ scope: other, name: scopeLabel(other, projects), count: c.updates + c.deleted, counts: c }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const otherTotal = others.reduce((sum, other) => sum + other.count, 0)
  const failed = status?.failed ?? []
  const scopeError = status?.scopeErrors?.find((item) => item.scope === scope)?.error ?? null

  const refresh = () =>
    check.mutate(undefined, {
      onError: (error) => toast.error("Could not start the update check", { description: errorMessage(error) }),
    })

  // Opens the confirm dialog with a per-skill preview; the dialog runs the update.
  const updateAll = () => ui.openUpdateAll(scope)

  /**
   * "3 updates · 1 deleted upstream in User", "Couldn't verify updates for User", or
   * "User is up to date": only after a check of this scope that did not fail.
   */
  const headline = !status?.checkedAt
    ? "Not checked yet"
    : actionable
      ? `${countsLabel(counts)} in ${scopeName}${scopeError ? " (some checks failed)" : ""}`
      : scopeError
        ? `Couldn't verify updates for ${scopeName}`
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
    deletedHere,
    counts,
    actionable,
    scopeError,
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
  const { status, checking, actionable, otherTotal, summary, errorLine, refresh, updateAll } = actions
  const showBadge = !!status && (actionable > 0 || otherTotal > 0 || !!status.error)

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
      {actionable > 0 && (
        <Button size="sm" className="h-7" onClick={updateAll}>
          <HugeiconsIcon icon={CircleArrowUp02Icon} strokeWidth={2} />
          <span className="hidden xl:inline">Update all in {scopeName}</span>
          <span className="xl:hidden">Update {actionable}</span>
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
  const { status, counts, actionable, otherTotal } = actions
  if (actionable > 0) {
    return (
      <Badge variant={counts.updates ? "default" : "destructive"} className="h-6 px-2 tabular-nums">
        {countsLabel(counts)}
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
                <span className="min-w-12 flex-1 truncate">{other.name}</span>
                <span
                  className="ml-auto min-w-0 shrink truncate text-xs text-muted-foreground tabular-nums"
                  title={countsLabel(other.counts)}
                >
                  {countsLabel(other.counts, true)}
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
