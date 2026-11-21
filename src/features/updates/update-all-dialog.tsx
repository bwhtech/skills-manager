import { useMemo, useRef, useState, type RefObject } from "react"
import { useQueries, type UseQueryResult } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowRight01Icon, CircleArrowUp02Icon, Delete02Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { ScopeKey, SkillSummary, UpdatePreview } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  api,
  errorMessage,
  isBeingUpdated,
  previewFailure,
  updatePreviewQuery,
  useJobMutation,
  useRunningUpdates,
  useScopes,
  useSkills,
  useUpdates,
} from "@/lib/api"
import { plural, scopeLabel } from "@/lib/format"
import { ui, useUi } from "@/lib/ui-store"
import { ambiguousInScope, deletedInScope, removalPlanFor, skillForCliName } from "@/lib/upstream"
import { cn } from "@/lib/utils"
import { showJob } from "@/features/jobs/job-store"
import { AmbiguousUpstreamNote, confirmLabel, copies, DeletedUpstreamSection, useDeletedChoices } from "./deleted-upstream"
import { DiffLayoutToggle, FileChangeList, preloadDiffView } from "./file-changes"
import { LineCounts, OverwriteWarning, overwritesFiles, summaryText } from "./preview-parts"
import { PreviewError, PreviewLoading, TOO_LARGE_LABEL, UpToDateNote } from "./preview-states"
import { CONFIRM_WRAP, UpdateDialogBody, UpdateDialogFooter, UpdateDialogHeader, UpdateDialogShell } from "./update-dialog-shell"

/** Rendered once in App; ui.openUpdateAll(scope) opens it. */
export function UpdateAllDialog() {
  const { updateAllScope } = useUi()
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Keep the scope while the dialog animates out.
  const [shownScope, setShownScope] = useState(updateAllScope)
  if (updateAllScope && updateAllScope !== shownScope) setShownScope(updateAllScope)
  const scope = updateAllScope ?? shownScope

  return (
    <UpdateDialogShell
      open={!!updateAllScope}
      onOpenChange={(open) => !open && ui.closeUpdateAll()}
      initialFocus={cancelRef}
    >
      {/* The popup unmounts when closed, so each open starts fresh. */}
      {scope && <UpdateAllForm scope={scope} cancelRef={cancelRef} />}
    </UpdateDialogShell>
  )
}

const RUNNING_LABEL = "Update running…"

interface Row {
  name: string
  /** the folder whose preview the row shows; null if the skill list does not have it */
  skill: SkillSummary | null
}

/**
 * One row per skill name with an update. The CLI updates by its own name (the lock
 * key), which can differ from the display name, so rows match on cliName. When a name
 * has several folders, the preview uses the .agents/skills one (see skillForCliName).
 */
function useRows(scope: ScopeKey) {
  const status = useUpdates().data
  const skills = useSkills(scope)
  const rows = useMemo<Row[]>(() => {
    const names = [...new Set(status?.available.filter((item) => item.scope === scope).map((item) => item.name))]
    return names.map((name) => ({ name, skill: skillForCliName(skills.data, scope, name) }))
  }, [status, skills.data, scope])
  return {
    rows,
    deleted: deletedInScope(status, scope),
    ambiguous: ambiguousInScope(status, scope),
    loading: !status || skills.isPending,
  }
}

function UpdateAllForm({ scope, cancelRef }: { scope: ScopeKey; cancelRef: RefObject<HTMLButtonElement | null> }) {
  const projects = useScopes().data?.projects
  const scopeName = scopeLabel(scope, projects)
  const { rows, deleted, ambiguous, loading } = useRows(scope)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [loadAll, setLoadAll] = useState(false)
  /** the user's own choices; rows without one follow their default */
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const run = useJobMutation(api.runUpdate)
  const running = useRunningUpdates()
  const status = useUpdates().data
  const deletedChoices = useDeletedChoices(
    deleted,
    (name) => removalPlanFor(status, scope, name),
    (name) => (isBeingUpdated(running, scope, name) ? "Running…" : null)
  )
  const remove = deletedChoices.selected

  // Fetch a row's preview only once it is expanded (or on "Load all summaries");
  // the shared limiter keeps 3 fetches in flight at most.
  const previews = useQueries({
    queries: rows.map((row) => updatePreviewQuery(row.skill?.id ?? null, loadAll || expanded.has(row.name))),
  })

  // Why a row cannot be picked: an update of it is queued or running already,
  // or its preview says skills update would skip it (400) or fail (409).
  // That wins over the user's own choice.
  const isRunning = (row: Row) => isBeingUpdated(running, scope, row.name)
  const blockReason = (row: Row, index: number): string | null => {
    if (isRunning(row)) return RUNNING_LABEL
    const query = previews[index]
    if (query?.isError) {
      const failure = previewFailure(query.error)
      if (failure.blocking) return `Cannot update: ${failure.message}`
    }
    return null
  }
  const isChecked = (row: Row, index: number) => !blockReason(row, index) && (choices.get(row.name) ?? true)
  const selectable = rows.filter((row, index) => !blockReason(row, index))
  const selected = rows.filter(isChecked)
  const allChecked = selectable.length > 0 && selected.length === selectable.length
  const someChecked = selected.length > 0 && !allChecked
  const loadedCount = previews.filter((query) => query.isSuccess || query.isError).length

  const setChecked = (name: string, checked: boolean) => setChoices((prev) => new Map(prev).set(name, checked))
  // Only rows that can be picked: a blocked row keeps no choice to come back with.
  const setAll = (checked: boolean) => setChoices(new Map(selectable.map((row) => [row.name, checked])))
  const toggleExpanded = (name: string, open: boolean) => {
    if (open) preloadDiffView()
    setExpanded((prev) => {
      const next = new Set(prev)
      if (open) next.add(name)
      else next.delete(name)
      return next
    })
  }

  const confirm = () => {
    // Checked again here: a blocked row must never be sent, whatever the checkboxes said.
    const names = rows.filter((row, index) => !blockReason(row, index) && isChecked(row, index)).map((row) => row.name)
    if (names.length === 0 && remove.length === 0) return
    run.mutate(
      // names empty + remove: the job only removes.
      { scope, names, ...(remove.length ? { remove, removePlans: deletedChoices.removePlans } : {}) },
      {
        onSuccess: ({ jobId }) => {
          ui.closeUpdateAll()
          showJob(jobId)
        },
        onError: (error) => toast.error("Could not start the update", { description: errorMessage(error) }),
      }
    )
  }

  return (
    <>
      <UpdateDialogHeader
        title={
          rows.length
            ? `Update ${plural(rows.length, "skill")} in ${scopeName}?`
            : deletedChoices.items.length
              ? `Remove ${plural(deletedChoices.items.length, "deleted skill")} in ${scopeName}?`
              : deleted.length
                ? `Deleted upstream skills in ${scopeName}`
              : `Update skills in ${scopeName}`
        }
        description={
          deleted.length && !rows.length
            ? "These skills are gone from their source. Untick a skill to keep it."
            : "Pick the skills to update. Expand a skill to see what changes before you confirm."
        }
      />
      <UpdateDialogBody>
        {(rows.length > 0 || loading) && (
          <OverwriteWarning detail="Each selected skill is replaced with its upstream version: modified files are overwritten and files that upstream removed are deleted." />
        )}
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-11 rounded-2xl" />
            <Skeleton className="h-11 rounded-2xl" />
            <Skeleton className="h-11 rounded-2xl" />
          </div>
        ) : rows.length === 0 ? (
          deleted.length === 0 && <p className="text-sm text-muted-foreground">No updates available in {scopeName}.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2.5 py-1 pr-2 text-sm pointer-coarse:min-h-11">
                <Checkbox
                  checked={allChecked}
                  indeterminate={someChecked}
                  disabled={selectable.length === 0}
                  onCheckedChange={(checked) => setAll(checked)}
                  aria-label="Select all"
                />
                {selected.length} of {rows.length} selected
                {selectable.length < rows.length && (
                  <span className="text-muted-foreground">· {rows.length - selectable.length} unavailable</span>
                )}
              </label>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={loadAll && loadedCount === rows.length}
                  onClick={() => setLoadAll(true)}
                >
                  {loadAll && loadedCount < rows.length && <Spinner />}
                  {loadAll
                    ? loadedCount < rows.length
                      ? `Loading ${loadedCount} of ${rows.length}…`
                      : "All summaries loaded"
                    : "Load all summaries"}
                </Button>
                <DiffLayoutToggle />
              </div>
            </div>
            <ul className="flex flex-col gap-2">
              {rows.map((row, index) => (
                <SkillRow
                  key={row.name}
                  row={row}
                  preview={previews[index]}
                  checked={isChecked(row, index)}
                  blockedReason={blockReason(row, index)}
                  running={isRunning(row)}
                  onCheckedChange={(checked) => setChecked(row.name, checked)}
                  open={expanded.has(row.name)}
                  onOpenChange={(open) => toggleExpanded(row.name, open)}
                />
              ))}
            </ul>
          </>
        )}
        {!loading && <DeletedUpstreamSection scope={scope} choices={deletedChoices} />}
        {!loading && <AmbiguousUpstreamNote items={ambiguous} />}
      </UpdateDialogBody>
      <UpdateDialogFooter>
        <p className="mr-auto min-w-0 truncate text-xs text-muted-foreground max-md:col-span-2 max-md:mr-0">
          {selected.length || remove.length
            ? [
                selected.length && `${plural(selected.length, "skill")} will be updated`,
                remove.length && `${remove.length} removed`,
                deletedChoices.copyCount && `${copies(deletedChoices.copyCount)} deleted`,
              ]
                .filter(Boolean)
                .join(" · ")
            : "No skills selected."}
        </p>
        <Button ref={cancelRef} variant="outline" onClick={() => ui.closeUpdateAll()}>
          Cancel
        </Button>
        <Button
          variant={selected.length === 0 && remove.length ? "destructive" : "default"}
          className={CONFIRM_WRAP}
          disabled={(selected.length === 0 && remove.length === 0) || run.isPending}
          onClick={confirm}
        >
          {run.isPending ? (
            <Spinner />
          ) : (
            <HugeiconsIcon icon={selected.length === 0 && remove.length ? Delete02Icon : CircleArrowUp02Icon} strokeWidth={2} />
          )}
          {confirmLabel(selected.length, remove.length, deletedChoices.copyCount)}
        </Button>
      </UpdateDialogFooter>
    </>
  )
}

interface SkillRowProps {
  row: Row
  preview: UseQueryResult<UpdatePreview> | undefined
  checked: boolean
  /** set when the row cannot be picked; the checkbox is off and disabled */
  blockedReason: string | null
  /** an update of this skill is queued or running */
  running: boolean
  onCheckedChange: (checked: boolean) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

function SkillRow({ row, preview, checked, blockedReason, running, onCheckedChange, open, onOpenChange }: SkillRowProps) {
  return (
    <li className={cn("rounded-2xl border transition-colors", !checked && "bg-muted/30")}>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex items-stretch">
          <label
            className={cn(
              "flex shrink-0 items-center pr-1 pl-3 pointer-coarse:pr-2 pointer-coarse:pl-3.5",
              blockedReason ? "cursor-not-allowed" : "cursor-pointer"
            )}
            title={blockedReason ?? undefined}
          >
            <Checkbox
              checked={checked}
              disabled={!!blockedReason}
              onCheckedChange={onCheckedChange}
              aria-label={blockedReason ? `Update ${row.name}: ${blockedReason}` : `Update ${row.name}`}
            />
          </label>
          <CollapsibleTrigger
            className={cn(
              "group/row flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-r-2xl py-2 pr-3 pl-2 text-left outline-none pressable",
              "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset no-hover:hover:bg-transparent",
              "max-sm:flex-wrap"
            )}
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open/row:rotate-90 motion-reduce:transition-none"
            />
            <span className={cn("min-w-0 truncate text-sm font-medium", !checked && "text-muted-foreground")}>
              {row.name}
            </span>
            {row.skill?.source && (
              <span className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground lg:inline">
                {row.skill.source.source}
              </span>
            )}
            <RowStatus row={row} preview={preview} running={running} />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 border-t px-3 py-3">
            <RowDetails row={row} preview={preview} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/** The right side of a row: the summary once the preview loaded. */
function RowStatus({
  row,
  preview,
  running,
}: {
  row: Row
  preview: UseQueryResult<UpdatePreview> | undefined
  running: boolean
}) {
  const className = "ml-auto flex min-w-0 shrink items-center gap-2 pl-2 text-xs text-muted-foreground max-sm:basis-full max-sm:pl-5.5"
  if (running) {
    return (
      <span className={className}>
        <Spinner className="size-3.5" /> {RUNNING_LABEL}
      </span>
    )
  }
  if (!row.skill) return <span className={className}>No preview: skill folder not found</span>
  // Not fetched yet: it loads when the row opens.
  if (!preview || (preview.fetchStatus === "idle" && preview.isPending)) return null
  if (preview.isPending) {
    return (
      <span className={className}>
        <Spinner className="size-3.5" /> Fetching upstream…
      </span>
    )
  }
  if (preview.isError) {
    const { blocking, tooLarge, message } = previewFailure(preview.error)
    return (
      <span className={cn(className, blocking && "text-destructive")} title={message}>
        <span className="truncate">
          {blocking ? `Cannot update: ${message}` : tooLarge ? TOO_LARGE_LABEL : "Preview failed"}
        </span>
      </span>
    )
  }
  const data = preview.data
  if (data.upToDate) return <span className={className}>Up to date</span>
  return (
    <span className={className}>
      {overwritesFiles(data) && (
        <HugeiconsIcon
          icon={Alert02Icon}
          strokeWidth={2}
          className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-label="Overwrites or removes files"
          role="img"
        />
      )}
      <span className="truncate max-sm:hidden">{summaryText(data.summary)}</span>
      <span className="truncate sm:hidden">
        {plural(data.summary.added + data.summary.removed + data.summary.modified, "file")} changed
      </span>
      <LineCounts added={data.summary.linesAdded} removed={data.summary.linesRemoved} />
    </span>
  )
}

function RowDetails({ row, preview }: { row: Row; preview: UseQueryResult<UpdatePreview> | undefined }) {
  if (!row.skill || !preview) {
    return <p className="text-xs text-muted-foreground">This skill is not in the skill list, so there is no preview.</p>
  }
  if (preview.isPending) return <PreviewLoading />
  if (preview.isError) {
    return <PreviewError error={preview.error} onRetry={() => void preview.refetch()} retrying={preview.isFetching} />
  }
  if (preview.data.upToDate) return <UpToDateNote />
  // The row above already shows the summary.
  return <FileChangeList files={preview.data.files} />
}
