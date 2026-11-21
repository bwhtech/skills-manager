import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowRight01Icon, Delete02Icon } from "@hugeicons/core-free-icons"
import type { ScopeKey, UpstreamSkillRef } from "@shared/api"
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
  items: UpstreamSkillRef[]
  isChecked: (name: string) => boolean
  setChecked: (name: string, checked: boolean) => void
  /** why a skill cannot be picked (an update or remove of it is running), else null */
  blockReason: (name: string) => string | null
  /** the CLI names to send as UpdateRunRequest.remove */
  selected: string[]
}

/** Ticked by default: the user asked for deleted skills to go automatically. */
export function useDeletedChoices(
  items: UpstreamSkillRef[],
  blockReason: (name: string) => string | null = () => null
): DeletedChoices {
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const isChecked = (name: string) => !blockReason(name) && (choices.get(name) ?? true)
  return {
    items,
    isChecked,
    blockReason,
    setChecked: (name, checked) => setChoices((prev) => new Map(prev).set(name, checked)),
    selected: items.filter((item) => isChecked(item.name)).map((item) => item.name),
  }
}

/** "Update 22 · remove 1", "Update · remove 1", "Remove 2 skills", "Update 3 skills". */
export function confirmLabel(updateCount: number | null, removeCount: number) {
  if (updateCount === 0) return removeCount ? `Remove ${plural(removeCount, "skill")}` : "Update"
  const update = updateCount === null ? "Update" : `Update ${removeCount ? updateCount : plural(updateCount, "skill")}`
  return removeCount ? `${update} · remove ${removeCount}` : update
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
  const { items, selected } = choices
  if (items.length === 0) return null
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
          These skills are gone from their source, so skills update skips them. The local folder of each ticked skill
          is deleted, including any local edits. Untick a skill to keep it.
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
    </section>
  )
}

function DeletedRow({ scope, item, choices }: { scope: ScopeKey; item: UpstreamSkillRef; choices: DeletedChoices }) {
  const [open, setOpen] = useState(false)
  const home = useScopes().data?.home
  const skill = skillForCliName(useSkills(scope).data, scope, item.name)
  const detail = useSkill(skill?.id ?? null)
  const files = detail.data?.files
  const checked = choices.isChecked(item.name)
  const blocked = choices.blockReason(item.name)
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
              {blocked ? (
                <>
                  <Spinner className="size-3.5" /> {blocked}
                </>
              ) : !skill ? (
                "folder not in the skill list"
              ) : detail.isPending ? (
                <Spinner className="size-3.5" />
              ) : (
                (fileCount ?? "")
              )}
              {!blocked && skill && !checked && <span>· kept</span>}
            </span>
            {skill && (
              <span className="basis-full truncate pl-5.5 font-mono text-xs text-muted-foreground" title={skill.realPath}>
                {tildify(skill.realPath, home)}
              </span>
            )}
          </CollapsibleTrigger>
        </div>
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
