import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Delete02Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { SkillSummary } from "@shared/api"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api, errorMessage, useJobMutation, useRemovalPlan, useScopes } from "@/lib/api"
import { scopeLabel } from "@/lib/format"
import { showJob } from "@/features/jobs/job-store"
import { CopyList, copies, PathList } from "@/features/updates/deleted-upstream"

const NOT_REMOVABLE =
  "This folder is in the project's own skills folder, not in an agent install folder " +
  "such as .claude/skills or .agents/skills. It is likely part of the project's source, " +
  "so Remove is off here. Delete it by hand if you mean to."

export function RemoveSkillButton({ skill }: { skill: SkillSummary }) {
  if (!skill.removable) return <DisabledRemoveButton />
  return <RemovableSkillButton skill={skill} />
}

function DisabledRemoveButton() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} aria-label={`Remove is off. ${NOT_REMOVABLE}`} />}>
        <Button variant="destructive" size="sm" className="pointer-events-none h-7 pointer-coarse:h-10" disabled>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          Remove
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{NOT_REMOVABLE}</TooltipContent>
    </Tooltip>
  )
}

function RemovableSkillButton({ skill }: { skill: SkillSummary }) {
  const [open, setOpen] = useState(false)
  const [ticked, setTicked] = useState<ReadonlyMap<string, boolean>>(new Map())
  const projects = useScopes().data?.projects
  const home = useScopes().data?.home
  const remove = useJobMutation(api.removeSkill)
  const npx = skill.origin === "npx"
  const planQuery = useRemovalPlan(skill.id, open && npx)
  const plan = planQuery.data
  const scope = scopeLabel(skill.scope, projects)
  const where = skill.scope === "user" ? "user scope" : `project ${scope}`
  const isTicked = (path: string) => ticked.get(path) ?? false
  const tickedCopies = (plan?.copies ?? []).filter((copy) => isTicked(copy.path)).map((copy) => copy.path)
  const untickedBlocking = (plan?.copies ?? []).filter((copy) => copy.blocking && !isTicked(copy.path))
  const ready = !npx || (!!plan && (!plan.blocked || (plan.blockedUnlessCopies && untickedBlocking.length === 0)))

  const openChange = (next: boolean) => {
    setOpen(next)
    if (next) setTicked(new Map())
  }

  const confirm = () =>
    remove.mutate(
      {
        id: skill.id,
        ...(npx && plan
          ? {
              body: {
                willDelete: plan.willDelete,
                copies: tickedCopies,
                shownCopies: (plan.copies ?? []).map((copy) => ({ path: copy.path, identical: copy.identical })),
              },
            }
          : {}),
      },
      {
        onSuccess: ({ jobId }) => {
          setOpen(false)
          showJob(jobId)
        },
        onError: (error) => {
          toast.error(`Could not remove ${skill.name}`, { description: errorMessage(error) })
          void planQuery.refetch()
        },
      }
    )

  return (
    <AlertDialog open={open} onOpenChange={openChange}>
      <AlertDialogTrigger render={<Button variant="destructive" size="sm" className="h-7 pointer-coarse:h-10" />}>
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        Remove
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove {skill.name} from {where}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {npx
              ? `Runs "skills remove" for ${skill.cliName ?? skill.name}. Every agent in this scope loses the skill.`
              : `Deletes the folder ${skill.realPath} if it lives in a skills folder, and removes links to it there. A folder that is only linked in from elsewhere is kept. This cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {npx && (
          <div className="flex min-w-0 flex-col gap-1 text-left">
            {planQuery.isPending ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> Working out what would be deleted…
              </p>
            ) : planQuery.isError ? (
              <p className="text-xs text-destructive">Could not work out what would be deleted: {errorMessage(planQuery.error)}</p>
            ) : plan ? (
              <>
                {plan.blocked && !plan.blockedUnlessCopies && <p className="text-xs text-destructive">{plan.blocked}</p>}
                {plan.blockedUnlessCopies && untickedBlocking.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    Tick its separate {untickedBlocking.length === 1 ? "copy" : "copies"} to remove it: while{" "}
                    {untickedBlocking.length === 1 ? "it exists" : "they exist"}, skills remove keeps the skill.
                  </p>
                )}
                {plan.willDelete.length > 0 ? (
                  <PathList label="Deletes" paths={plan.willDelete.map((path) => ({ path }))} home={home} destructive />
                ) : (
                  !plan.blocked && <p className="text-xs text-muted-foreground">No folders on disk: only the lock entry is removed.</p>
                )}
                {(plan.copies?.length ?? 0) > 0 && (
                  <CopyList
                    copies={plan.copies ?? []}
                    home={home}
                    isTicked={isTicked}
                    onTick={(path, value) => setTicked((prev) => new Map(prev).set(path, value))}
                  />
                )}
                {plan.kept.length > 0 && <PathList label="Kept" paths={plan.kept} home={home} />}
              </>
            ) : null}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={remove.isPending || !ready} onClick={confirm}>
            {remove.isPending && <Spinner />}
            {tickedCopies.length ? `Remove · ${copies(tickedCopies.length)}` : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
