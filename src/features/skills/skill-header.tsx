import { HugeiconsIcon } from "@hugeicons/react"
import { LockIcon } from "@hugeicons/core-free-icons"
import type { SkillDetail } from "@shared/api"
import { Badge } from "@/components/ui/badge"
import { useScopes } from "@/lib/api"
import { scopeLabel } from "@/lib/format"
import { usePlace } from "@/lib/hash-state"
import { OriginBadge, UpdateBadge } from "./origin-badge"
import { skillReadOnlyReason } from "./read-only-reason"
import { RemoveSkillButton } from "./remove-skill-button"
import { UpdateSkillButton } from "./update-skill-button"

export function SkillHeader({ skill }: { skill: SkillDetail }) {
  const viewed = usePlace().scope
  const projects = useScopes().data?.projects
  const alsoIn = skill.scopes.filter((scope) => scope !== viewed).map((scope) => scopeLabel(scope, projects))
  const readOnly = skillReadOnlyReason(skill)
  // Manual skills in a project's own skills/ folder show Remove, disabled.
  const showRemove = skill.origin === "npx" || skill.origin === "manual"
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
        {alsoIn.length > 0 && (
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={`Owned by ${scopeLabel(skill.scope, projects)}. Update and Remove act there.`}
          >
            also in: {alsoIn.join(", ")}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {updatable && <UpdateSkillButton skill={skill} />}
          {showRemove && <RemoveSkillButton skill={skill} />}
        </div>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground" title={skill.description}>
        {skill.description || "No description in the frontmatter."}
      </p>
    </div>
  )
}
