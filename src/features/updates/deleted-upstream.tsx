import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowRight01Icon, Delete02Icon } from "@hugeicons/core-free-icons"
import type { RemovalCopy, RemovalPlan, ScopeKey, ShownRemovalPlan, UpstreamSkillRef } from "@shared/api"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { useScopes, useSkill, useSkills } from "@/lib/api"
import { plural, tildify } from "@/lib/format"
import { groupBySource, skillForCliName } from "@/lib/upstream"
import { cn } from "@/lib/utils"

// The "Will be removed — deleted upstream" part of the update dialogs. `skills update`
// skips skills that are gone from their source and, run non-interactively, never
// deletes them; the dialogs remove them in a second step of the same job.

export interface DeletedChoices {
  /**
   * the skills that can be offered: the server sent a plan that is not blocked, or that is
   * blocked only until its blocking copies are ticked (blockedUnlessCopies)
   */
  items: UpstreamSkillRef[]
  /** skills that are not offered, and why: the server would refuse them */
  dropped: { item: UpstreamSkillRef; reason: string; plan: RemovalPlan | null }[]
  planFor: (name: string) => RemovalPlan | null
  isChecked: (name: string) => boolean
  setChecked: (name: string, checked: boolean) => void
  /** why a skill cannot be picked (an update or remove of it is running), else null */
  blockReason: (name: string) => string | null
  /** blocking copies of the skill that are not ticked yet: it stays off until they are */
  untickedBlocking: (name: string) => RemovalCopy[]
  isCopyTicked: (path: string) => boolean
  setCopyTicked: (path: string, ticked: boolean) => void
  /** the CLI names to send as UpdateRunRequest.remove */
  selected: string[]
  /** ticked copies of the selected skills */
  copyCount: number
  /** UpdateRunRequest.removePlans: what the section showed and ticked for each selected name */
  removePlans: ({ name: string } & ShownRemovalPlan)[]
}

/**
 * Skills are ticked by default: the user asked for deleted skills to go automatically. Their
 * separate copies are not: each one is opt-in. A skill blocked only by copies is offered, but
 * stays off until all its blocking copies are ticked. The rest are listed as dropped.
 */
export function useDeletedChoices(
  all: UpstreamSkillRef[],
  planFor: (name: string) => RemovalPlan | null,
  blockReason: (name: string) => string | null = () => null
): DeletedChoices {
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [copyChoices, setCopyChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const items: UpstreamSkillRef[] = []
  const dropped: DeletedChoices["dropped"] = []
  for (const item of all) {
    const plan = planFor(item.name)
    if (!plan) dropped.push({ item, reason: "Not checked yet: refresh to see what would be removed.", plan })
    else if (plan.blocked && !plan.blockedUnlessCopies) dropped.push({ item, reason: plan.blocked, plan })
    else items.push(item)
  }
  const tooLarge = new Set(all.flatMap((item) => (planFor(item.name)?.copies ?? []).filter((c) => c.tooLargeToRemove).map((c) => c.path)))
  const isCopyTicked = (path: string) => !tooLarge.has(path) && (copyChoices.get(path) ?? false)
  const untickedBlocking = (name: string) =>
    (planFor(name)?.copies ?? []).filter((copy) => copy.blocking && !isCopyTicked(copy.path))
  const isChecked = (name: string) =>
    !blockReason(name) &&
    items.some((item) => item.name === name) &&
    untickedBlocking(name).length === 0 &&
    (choices.get(name) ?? true)
  const selected = items.filter((item) => isChecked(item.name)).map((item) => item.name)
  const tickedOf = (name: string) =>
    (planFor(name)?.copies ?? []).filter((copy) => isCopyTicked(copy.path)).map((copy) => copy.path)
  return {
    items,
    dropped,
    planFor,
    isChecked,
    blockReason,
    untickedBlocking,
    isCopyTicked,
    setCopyTicked: (path, ticked) => setCopyChoices((prev) => new Map(prev).set(path, ticked)),
    setChecked: (name, checked) => setChoices((prev) => new Map(prev).set(name, checked)),
    selected,
    copyCount: selected.reduce((sum, name) => sum + tickedOf(name).length, 0),
    removePlans: selected.map((name) => {
      const plan = planFor(name)
      return {
        name,
        willDelete: plan?.willDelete ?? [],
        copies: tickedOf(name),
        shownCopies: (plan?.copies ?? []).map((copy) => ({ path: copy.path, identical: copy.identical })),
      }
    }),
  }
}

/** "1 copy", "6 copies". */
export function copies(n: number) {
  return `${n} ${n === 1 ? "copy" : "copies"}`
}

/**
 * "Update 22 · remove 1", "Update · remove 1", "Remove 2 skills", "Update 3 skills", with
 * " · 6 copies" when separate copies are ticked: "Remove 6 skills · 6 copies".
 */
export function confirmLabel(updateCount: number | null, removeCount: number, copyCount = 0) {
  const tail = copyCount ? ` · ${copies(copyCount)}` : ""
  if (updateCount === 0) return removeCount ? `Remove ${plural(removeCount, "skill")}${tail}` : "Update"
  const update = updateCount === null ? "Update" : `Update ${removeCount ? updateCount : plural(updateCount, "skill")}`
  return removeCount ? `${update} · remove ${removeCount}${tail}` : update
}

export function DeletedUpstreamSection({
  scope,
  choices,
  className,
}: {
  scope: ScopeKey
  choices: DeletedChoices
  className?: string
}) {
  const { items, selected, dropped } = choices
  if (items.length === 0 && dropped.length === 0) return null
  const groups = groupBySource(items)
  return (
    <section
      aria-label="Will be removed, deleted upstream"
      className={cn("flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-3", className)}
    >
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} className="size-4 shrink-0 text-destructive" />
          Will be removed — deleted upstream
          <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
            {selected.length} of {items.length}
          </span>
        </h3>
        <p className="text-xs text-muted-foreground">
          These skills are gone from their source, so skills update skips them. For each ticked skill, the folders
          listed under it are deleted, including any local edits. Separate copies (real folders, not links to it)
          stay unless you tick them. Untick a skill to keep it.
        </p>
      </div>
      {groups.map((group) => (
        <div key={group.source} className="flex flex-col gap-1.5">
          <p className="text-xs break-all text-muted-foreground">
            From <span className="font-mono text-foreground">{group.source || "an unknown source"}</span>:{" "}
            {group.items.map((item) => item.name).join(", ")}
          </p>
          <ul className="flex flex-col gap-1.5">
            {group.items.map((item) => (
              <DeletedRow key={item.name} scope={scope} item={item} choices={choices} />
            ))}
          </ul>
        </div>
      ))}
      {dropped.length > 0 && <DroppedList dropped={dropped} />}
    </section>
  )
}

/** Deleted-upstream skills the dialog does not offer, because the server would refuse them. */
function DroppedList({ dropped }: { dropped: DeletedChoices["dropped"] }) {
  const home = useScopes().data?.home
  return (
    <div className="flex flex-col gap-1.5" role="note" aria-label="Not offered for removal">
      <p className="text-xs font-medium">
        Not offered: {plural(dropped.length, "skill")} can't be removed cleanly here
      </p>
      <ul className="flex flex-col gap-1.5">
        {dropped.map(({ item, reason, plan }) => (
          <li key={item.name} className="rounded-xl border border-dashed bg-background/60 px-3 py-2 text-xs">
            <span className="font-medium break-all">{item.name}</span>
            <p className="mt-0.5 break-words text-muted-foreground">{reason}</p>
            {plan && plan.kept.length > 0 && <PathList label="Kept" paths={plan.kept} home={home} />}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** "Deletes" or "Kept" lines under a row: one path per line, with the reason for kept ones. */
export function PathList({
  label,
  paths,
  home,
  destructive,
}: {
  label: string
  paths: { path: string; reason?: string }[]
  home: string | undefined
  destructive?: boolean
}) {
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      <span className={cn("text-[11px] font-medium uppercase tracking-wide", destructive ? "text-destructive" : "text-muted-foreground")}>
        {label}
      </span>
      <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
        {paths.map((p) => (
          <li key={p.path} className="break-all" title={p.path}>
            {tildify(p.path, home)}
            {p.reason && <span className="font-sans"> — {p.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function DeletedRow({ scope, item, choices }: { scope: ScopeKey; item: UpstreamSkillRef; choices: DeletedChoices }) {
  const [open, setOpen] = useState(false)
  const home = useScopes().data?.home
  const skill = skillForCliName(useSkills(scope).data, scope, item.name)
  const detail = useSkill(skill?.id ?? null)
  const files = detail.data?.files
  const checked = choices.isChecked(item.name)
  const running = choices.blockReason(item.name)
  const locked = choices.untickedBlocking(item.name).length > 0
  const blocked = running ?? (locked ? "Tick its copies to remove it" : null)
  const plan = choices.planFor(item.name)
  const fileCount = files ? (files.length >= 500 ? "500+ files" : plural(files.length, "file")) : null

  return (
    <li className={cn("rounded-xl border bg-background transition-colors", !checked && "bg-muted/30")}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-stretch">
          <label
            className={cn("flex shrink-0 items-center pr-1 pl-3 pointer-coarse:pl-3.5", blocked ? "cursor-not-allowed" : "cursor-pointer")}
            title={blocked ?? undefined}
          >
            <Checkbox
              checked={checked}
              disabled={!!blocked}
              onCheckedChange={(value) => choices.setChecked(item.name, value)}
              aria-label={blocked ? `Remove ${item.name}: ${blocked}` : `Remove ${item.name}`}
            />
          </label>
          <CollapsibleTrigger
            disabled={!files?.length}
            className={cn(
              "group/row flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-r-xl py-1.5 pr-3 pl-2 text-left outline-none pressable",
              "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset no-hover:hover:bg-transparent disabled:hover:bg-transparent"
            )}
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open/row:rotate-90 motion-reduce:transition-none",
                !files?.length && "invisible"
              )}
            />
            <span className={cn("min-w-0 truncate text-sm font-medium", !checked && "text-muted-foreground line-through decoration-muted-foreground/50")}>
              {item.name}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              {running ? (
                <>
                  <Spinner className="size-3.5" /> {running}
                </>
              ) : locked ? (
                <span className="text-amber-700 dark:text-amber-300">Tick its copies to remove it</span>
              ) : !skill ? (
                "folder not in the skill list"
              ) : detail.isPending ? (
                <Spinner className="size-3.5" />
              ) : (
                (fileCount ?? "")
              )}
              {!blocked && skill && !checked && <span>· kept</span>}
            </span>
          </CollapsibleTrigger>
        </div>
        {plan && (
          <div className="flex flex-col gap-1 px-3 pb-2 pl-10">
            <div className={cn("flex flex-col gap-1", !checked && "opacity-60")}>
              {plan.willDelete.length > 0 ? (
                <PathList
                  label={checked ? "Deletes" : "Would delete"}
                  paths={plan.willDelete.map((path) => ({ path }))}
                  home={home}
                  destructive={checked}
                />
              ) : (
                <p className="text-xs text-muted-foreground">No folders on disk: only the lock entry is removed.</p>
              )}
            </div>
            {(plan.copies?.length ?? 0) > 0 && (
              <CopyList
                copies={plan.copies ?? []}
                home={home}
                isTicked={choices.isCopyTicked}
                onTick={choices.setCopyTicked}
                // Copies of a skill that is unticked (and not waiting for them) are not sent.
                inactive={!checked && !locked}
                disabled={!!running}
              />
            )}
            {plan.kept.length > 0 && (
              <div className={cn(!checked && "opacity-60")}>
                <PathList label="Kept" paths={plan.kept} home={home} />
              </div>
            )}
          </div>
        )}
        <CollapsibleContent>
          <ul className="max-h-48 overflow-y-auto border-t px-3 py-2 font-mono text-xs text-muted-foreground">
            {files?.map((file) => (
              <li key={file.path} className="truncate py-0.5" title={file.path}>
                {file.path}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/**
 * "Separate copies": same-named real folders in other agents' skills dirs. Each one is opt-in
 * (unticked by default) and says whether it matches the canonical folder.
 */
export function CopyList({
  copies: list,
  home,
  isTicked,
  onTick,
  inactive,
  disabled,
}: {
  copies: RemovalCopy[]
  home: string | undefined
  isTicked: (path: string) => boolean
  onTick: (path: string, ticked: boolean) => void
  /** shown dimmed: ticking them does nothing until the skill itself is ticked */
  inactive?: boolean
  disabled?: boolean
}) {
  return (
    <div className="mt-1 flex flex-col gap-1" role="group" aria-label="Separate copies">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Separate copies</span>
      <ul className={cn("flex flex-col gap-1", inactive && "opacity-60")}>
        {list.map((copy) => {
          // Over the deletion cap: it cannot be fingerprinted byte for byte, so it is never tickable.
          const tooLarge = !!copy.tooLargeToRemove
          const ticked = !tooLarge && isTicked(copy.path)
          const off = disabled || tooLarge
          return (
            <li key={copy.path}>
              <label
                className={cn(
                  "flex min-h-11 items-start gap-2.5 rounded-lg border border-dashed px-2.5 py-2 transition-colors",
                  ticked ? "border-destructive/40 bg-destructive/5" : "bg-background/60",
                  off ? "cursor-not-allowed" : "cursor-pointer hover:bg-muted/40"
                )}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={ticked}
                  disabled={off}
                  onCheckedChange={(value) => onTick(copy.path, value)}
                  aria-label={
                    tooLarge
                      ? `Too large to remove safely here: ${copy.path}`
                      : `Delete the separate copy ${copy.path} (${copy.identical ? "identical" : "differs"})`
                  }
                />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span
                    className={cn("font-mono text-xs break-all", ticked ? "text-destructive" : "text-foreground")}
                    title={copy.path}
                  >
                    {tildify(copy.path, home)}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    <span>{copy.agent}</span>
                    <CopyBadge copy={copy} />
                    <span>{copy.tooLarge ? `${copy.files.toLocaleString("en-US")}+ files` : plural(copy.files, "file")}</span>
                    {copy.blocking && !ticked && (
                      <span className="text-amber-700 dark:text-amber-300">· keeps the skill while it exists</span>
                    )}
                  </span>
                  {tooLarge && (
                    <span className="text-xs text-destructive">
                      Too large to remove safely here — delete it by hand: <span className="break-all">{copy.path}</span>
                    </span>
                  )}
                  <CopyReasons copy={copy} />
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CopyBadge({ copy }: { copy: RemovalCopy }) {
  if (copy.identical)
    return (
      <Badge
        variant="secondary"
        className="h-5 px-1.5 font-normal"
        title="Same files, bytes, links and permissions as the canonical folder, and nothing else"
      >
        identical
      </Badge>
    )
  const detail =
    copy.differences !== undefined ? `${copy.differences} ${copy.differences === 1 ? "entry" : "entries"}` : copy.tooLarge ? "too large to compare" : null
  return (
    <Badge
      variant="outline"
      className="h-5 border-amber-500/40 bg-amber-500/10 px-1.5 font-normal text-amber-800 dark:text-amber-200"
      title={copy.reason}
    >
      differs{detail ? ` · ${detail}` : ""}
    </Badge>
  )
}

/** Why a copy differs, one reason per line (e.g. "has .git history (.git)"). */
function CopyReasons({ copy }: { copy: RemovalCopy }) {
  const reasons = copy.reasons ?? (copy.reason ? [copy.reason] : [])
  if (copy.identical || reasons.length === 0) return null
  return (
    <ul className="flex flex-col gap-0.5 text-xs break-words text-amber-800 dark:text-amber-200" aria-label="Why it differs">
      {reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  )
}

/** Ambiguous skills: the CLI skips them. A warning only; they are never offered for removal. */
export function AmbiguousUpstreamNote({ items, className }: { items: UpstreamSkillRef[]; className?: string }) {
  if (items.length === 0) return null
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
        <span className="font-medium">Skipped: more than one upstream path matches</span>
        <span className="text-xs break-all opacity-85">
          {groupBySource(items)
            .map((group) => `From ${group.source}: ${group.items.map((item) => item.name).join(", ")}`)
            .join(" · ")}
          . skills update leaves {items.length === 1 ? "it" : "them"} alone, and nothing is removed. Fix the source or
          reinstall by hand.
        </span>
      </div>
    </div>
  )
}
