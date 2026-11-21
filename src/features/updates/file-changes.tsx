import { lazy, Suspense, useState, useSyncExternalStore } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon } from "@hugeicons/core-free-icons"
import type { UpdateFileChange } from "@shared/api"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useMediaQuery } from "@/hooks/use-media-query"
import { formatBytes } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { DiffLayout } from "./diff-view"
import { FileStatusIcon, LineCounts } from "./preview-parts"

const loadDiffView = () => import("./diff-view")
const DiffView = lazy(loadDiffView)

/** Start loading the diff renderer early, e.g. when the pointer nears "Show changes". */
export function preloadDiffView() {
  void loadDiffView()
}

// ---------- Unified / split preference ----------

const LAYOUT_KEY = "skills-manager:diff-layout"
const layoutListeners = new Set<() => void>()
let layoutPref: DiffLayout = readLayout()

function readLayout(): DiffLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified"
  } catch {
    return "unified"
  }
}

function setLayoutPref(layout: DiffLayout) {
  layoutPref = layout
  try {
    localStorage.setItem(LAYOUT_KEY, layout)
  } catch {
    // private mode: keep it for this page only
  }
  for (const listener of layoutListeners) listener()
}

/** Split needs room: wide screens may pick it, everything else is unified. */
export function useDiffLayout() {
  const wide = useMediaQuery("(min-width: 1024px)")
  const pref = useSyncExternalStore(
    (listener) => {
      layoutListeners.add(listener)
      return () => layoutListeners.delete(listener)
    },
    () => layoutPref
  )
  return { canSplit: wide, layout: wide ? pref : "unified", setLayout: setLayoutPref } as const
}

export function DiffLayoutToggle() {
  const { canSplit, layout, setLayout } = useDiffLayout()
  if (!canSplit) return null
  return (
    <ToggleGroup
      size="sm"
      variant="outline"
      spacing={0}
      value={[layout]}
      onValueChange={(value: string[]) => value[0] && setLayout(value[0] as DiffLayout)}
      aria-label="Diff layout"
    >
      <ToggleGroupItem value="unified" className="h-7 px-2.5 text-xs">Unified</ToggleGroupItem>
      <ToggleGroupItem value="split" className="h-7 px-2.5 text-xs">Split</ToggleGroupItem>
    </ToggleGroup>
  )
}

// ---------- File list ----------

const SKILL_MD = "SKILL.md"

/** Every changed file as its own collapsible row; SKILL.md starts open. */
export function FileChangeList({ files, className }: { files: UpdateFileChange[]; className?: string }) {
  return (
    <ul className={cn("overflow-hidden rounded-2xl border", className)}>
      {files.map((file) => (
        <FileChangeRow key={file.path} file={file} defaultOpen={file.path === SKILL_MD} />
      ))}
    </ul>
  )
}

function FileChangeRow({ file, defaultOpen }: { file: UpdateFileChange; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <li className="border-b last:border-b-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={cn(
            "group/file flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left outline-none pressable",
            "hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
            "pointer-coarse:min-h-11 no-hover:hover:bg-transparent",
            "data-panel-open:border-b"
          )}
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open/file:rotate-90 motion-reduce:transition-none"
          />
          <FileStatusIcon status={file.status} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
            {file.path}
          </span>
          {file.binary ? (
            <span className="shrink-0 text-xs text-muted-foreground">binary</span>
          ) : (
            <LineCounts added={file.linesAdded} removed={file.linesRemoved} />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <FileChangeBody file={file} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function FileChangeBody({ file }: { file: UpdateFileChange }) {
  const { layout } = useDiffLayout()
  const note = fileNote(file)
  if (note) return <p className="px-3 py-3 text-xs text-muted-foreground">{note}</p>
  return (
    <Suspense fallback={<DiffSkeleton />}>
      <DiffView change={file} layout={layout} />
    </Suspense>
  )
}

/** Why a file has no diff to show, or null when it has one. */
function fileNote(file: UpdateFileChange) {
  const verb = file.status === "added" ? "added" : file.status === "removed" ? "removed" : "changed"
  if (file.binary) return `Binary file ${verb}. No text diff to show.`
  if (file.tooLarge) return `File ${verb}. It is over ${formatBytes(256 * 1024)}, so the diff is not shown.`
  return null
}

function DiffSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 p-3" aria-label="Loading diff">
      <Skeleton className="h-3.5 w-3/5 rounded-md" />
      <Skeleton className="h-3.5 w-4/5 rounded-md" />
      <Skeleton className="h-3.5 w-2/5 rounded-md" />
    </div>
  )
}
