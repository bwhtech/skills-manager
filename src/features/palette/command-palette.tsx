import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Download04Icon, Search01Icon } from "@hugeicons/core-free-icons"
import type { ProjectInfo, ScopeKey, SkillSummary } from "@shared/api"
import { Badge } from "@/components/ui/badge"
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { Spinner } from "@/components/ui/spinner"
import { ExplicitBadge, OriginBadge } from "@/features/skills/origin-badge"
import { errorMessage, useAllSkills, useScopes } from "@/lib/api"
import { scopeLabel } from "@/lib/format"
import { navigate, usePlace } from "@/lib/hash-state"
import { ui, useUi } from "@/lib/ui-store"

/** Cmd/Ctrl+K: jump to any installed skill, in any scope, or start an install. */
export function CommandPalette() {
  const { paletteOpen } = useUi()
  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={ui.setPaletteOpen}
      title="Search skills"
      description="Jump to an installed skill, or install new ones."
      // Phones: near the top, so the list stays above the soft keyboard.
      className="sm:max-w-xl max-md:top-[calc(env(safe-area-inset-top)+0.75rem)]"
    >
      {/* Mounted only while open, so each open starts with an empty query. */}
      <PaletteBody />
    </CommandDialog>
  )
}

interface Entry {
  skill: SkillSummary
  /** where the jump lands: the shown scope when the skill appears there, else its owner */
  scope: ScopeKey
  scopeName: string
  rank: number
}

function PaletteBody() {
  const place = usePlace()
  const [query, setQuery] = useState("")
  const skills = useAllSkills(true)
  const projects = useScopes().data?.projects
  const text = query.trim()
  const { here, elsewhere } = useMemo(
    () => matchSkills(skills.data ?? [], text, place.scope, projects),
    [skills.data, text, place.scope, projects]
  )
  const hereName = scopeLabel(place.scope, projects)
  const listRef = useRef<HTMLDivElement>(null)

  // A new query selects the top match; show it, not the old scroll position.
  useLayoutEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [text])

  const jump = (entry: Entry) => {
    ui.setPaletteOpen(false)
    navigate({ scope: entry.scope, tab: "skills", skill: entry.skill.id, file: null })
  }

  // Rows in the shown scope skip the scope name; the origin tells same-named skills apart.
  const item = (entry: Entry) => (
    <CommandItem key={entry.skill.id} value={entry.skill.id} onSelect={() => jump(entry)} className="items-start">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{entry.skill.name}</span>
          <OriginBadge origin={entry.skill.origin} className="shrink-0" />
          <ExplicitBadge skill={entry.skill} className="shrink-0" />
          {entry.skill.updateAvailable && <Badge className="h-5 shrink-0 px-1.5 font-normal">update</Badge>}
        </span>
        {entry.skill.description && (
          <span className="line-clamp-1 text-xs font-normal text-muted-foreground">{entry.skill.description}</span>
        )}
      </span>
      {entry.scope !== place.scope && (
        <CommandShortcut className="mt-0.5 max-w-36 truncate tracking-normal">{entry.scopeName}</CommandShortcut>
      )}
    </CommandItem>
  )

  return (
    // We filter and rank ourselves (word match, name hits first), so cmdk keeps our order.
    <Command shouldFilter={false} loop>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search your skills, or install new ones…"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <CommandList
        ref={listRef}
        className="max-h-[min(26rem,60vh)] max-md:max-h-[calc(var(--app-height,100dvh)-9rem)]">
        {skills.isPending && (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
            <Spinner /> Loading skills…
          </div>
        )}
        {skills.isError && (
          <p className="px-4 py-3 text-xs text-destructive">Could not load skills: {errorMessage(skills.error)}</p>
        )}
        {skills.isSuccess && text && here.length + elsewhere.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">No installed skills match “{text}”.</p>
        )}
        {here.length > 0 && <CommandGroup heading={`In ${hereName}`}>{here.map(item)}</CommandGroup>}
        {elsewhere.length > 0 && (
          <CommandGroup heading={here.length ? "Other scopes" : "In other scopes"}>{elsewhere.map(item)}</CommandGroup>
        )}
        {(here.length > 0 || elsewhere.length > 0) && <CommandSeparator />}
        <CommandGroup heading="Install">
          {text && (
            <CommandItem value="install:search" onSelect={() => ui.setInstallOpen(true, text)}>
              <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
              <span className="truncate">Search skills.sh for “{text}”</span>
            </CommandItem>
          )}
          <CommandItem value="install:open" onSelect={() => ui.setInstallOpen(true)}>
            <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
            Install skills…
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

/**
 * Every word must appear in the name, description, scope, origin or source. Name hits
 * rank first: exact, then prefix, then contains. Skills seen in the shown scope
 * come before the rest.
 */
function matchSkills(skills: SkillSummary[], text: string, shown: ScopeKey, projects: ProjectInfo[] | undefined) {
  const query = text.toLowerCase()
  const words = query.split(/\s+/).filter(Boolean)
  const here: Entry[] = []
  const elsewhere: Entry[] = []
  for (const skill of skills) {
    const scope = skill.scopes.includes(shown) ? shown : skill.scope
    const scopeName = scopeLabel(scope, projects)
    const name = skill.name.toLowerCase()
    const haystack = `${name} ${skill.description} ${scopeName} ${skill.origin} ${skill.source?.source ?? ""}`.toLowerCase()
    if (!words.every((word) => haystack.includes(word))) continue
    const rank = !query
      ? 0
      : name === query
        ? 0
        : name.startsWith(query)
          ? 1
          : words.every((word) => name.includes(word))
            ? 2
            : 3
    ;(scope === shown ? here : elsewhere).push({ skill, scope, scopeName, rank })
  }
  // The server sorts by name; a stable sort keeps that order within a rank.
  const byRank = (a: Entry, b: Entry) => a.rank - b.rank
  return { here: here.sort(byRank), elsewhere: elsewhere.sort(byRank) }
}
