import type { SkillSummary } from "@shared/api"

/** Why a skill cannot be edited, or undefined when it can. */
export function skillReadOnlyReason(skill: SkillSummary): string | undefined {
  if (skill.editable) return undefined
  switch (skill.origin) {
    case "plugin":
      return `Provided by the ${skill.pluginName ?? "Claude Code"} plugin. Plugin updates replace it.`
    case "synced":
      return "Synced from claude.ai. Edit it on claude.ai."
    case "system":
      return "A built-in skill of an agent. The agent manages it."
    default:
      return "This skill is read-only."
  }
}
