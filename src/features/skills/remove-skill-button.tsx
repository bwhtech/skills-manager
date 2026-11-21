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
import { api, errorMessage, useJobMutation, useScopes } from "@/lib/api"
import { scopeLabel } from "@/lib/format"
import { showJob } from "@/features/jobs/job-store"

export function RemoveSkillButton({ skill }: { skill: SkillSummary }) {
  const [open, setOpen] = useState(false)
  const projects = useScopes().data?.projects
  const remove = useJobMutation(api.removeSkill)
  const scope = scopeLabel(skill.scope, projects)
  const where = skill.scope === "user" ? "user scope" : `project ${scope}`

  const confirm = () =>
    remove.mutate(skill.id, {
      onSuccess: ({ jobId }) => {
        setOpen(false)
        showJob(jobId)
      },
      onError: (error) => toast.error(`Could not remove ${skill.name}`, { description: errorMessage(error) }),
    })

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="destructive" size="sm" className="h-7" />}>
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        Remove
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove {skill.name} from {where}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {skill.origin === "npx"
              ? `Runs "skills remove" for ${skill.name}. Every agent in this scope loses the skill.`
              : `Deletes the folder ${skill.realPath}. This cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={confirm}>
            {remove.isPending && <Spinner />}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
