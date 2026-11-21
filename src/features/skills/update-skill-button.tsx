import { lazy, Suspense, useState, type PointerEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { CircleArrowUp02Icon, Delete02Icon } from "@hugeicons/core-free-icons"
import type { SkillSummary } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { updatePreviewQuery, useIsBeingUpdated } from "@/lib/api"
import { cliNameOf } from "@/lib/upstream"

// The dialog (and the diff renderer behind it) loads on first use.
const loadDialog = () => import("@/features/updates/update-skill-dialog")
const UpdateSkillDialog = lazy(() => loadDialog().then((module) => ({ default: module.UpdateSkillDialog })))

/**
 * Opens a confirm dialog with a preview of the update; the dialog runs it. For a skill
 * deleted upstream it reads "Remove (deleted upstream)" and the dialog offers the remove.
 */
export function UpdateSkillButton({ skill }: { skill: SkillSummary }) {
  const [open, setOpen] = useState(false)
  // Stays mounted after the first open so the dialog can animate out.
  const [mounted, setMounted] = useState(false)
  const client = useQueryClient()
  const running = useIsBeingUpdated(skill.scope, cliNameOf(skill))
  const deleted = !!skill.deletedUpstream

  // A mouse on the button: start the upstream fetch (1-2 s) before the click.
  const prefetch = (event: PointerEvent) => {
    void loadDialog()
    if (event.pointerType === "mouse" && !deleted) void client.prefetchQuery(updatePreviewQuery(skill.id))
  }

  return (
    <>
      <Button
        size="sm"
        variant={deleted ? "destructive" : "default"}
        className="h-7 pointer-coarse:h-10"
        disabled={running}
        onPointerEnter={prefetch}
        onClick={() => {
          setMounted(true)
          setOpen(true)
        }}
      >
        {running ? (
          <Spinner />
        ) : (
          <HugeiconsIcon icon={deleted ? Delete02Icon : CircleArrowUp02Icon} strokeWidth={2} />
        )}
        {running ? (deleted ? "Removing…" : "Update running…") : deleted ? "Remove (deleted upstream)" : "Update"}
      </Button>
      {mounted && (
        <Suspense fallback={null}>
          <UpdateSkillDialog skill={skill} open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  )
}
