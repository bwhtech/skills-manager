import type { SkillOrigin } from "@shared/api"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const tone: Record<SkillOrigin, string> = {
  npx: "bg-chart-2",
  manual: "bg-chart-4",
  plugin: "bg-[oklch(0.62_0.15_260)]",
  synced: "bg-[oklch(0.65_0.13_200)]",
  system: "bg-muted-foreground",
}

export const originHint: Record<SkillOrigin, string> = {
  npx: "Installed with the skills CLI",
  manual: "A folder made by hand",
  plugin: "Provided by a Claude Code plugin",
  synced: "Synced from claude.ai",
  system: "Built into an agent",
}

export function OriginBadge({ origin, className }: { origin: SkillOrigin; className?: string }) {
  return (
    <Badge variant="outline" title={originHint[origin]} className={cn("h-5 gap-1.5 px-1.5 font-normal", className)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", tone[origin])} />
      {origin}
    </Badge>
  )
}

export function UpdateBadge() {
  return (
    <Badge className="h-5 px-1.5 font-normal" title="An update is available">
      update
    </Badge>
  )
}
