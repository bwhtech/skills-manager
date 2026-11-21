import { useState } from "react"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage, HttpError, useSkill } from "@/lib/api"
import { navigate } from "@/lib/hash-state"
import { FileTree } from "./file-tree"
import { EditorSkeleton, SKILL_MD, SkillFileEditor } from "./skill-file-editor"
import { SkillHeader } from "./skill-header"
import { SkillInfo } from "./skill-info"

export function SkillDetailPane({ skillId, file }: { skillId: string; file: string | null }) {
  const skill = useSkill(skillId)
  const [dirty, setDirty] = useState(false)

  if (skill.isPending) return <DetailSkeleton />
  if (skill.isError) {
    const gone = skill.error instanceof HttpError && skill.error.status === 404
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle className="text-base">{gone ? "Skill not found" : "Could not load the skill"}</EmptyTitle>
          <EmptyDescription>
            {gone ? "It may have been removed. Pick another skill." : errorMessage(skill.error)}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const data = skill.data
  const known = !file || data.files.some((entry) => entry.path === file && entry.isText)
  const path = file && known ? file : SKILL_MD

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SkillHeader skill={data} />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={230} minSize={170} maxSize="45">
          <div className="h-full overflow-y-auto">
            <FileTree
              files={data.files}
              selectedPath={path}
              dirtyPath={dirty ? SKILL_MD : null}
              onSelect={(next) => navigate({ file: next === SKILL_MD ? null : next })}
            />
            <Separator />
            <SkillInfo skill={data} />
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={320}>
          <SkillFileEditor key={`${data.id}:${path}`} skill={data} path={path} onDirtyChange={setDirty} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading skill">
      <div className="flex flex-col gap-2.5 border-b px-4 py-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[230px] flex-col gap-2 border-r p-3">
          {[70, 55, 60].map((width, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${width}%` }} />
          ))}
        </div>
        <div className="flex-1">
          <EditorSkeleton />
        </div>
      </div>
    </div>
  )
}
