import { HugeiconsIcon } from "@hugeicons/react"
import { Link01Icon } from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/info-tip"

export function LinkedBadge({ target }: { target: string }) {
  return (
    <InfoTip
      render={<Badge variant="outline" tabIndex={0} className="h-5 px-1.5 font-normal" />}
      content={<>→ {target}</>}
      contentClassName="max-w-md font-mono break-all"
    >
      <HugeiconsIcon icon={Link01Icon} strokeWidth={2} data-icon="inline-start" />
      linked
    </InfoTip>
  )
}
