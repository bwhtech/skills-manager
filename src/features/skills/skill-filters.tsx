import { forwardRef, type KeyboardEvent } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon } from "@hugeicons/core-free-icons"
import type { AgentInfo, SkillOrigin } from "@shared/api"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export const ALL = "all"
const ORIGINS: SkillOrigin[] = ["npx", "manual", "plugin", "synced", "system"]

export interface SkillFilterState {
  search: string
  agent: string
  origin: SkillOrigin | typeof ALL
}

interface SkillFiltersProps {
  value: SkillFilterState
  onChange: (patch: Partial<SkillFilterState>) => void
  agents: AgentInfo[]
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

export const SkillFilters = forwardRef<HTMLInputElement, SkillFiltersProps>(function SkillFilters(
  { value, onChange, agents, onSearchKeyDown },
  searchRef
) {
  const agentItems: Record<string, string> = { [ALL]: "All agents" }
  for (const agent of agents) agentItems[agent.id] = agent.label
  if (!(value.agent in agentItems)) agentItems[value.agent] = value.agent
  const originItems: Record<string, string> = { [ALL]: "All origins" }
  for (const origin of ORIGINS) originItems[origin] = origin

  return (
    <div className="flex flex-col gap-2 border-b p-3">
      <InputGroup className="h-8 pointer-coarse:h-11">
        <InputGroupAddon>
          <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchRef}
          value={value.search}
          onChange={(event) => onChange({ search: event.target.value })}
          onKeyDown={onSearchKeyDown}
          placeholder="Search skills"
          aria-label="Search skills by name or description"
          type="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <InputGroupAddon align="inline-end" className="no-hover:hidden">
          <Kbd>/</Kbd>
        </InputGroupAddon>
      </InputGroup>
      <div className="grid grid-cols-[3fr_2fr] gap-2">
        <Select
          items={agentItems}
          value={value.agent}
          onValueChange={(agent) => agent && onChange({ agent })}
        >
          <SelectTrigger size="sm" className="w-full min-w-0 gap-1 px-2.5 text-xs pointer-coarse:data-[size=sm]:h-11 pointer-coarse:text-sm" aria-label="Filter by agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectItem value={ALL}>All agents</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={originItems}
          value={value.origin}
          onValueChange={(origin) => origin && onChange({ origin: origin as SkillFilterState["origin"] })}
        >
          <SelectTrigger size="sm" className="w-full min-w-0 gap-1 px-2.5 text-xs pointer-coarse:data-[size=sm]:h-11 pointer-coarse:text-sm" aria-label="Filter by origin">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectItem value={ALL}>All origins</SelectItem>
            {ORIGINS.map((origin) => (
              <SelectItem key={origin} value={origin}>
                {origin}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
})
