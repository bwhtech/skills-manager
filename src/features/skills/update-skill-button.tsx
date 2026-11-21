import { HugeiconsIcon } from "@hugeicons/react"
import { CircleArrowUp02Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { SkillSummary } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { api, errorMessage, useJobMutation } from "@/lib/api"
import { showJob } from "@/features/jobs/job-store"

export function UpdateSkillButton({ skill }: { skill: SkillSummary }) {
  const update = useJobMutation(api.runUpdate)
  return (
    <Button
      size="sm"
      className="h-7 pointer-coarse:h-10"
      disabled={update.isPending}
      onClick={() =>
        update.mutate(
          { scope: skill.scope, names: [skill.name] },
          {
            onSuccess: ({ jobId }) => showJob(jobId),
            onError: (error) =>
              toast.error(`Could not update ${skill.name}`, { description: errorMessage(error) }),
          }
        )
      }
    >
      {update.isPending ? <Spinner /> : <HugeiconsIcon icon={CircleArrowUp02Icon} strokeWidth={2} />}
      Update
    </Button>
  )
}
