import { HugeiconsIcon } from "@hugeicons/react"
import { LockIcon } from "@hugeicons/core-free-icons"
import type { SkillDetail } from "@shared/api"
import { Badge } from "@/components/ui/badge"
import { OriginBadge, UpdateBadge } from "./origin-badge"
import { skillReadOnlyReason } from "./read-only-reason"
import { RemoveSkillButton } from "./remove-skill-button"
import { UpdateSkillButton } from "./update-skill-button"

export function SkillHeader({ skill }: { skill: SkillDetail }) {
  const readOnly = skillReadOnlyReason(skill)
  const removable = skill.origin === "npx" || skill.origin === "manual"
  const updatable = skill.origin === "npx" && skill.updateAvailable

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b px-4 py-3">
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="min-w-0 truncate text-base font-semibold">{skill.name}</h2>
        <OriginBadge origin={skill.origin} />
        {skill.updateAvailable && <UpdateBadge />}
        {readOnly && (
          <Badge variant="secondary" className="h-5 px-1.5 font-normal" title={readOnly}>
            <HugeiconsIcon icon={LockIcon} strokeWidth={2} data-icon="inline-start" />
            read-only
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {updatable && <UpdateSkillButton skill={skill} />}
          {removable && <RemoveSkillButton skill={skill} />}
        </div>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground" title={skill.description}>
        {skill.description || "No description in the frontmatter."}
      </p>
    </div>
  )
}
