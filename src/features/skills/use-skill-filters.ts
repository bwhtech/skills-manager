import { useState } from "react"
import { ALL, type SkillFilterState } from "./skill-filters"

const AGENT_KEY = "skills-manager:agent-filter"

function readAgent() {
  try {
    return localStorage.getItem(AGENT_KEY) || "claude-code"
  } catch {
    return "claude-code"
  }
}

/** Filter state; the agent choice is remembered in this browser. */
export function useSkillFilters() {
  const [filters, setFilters] = useState<SkillFilterState>(() => ({
    search: "",
    agent: readAgent(),
    origin: ALL,
  }))
  const update = (patch: Partial<SkillFilterState>) => {
    setFilters((current) => ({ ...current, ...patch }))
    if (patch.agent) {
      try {
        localStorage.setItem(AGENT_KEY, patch.agent)
      } catch {
        // storage blocked
      }
    }
  }
  return [filters, update] as const
}
