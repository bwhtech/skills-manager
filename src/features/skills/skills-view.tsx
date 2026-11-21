import { useMemo, useRef, type KeyboardEvent } from "react"
import type { ScopeKey, SkillSummary } from "@shared/api"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { StackScreen } from "@/components/layout/stack-screen"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useIsDesktop } from "@/hooks/use-media-query"
import { errorMessage, useAgents, useSkills } from "@/lib/api"
import { navigate } from "@/lib/hash-state"
import { isTypingTarget, useWindowKeydown } from "@/lib/hotkeys"
import { plural } from "@/lib/format"
import { SkillDetailPane, SkillScreens } from "./skill-detail"
import { ALL, SkillFilters, type SkillFilterState } from "./skill-filters"
import { SkillList } from "./skill-list"
import { useSkillFilters } from "./use-skill-filters"

function applyFilters(skills: SkillSummary[], filters: SkillFilterState) {
  const words = filters.search.toLowerCase().split(/\s+/).filter(Boolean)
  return skills.filter((skill) => {
    if (filters.agent !== ALL && !skill.agents.includes(filters.agent)) return false
    if (filters.origin !== ALL && skill.origin !== filters.origin) return false
    const text = `${skill.name} ${skill.description}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

interface SkillsViewProps {
  scope: ScopeKey
  skillId: string | null
  file: string | null
}

export function SkillsView({ scope, skillId, file }: SkillsViewProps) {
  const skills = useSkills(scope)
  const agents = useAgents().data?.agents ?? []
  const [filters, setFilters] = useSkillFilters()
  const isDesktop = useIsDesktop()
  const searchRef = useRef<HTMLInputElement>(null)
  const listKeys = useRef<((event: KeyboardEvent) => boolean) | null>(null)

  const visible = useMemo(
    () => (skills.data ? applyFilters(skills.data, filters) : undefined),
    [skills.data, filters]
  )

  useWindowKeydown((event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
    if (isTypingTarget(event.target) || document.querySelector("[role=dialog]")) return
    event.preventDefault()
    searchRef.current?.focus()
    searchRef.current?.select()
  })

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") listKeys.current?.(event)
    if (event.key === "Escape" && filters.search) {
      event.preventDefault()
      setFilters({ search: "" })
    }
  }

  const select = (id: string, options?: { replace?: boolean }) => navigate({ skill: id }, options)
  const count = visible?.length ?? 0
  const total = skills.data?.length ?? 0

  const listColumn = (
    <div className="flex h-full min-h-0 flex-col">
      <SkillFilters
        ref={searchRef}
        value={filters}
        onChange={setFilters}
        agents={agents}
        onSearchKeyDown={onSearchKeyDown}
      />
      <SkillList
        skills={visible}
        loading={skills.isPending}
        error={skills.isError ? errorMessage(skills.error) : null}
        totalCount={total}
        selectedId={skillId}
        onSelect={select}
        keyHandlerRef={listKeys}
      />
      <div className="flex h-8 shrink-0 items-center border-t px-3 text-xs text-muted-foreground tabular-nums max-md:box-content max-md:pb-[env(safe-area-inset-bottom)]">
        {skills.data ? (count === total ? plural(total, "skill") : `${count} of ${total} skills`) : " "}
      </div>
    </div>
  )

  if (!isDesktop) {
    return (
      <div className="relative min-h-0 flex-1">
        <StackScreen root covered={!!skillId}>
          {listColumn}
        </StackScreen>
        {skillId && <SkillScreens key={skillId} skillId={skillId} file={file} />}
      </div>
    )
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={340} minSize={250} maxSize="50">
        {listColumn}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize={480}>
        {skillId ? (
          <SkillDetailPane key={skillId} skillId={skillId} file={file} />
        ) : (
          <NoSelection />
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function NoSelection() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle className="text-base">Select a skill</EmptyTitle>
        <EmptyDescription className="no-hover:hidden">
          Press <Kbd>/</Kbd> to search, then <Kbd>↓</Kbd> <Kbd>↑</Kbd> to move through the list.
        </EmptyDescription>
        <EmptyDescription className="hidden no-hover:block">Tap a skill to open it.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
