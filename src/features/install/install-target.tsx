import type { AgentInfo, ProjectInfo, ScopeKey } from "@shared/api"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"

interface InstallTargetProps {
  scope: ScopeKey
  onScopeChange: (scope: ScopeKey) => void
  projects: ProjectInfo[]
  agents: AgentInfo[]
  /** the CLI's last choice; listed right after detected agents */
  lastSelected: string[]
  selectedAgents: string[]
  onAgentsChange: (agents: string[]) => void
}

export function InstallTarget(props: InstallTargetProps) {
  const { scope, onScopeChange, projects, agents, lastSelected, selectedAgents, onAgentsChange } = props
  const items: Record<string, string> = { user: "User (global)" }
  for (const project of projects) items[project.path] = project.name
  const sorted = [...agents].sort(
    (a, b) =>
      Number(b.detected) - Number(a.detected) ||
      Number(lastSelected.includes(b.id)) - Number(lastSelected.includes(a.id)) ||
      a.label.localeCompare(b.label)
  )
  const chosen = new Set(selectedAgents)
  const toggle = (id: string, on: boolean) =>
    onAgentsChange(agents.map((a) => a.id).filter((agentId) => (agentId === id ? on : chosen.has(agentId))))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="grid gap-2">
        <Label>Install to</Label>
        <Select items={items} value={scope} onValueChange={(value) => value && onScopeChange(value)}>
          <SelectTrigger className="w-full" aria-label="Install scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectItem value="user">User (global)</SelectItem>
            {projects.length > 0 && <SelectSeparator />}
            {projects.map((project) => (
              <SelectItem key={project.path} value={project.path}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label id="install-agents-label">Agents</Label>
          <span className="text-xs text-muted-foreground tabular-nums">{chosen.size} selected</span>
        </div>
        <div
          role="group"
          aria-labelledby="install-agents-label"
          className="min-h-0 flex-1 overflow-y-auto rounded-2xl border p-1.5"
        >
          {sorted.map((agent) => (
            <label key={agent.id} className="flex h-8 items-center gap-3 rounded-xl px-2.5 text-sm hover:bg-muted/60">
              <Checkbox checked={chosen.has(agent.id)} onCheckedChange={(on) => toggle(agent.id, on)} />
              <span className="min-w-0 flex-1 truncate">{agent.label}</span>
              {agent.detected && <span className="text-xs text-muted-foreground">detected</span>}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
