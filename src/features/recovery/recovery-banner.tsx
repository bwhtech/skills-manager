import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { InterruptedCopy, RecoveryResult } from "@shared/api"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { api, errorMessage, keys, useRecovery, useScopes } from "@/lib/api"
import { tildify } from "@/lib/format"
import { cn } from "@/lib/utils"
import { copies } from "@/features/updates/deleted-upstream"

type Mode = "restore" | "delete"
type Item = InterruptedCopy & { jobId: string }

/**
 * Top banner for removals that left separate copies in hidden trash dirs (a crash, or a copy
 * that could not be moved back or deleted). Restore and Delete each open a dialog that lists
 * the paths; nothing happens without it. Unknown trash dirs (no journal) are only listed.
 */
export function RecoveryBanner() {
  const recovery = useRecovery()
  const home = useScopes().data?.home
  const [mode, setMode] = useState<Mode | null>(null)
  const data = recovery.data
  if (!data) return null
  const items: Item[] = data.interruptedRemovals.flatMap((r) => r.items.map((item) => ({ ...item, jobId: r.jobId })))
  const leftovers = data.unknownLeftovers
  if (items.length === 0 && leftovers.length === 0) return null
  const partial = items.filter((item) => item.status === "purge_failed")
  const restorable = items.filter((item) => item.restorable)
  const deletable = items.filter((item) => item.deletable)

  return (
    <div
      role="alert"
      className="mx-3 mt-3 flex shrink-0 flex-col gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-950 sm:mx-4 dark:text-amber-100"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">
            {items.length > 0
              ? `A removal was interrupted — ${copies(items.length)} ${items.length === 1 ? "is" : "are"} set aside`
              : `${leftovers.length === 1 ? "A trash folder" : `${leftovers.length} trash folders`} from an earlier removal`}
          </span>
          <span className="text-xs opacity-85">
            {items.length > 0
              ? "They are in hidden trash folders next to where they were. Nothing is deleted until you choose."
              : leftovers.length === 1
                ? "No journal covers it, so the manager does not know what it is. Check it and delete it by hand."
                : "No journal covers them, so the manager does not know what they are. Check them and delete them by hand."}
          </span>
        </div>
        {items.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-7 pointer-coarse:h-10" disabled={!restorable.length} onClick={() => setMode("restore")}>
              Restore
            </Button>
            <Button size="sm" variant="destructive" className="h-7 pointer-coarse:h-10" disabled={!deletable.length} onClick={() => setMode("delete")}>
              Delete them
            </Button>
          </div>
        )}
      </div>
      {partial.length > 0 && (
        <PathNotes
          label="Partially deleted, still in trash — delete by hand"
          paths={partial.map((item) => item.staged)}
          home={home}
        />
      )}
      {leftovers.length > 0 && (
        <PathNotes
          label={items.length > 0 ? "Unknown trash folders (no journal) — check and delete by hand" : "Paths"}
          paths={leftovers.map((l) => l.path)}
          home={home}
        />
      )}
      <RecoveryDialog mode={mode} items={items} home={home} onClose={() => setMode(null)} />
    </div>
  )
}

function PathNotes({ label, paths, home }: { label: string; paths: string[]; home: string | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 pl-6.5">
      <span className="text-[11px] font-medium tracking-wide uppercase opacity-75">{label}</span>
      <ul className="flex flex-col gap-0.5 font-mono text-xs break-all">
        {paths.map((path) => (
          <li key={path} title={path}>
            {tildify(path, home)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Confirm dialog: every set-aside copy, the ones this action can take ticked by default. */
function RecoveryDialog({
  mode,
  items,
  home,
  onClose,
}: {
  mode: Mode | null
  items: Item[]
  home: string | undefined
  onClose: () => void
}) {
  const client = useQueryClient()
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  // Each opening starts with every copy this action can take ticked.
  const [shownMode, setShownMode] = useState(mode)
  if (mode !== shownMode) {
    setShownMode(mode)
    if (mode) setUnticked(new Set())
  }
  const can = (item: Item) => (mode === "delete" ? item.deletable : item.restorable)
  const chosen = items.filter((item) => can(item) && !unticked.has(item.staged))
  const run = useMutation({
    mutationFn: async (picked: Item[]) => {
      const byJob = new Map<string, string[]>()
      for (const item of picked) byJob.set(item.jobId, [...(byJob.get(item.jobId) ?? []), item.staged])
      const call = mode === "delete" ? api.deleteCopies : api.restoreCopies
      let last: RecoveryResult | null = null
      const results: RecoveryResult["results"] = []
      for (const [jobId, staged] of byJob) {
        last = await call({ jobId, staged })
        results.push(...last.results)
      }
      return { results, last }
    },
    onSuccess: ({ results, last }) => {
      if (last) client.setQueryData(keys.recovery, last.recovery)
      void client.invalidateQueries({ queryKey: ["skills"] })
      void client.invalidateQueries({ queryKey: ["skill"] })
      const done = results.filter((r) => r.ok).length
      const failed = results.filter((r) => !r.ok)
      if (done) toast.success(mode === "delete" ? `Deleted ${copies(done)}` : `Restored ${copies(done)}`)
      for (const r of failed) toast.error(`Could not ${mode === "delete" ? "delete" : "restore"} ${r.staged}`, { description: r.message })
      onClose()
    },
    onError: (error) => {
      toast.error(mode === "delete" ? "Could not delete the copies" : "Could not restore the copies", {
        description: errorMessage(error),
      })
      void client.invalidateQueries({ queryKey: keys.recovery })
    },
  })

  return (
    <AlertDialog open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{mode === "delete" ? "Delete the set-aside copies for good?" : "Restore the set-aside copies?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {mode === "delete"
              ? "Each ticked copy is deleted from its trash folder, after a check that it is still exactly what was set aside. This cannot be undone."
              : "Each ticked copy moves back to where it was. A copy is never moved over anything that is there now."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex min-w-0 flex-col gap-1.5 text-left" aria-label="Set-aside copies">
          {items.map((item) => {
            const enabled = can(item)
            const ticked = enabled && !unticked.has(item.staged)
            return (
              <li key={item.staged}>
                <label
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border border-dashed px-2.5 py-2",
                    ticked && mode === "delete" ? "border-destructive/40 bg-destructive/5" : "bg-background/60",
                    enabled ? "cursor-pointer" : "cursor-not-allowed opacity-70"
                  )}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={ticked}
                    disabled={!enabled || run.isPending}
                    aria-label={`${mode === "delete" ? "Delete" : "Restore"} ${item.original}`}
                    onCheckedChange={(value) =>
                      setUnticked((prev) => {
                        const next = new Set(prev)
                        if (value) next.delete(item.staged)
                        else next.add(item.staged)
                        return next
                      })
                    }
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
                    <span className="font-mono break-all text-foreground" title={item.original}>
                      {tildify(item.original, home)}
                    </span>
                    <span className="font-mono break-all text-muted-foreground" title={item.staged}>
                      now at {tildify(item.staged, home)}
                    </span>
                    {!enabled && item.reason && <span className="break-words text-amber-800 dark:text-amber-200">{item.reason}</span>}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={run.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant={mode === "delete" ? "destructive" : "default"}
            disabled={run.isPending || chosen.length === 0}
            onClick={() => run.mutate(chosen)}
          >
            {run.isPending && <Spinner />}
            {mode === "delete" ? `Delete ${copies(chosen.length)}` : `Restore ${copies(chosen.length)}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
