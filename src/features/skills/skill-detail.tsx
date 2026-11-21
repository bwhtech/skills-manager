import { useEffect, useState, useSyncExternalStore } from "react"
import type { SkillDetail } from "@shared/api"
import { ScreenBar, StackScreen } from "@/components/layout/stack-screen"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage, HttpError, useSkill } from "@/lib/api"
import { basename } from "@/lib/format"
import { getDraft, isDraftDirty, subscribeDrafts } from "@/lib/drafts"
import { goUp, navigate } from "@/lib/hash-state"
import { FileTree } from "./file-tree"
import { EditorSkeleton, SKILL_MD, SkillFileEditor, skillDraftKey } from "./skill-file-editor"
import { SkillHeader } from "./skill-header"
import { SkillInfo } from "./skill-info"

export function SkillDetailPane({ skillId, file }: { skillId: string; file: string | null }) {
  const skill = useSkill(skillId)
  const [dirty, setDirty] = useState(false)

  if (skill.isPending) return <DetailSkeleton />
  if (skill.isError) return <SkillError error={skill.error} />

  const data = skill.data
  const path = filePath(data, file)

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

/** The file to show: the one asked for if it is a known text file, else SKILL.md. */
function filePath(skill: SkillDetail, file: string | null) {
  const known = !file || skill.files.some((entry) => entry.path === file && entry.isText)
  return file && known ? file : SKILL_MD
}

function SkillError({ error }: { error: Error }) {
  const gone = error instanceof HttpError && error.status === 404
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle className="text-base">{gone ? "Skill not found" : "Could not load the skill"}</EmptyTitle>
        <EmptyDescription>
          {gone ? "It may have been removed. Pick another skill." : errorMessage(error)}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/**
 * Phone layout: the skill screen (header, files, info) and, on top of it
 * when a file is open, the file screen. On phones SKILL.md is named in the
 * URL (file=SKILL.md), because file=null means "no file open" here.
 */
export function SkillScreens({ skillId, file }: { skillId: string; file: string | null }) {
  const skill = useSkill(skillId)
  const [dirty, setDirty] = useState(false)
  // Desktop shows SKILL.md at file=null. If it has a draft when the layout
  // switches to this one, open its screen, so the draft stays in view.
  const skillMdDirty = useSyncExternalStore(subscribeDrafts, () =>
    isDraftDirty(getDraft(skillDraftKey(skillId, SKILL_MD)))
  )
  useEffect(() => {
    if (!file && skillMdDirty) navigate({ file: SKILL_MD }, { replace: true, force: true })
  }, [file, skillMdDirty])
  const data = skill.data
  const path = data ? filePath(data, file) : (file ?? SKILL_MD)

  return (
    <>
      <StackScreen covered={!!file}>
        <ScreenBar
          title={data?.name ?? "Skill"}
          backLabel="skills"
          onBack={() => goUp({ skill: null })}
        />
        {skill.isPending ? (
          <ScreenSkeleton />
        ) : skill.isError ? (
          <SkillError error={skill.error} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            <SkillHeader skill={skill.data} />
            <FileTree
              files={skill.data.files}
              selectedPath={file ? path : ""}
              dirtyPath={dirty ? SKILL_MD : null}
              onSelect={(next) => navigate({ file: next })}
            />
            <Separator />
            <SkillInfo skill={skill.data} />
          </div>
        )}
      </StackScreen>
      {file && (
        <StackScreen>
          <ScreenBar
            title={basename(path)}
            subtitle={path.includes("/") ? `${data?.name ?? ""} · ${path.slice(0, path.lastIndexOf("/"))}/` : data?.name}
            backLabel={data?.name ?? "skill"}
            dirty={dirty}
            onBack={() => goUp({ file: null })}
          />
          <div className="min-h-0 flex-1">
            {data ? (
              <SkillFileEditor key={`${data.id}:${path}`} skill={data} path={path} onDirtyChange={setDirty} />
            ) : (
              <EditorSkeleton />
            )}
          </div>
        </StackScreen>
      )}
    </>
  )
}

function ScreenSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading skill">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      {[70, 55, 60].map((width, i) => (
        <Skeleton key={i} className="h-8" style={{ width: `${width}%` }} />
      ))}
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
