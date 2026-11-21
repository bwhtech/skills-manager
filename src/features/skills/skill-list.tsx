import { useEffect, useRef, type KeyboardEvent } from "react"
import type { SkillSummary } from "@shared/api"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { SkillRow, skillRowId } from "./skill-row"

interface SkillListProps {
  skills: SkillSummary[] | undefined
  loading: boolean
  error: string | null
  totalCount: number
  selectedId: string | null
  onSelect: (skillId: string) => void
  /** lets the search box move the selection too */
  keyHandlerRef: React.RefObject<((event: KeyboardEvent) => boolean) | null>
}

export function SkillList(props: SkillListProps) {
  const { skills, loading, error, totalCount, selectedId, onSelect, keyHandlerRef } = props
  const listRef = useRef<HTMLDivElement>(null)

  const move = (event: KeyboardEvent) => {
    if (!skills?.length) return false
    const index = skills.findIndex((skill) => skill.id === selectedId)
    const last = skills.length - 1
    const next =
      event.key === "ArrowDown"
        ? Math.min(index + 1, last)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null
    if (next === null) return false
    event.preventDefault()
    if (skills[next].id !== selectedId) onSelect(skills[next].id)
    return true
  }

  useEffect(() => {
    keyHandlerRef.current = move
  })

  useEffect(() => {
    if (!selectedId) return
    document.getElementById(skillRowId(selectedId))?.scrollIntoView({ block: "nearest" })
  }, [selectedId, skills])

  if (loading) {
    return (
      <div className="flex flex-col gap-1 p-2" aria-busy="true" aria-label="Loading skills">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-15 flex-col justify-center gap-2 px-3">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle className="text-base">Could not load skills</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (!skills?.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle className="text-base">
            {totalCount ? "No matching skills" : "No skills here"}
          </EmptyTitle>
          <EmptyDescription>
            {totalCount
              ? `${totalCount} skills are hidden by the filters.`
              : "Install a skill to see it here."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Skills"
      tabIndex={0}
      aria-activedescendant={selectedId ? skillRowId(selectedId) : undefined}
      onKeyDown={move}
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
    >
      {skills.map((skill) => (
        <SkillRow
          key={skill.id}
          skill={skill}
          selected={skill.id === selectedId}
          onSelect={() => {
            listRef.current?.focus({ preventScroll: true })
            onSelect(skill.id)
          }}
        />
      ))}
    </div>
  )
}
