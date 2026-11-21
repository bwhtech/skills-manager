import type { ScopeKey, SkillSummary, UpdateStatus, UpstreamSkillRef } from "@shared/api"

/**
 * The name the skills CLI tracks: what update, remove, preview and the running-job
 * checks use. `name` (the frontmatter name) is for display only.
 */
export function cliNameOf(skill: Pick<SkillSummary, "cliName" | "name">): string {
  return skill.cliName ?? skill.name
}

/**
 * The folder of an npx skill the CLI knows by `cliName` in a scope. When a name has
 * several folders (e.g. ~/.agents/skills and ~/.claude/skills copies), the
 * .agents/skills one, where the CLI installs.
 */
export function skillForCliName(skills: SkillSummary[] | undefined, scope: ScopeKey, cliName: string) {
  const wanted = cliName.toLowerCase()
  const matches = (skills ?? []).filter(
    (skill) => skill.scope === scope && skill.origin === "npx" && cliNameOf(skill).toLowerCase() === wanted
  )
  return matches.find((match) => match.realPath.includes("/.agents/skills/")) ?? matches[0] ?? null
}

/** Deleted-upstream skills of one scope. */
export function deletedInScope(status: UpdateStatus | undefined, scope: ScopeKey): UpstreamSkillRef[] {
  return (status?.deletedUpstream ?? []).filter((item) => item.scope === scope)
}

export function ambiguousInScope(status: UpdateStatus | undefined, scope: ScopeKey): UpstreamSkillRef[] {
  return (status?.ambiguousUpstream ?? []).filter((item) => item.scope === scope)
}

/** The source as the CLI names it in its warnings: owner/repo for user scope, else the sourceUrl. */
export function cliSourceOf(skill: Pick<SkillSummary, "scope" | "source">): string | null {
  if (!skill.source) return null
  return skill.scope === "user" ? skill.source.source : (skill.source.sourceUrl ?? skill.source.source)
}

/** Whether a deleted-upstream entry comes from the same source as the skill. */
export function sameSource(item: UpstreamSkillRef, skill: Pick<SkillSummary, "scope" | "source">): boolean {
  if (item.scope !== skill.scope || !skill.source) return false
  return [cliSourceOf(skill), skill.source.source, skill.source.sourceUrl].includes(item.source)
}

/** Items grouped by source, in first-seen order. */
export function groupBySource<T extends { source: string }>(items: T[]): { source: string; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(item.source, [...(groups.get(item.source) ?? []), item])
  return [...groups].map(([source, list]) => ({ source, items: list }))
}
