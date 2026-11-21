import type { SkillSummary } from "@shared/api"
import { cn } from "@/lib/utils"
import { ExplicitBadge, OriginBadge, UpstreamBadge } from "./origin-badge"

interface SkillRowProps {
  skill: SkillSummary
  selected: boolean
  onSelect: () => void
}

export function skillRowId(skillId: string) {
  return `skill-row-${skillId}`
}

export function SkillRow({ skill, selected, onSelect }: SkillRowProps) {
  const shared = skill.agents.length
  return (
    <div
      id={skillRowId(skill.id)}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "pressable flex h-15 shrink-0 cursor-default flex-col justify-center gap-1 rounded-xl px-3 select-none hover:bg-muted/60",
        selected && "bg-muted hover:bg-muted"
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{skill.name}</span>
        <UpstreamBadge skill={skill} />
        <ExplicitBadge skill={skill} />
        <OriginBadge origin={skill.origin} />
        {shared > 1 && (
          <span
            className="w-6 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
            title={`Seen by ${shared} agents: ${skill.agents.join(", ")}`}
          >
            ×{shared}
          </span>
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {skill.description || <span className="italic">No description</span>}
      </p>
    </div>
  )
}
