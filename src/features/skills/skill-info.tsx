import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { LinkSquare02Icon } from "@hugeicons/core-free-icons"
import type { SkillDetail } from "@shared/api"
import { CopyButton } from "@/components/copy-button"
import { useAgents, useScopes } from "@/lib/api"
import { tildify } from "@/lib/format"

export function sourceUrl(skill: SkillDetail) {
  const source = skill.source
  if (!source) return null
  if (source.sourceUrl?.startsWith("http")) return source.sourceUrl
  if (/^[\w.-]+\/[\w.-]+$/.test(source.source)) return `https://github.com/${source.source}`
  return null
}

/** Where the skill lives, who sees it and where it came from. */
export function SkillInfo({ skill }: { skill: SkillDetail }) {
  const home = useScopes().data?.home
  const agents = useAgents().data?.agents
  const label = (id: string) => agents?.find((agent) => agent.id === id)?.label ?? id
  const url = sourceUrl(skill)
  const others = skill.locations.filter((location) => location !== skill.realPath)

  return (
    <dl className="flex flex-col gap-3 p-3 text-xs">
      <Field label="Path">
        <div className="flex items-start gap-1">
          <span className="min-w-0 flex-1 font-mono break-all" title={skill.realPath}>
            {tildify(skill.realPath, home)}
          </span>
          <CopyButton value={skill.realPath} label="Copy path" />
        </div>
      </Field>
      {others.length > 0 && (
        <Field label={`Also linked at (${others.length})`}>
          <ul className="flex flex-col gap-1">
            {others.map((location) => (
              <li key={location} className="font-mono break-all text-muted-foreground" title={location}>
                {tildify(location, home)}
              </li>
            ))}
          </ul>
        </Field>
      )}
      <Field label={`Agents (${skill.agents.length})`}>
        {skill.agents.length ? (
          <ul className="flex flex-wrap gap-1">
            {skill.agents.map((id) => (
              <li key={id} className="rounded-md bg-muted px-1.5 py-0.5">
                {label(id)}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted-foreground">No agent reads this folder.</span>
        )}
      </Field>
      {skill.source && (
        <Field label="Source">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 break-all underline-offset-2 hover:underline"
            >
              {skill.source.source}
              <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} className="size-3 shrink-0" />
            </a>
          ) : (
            <span className="break-all">{skill.source.source}</span>
          )}
          {skill.source.skillPath && (
            <div className="mt-0.5 font-mono break-all text-muted-foreground">{skill.source.skillPath}</div>
          )}
        </Field>
      )}
      {skill.pluginName && <Field label="Plugin">{skill.pluginName}</Field>}
    </dl>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
