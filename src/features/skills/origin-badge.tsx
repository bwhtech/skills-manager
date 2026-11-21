import type { SkillOrigin, SkillSummary } from "@shared/api"
import { Badge } from "@/components/ui/badge"
import { useIsBeingUpdated } from "@/lib/api"
import { cliNameOf } from "@/lib/upstream"
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

/** "update", or "Updating…" while an update job for the skill is queued or running. */
export function UpdateBadge({ skill }: { skill: Pick<SkillSummary, "scope" | "name" | "cliName"> }) {
  const running = useIsBeingUpdated(skill.scope, cliNameOf(skill))
  return (
    <Badge className="h-5 px-1.5 font-normal" title={running ? "An update is running" : "An update is available"}>
      {running ? "Updating…" : "update"}
    </Badge>
  )
}

/** In place of "update": the skill is gone from its source; Update offers to remove it. */
export function DeletedUpstreamBadge({ skill }: { skill: Pick<SkillSummary, "scope" | "name" | "cliName"> }) {
  const running = useIsBeingUpdated(skill.scope, cliNameOf(skill))
  return (
    <Badge
      variant="destructive"
      className="h-5 px-1.5 font-normal"
      title={running ? "A remove is running" : "Deleted upstream: skills update skips it. Open it to remove the local copy."}
    >
      {running ? "Removing…" : "deleted upstream"}
    </Badge>
  )
}

/** The update-state badge of a skill: "deleted upstream" wins over "update". */
export function UpstreamBadge({ skill }: { skill: SkillSummary }) {
  if (skill.deletedUpstream) return <DeletedUpstreamBadge skill={skill} />
  if (skill.updateAvailable) return <UpdateBadge skill={skill} />
  return null
}
