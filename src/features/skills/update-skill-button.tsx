import { lazy, Suspense, useState, type PointerEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { CircleArrowUp02Icon } from "@hugeicons/core-free-icons"
import type { SkillSummary } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { updatePreviewQuery, useIsBeingUpdated } from "@/lib/api"

// The dialog (and the diff renderer behind it) loads on first use.
const loadDialog = () => import("@/features/updates/update-skill-dialog")
const UpdateSkillDialog = lazy(() => loadDialog().then((module) => ({ default: module.UpdateSkillDialog })))

/** Opens a confirm dialog with a preview of the update; the dialog runs it. */
export function UpdateSkillButton({ skill }: { skill: SkillSummary }) {
  const [open, setOpen] = useState(false)
  // Stays mounted after the first open so the dialog can animate out.
  const [mounted, setMounted] = useState(false)
  const client = useQueryClient()
  const running = useIsBeingUpdated(skill.scope, skill.name)

  // A mouse on the button: start the upstream fetch (1-2 s) before the click.
  const prefetch = (event: PointerEvent) => {
    void loadDialog()
    if (event.pointerType === "mouse") void client.prefetchQuery(updatePreviewQuery(skill.id))
  }

  return (
    <>
      <Button
        size="sm"
        className="h-7 pointer-coarse:h-10"
        disabled={running}
        onPointerEnter={prefetch}
        onClick={() => {
          setMounted(true)
          setOpen(true)
        }}
      >
        {running ? <Spinner /> : <HugeiconsIcon icon={CircleArrowUp02Icon} strokeWidth={2} />}
        {running ? "Update running…" : "Update"}
      </Button>
      {mounted && (
        <Suspense fallback={null}>
          <UpdateSkillDialog skill={skill} open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  )
}
