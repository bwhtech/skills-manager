import { HugeiconsIcon } from "@hugeicons/react"
import { Link01Icon } from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function LinkedBadge({ target }: { target: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant="outline" tabIndex={0} className="h-5 px-1.5 font-normal" />}
      >
        <HugeiconsIcon icon={Link01Icon} strokeWidth={2} data-icon="inline-start" />
        linked
      </TooltipTrigger>
      <TooltipContent className="max-w-md font-mono break-all">→ {target}</TooltipContent>
    </Tooltip>
  )
}
