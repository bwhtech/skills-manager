import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { decodeId, type SkillDetail } from "@shared/api"
import { ScreenBar, StackScreen } from "@/components/layout/stack-screen"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage, HttpError, useSkill, useSkills } from "@/lib/api"
import { basename } from "@/lib/format"
import { getDraft, isDraftDirty, subscribeDrafts } from "@/lib/drafts"
import { goUp, navigate, usePlace } from "@/lib/hash-state"
import { FileTree } from "./file-tree"
import { EditorSkeleton, SKILL_MD, SkillFileEditor, skillDraftKey } from "./skill-file-editor"
import { SkillHeader } from "./skill-header"
import { SkillInfo } from "./skill-info"

export function SkillDetailPane({ skillId, file }: { skillId: string; file: string | null }) {
  const skill = useSkill(skillId)
  const dirtyPaths = useDirtyFiles(skillId, skill.data?.files)

  if (skill.isPending) return <DetailSkeleton />
  if (skill.isError) return <SkillError skillId={skillId} error={skill.error} />

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
              dirtyPaths={dirtyPaths}
              onSelect={(next) => navigate({ file: next === SKILL_MD ? null : next })}
            />
            <Separator />
            <SkillInfo skill={data} />
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={320}>
          <SkillFileEditor key={`${data.id}:${path}`} skill={data} path={path} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

/** Files of the skill with unsaved edits in the draft store (also editors not mounted now). */
function useDirtyFiles(skillId: string, files: SkillDetail["files"] | undefined): ReadonlySet<string> {
  const joined = useSyncExternalStore(subscribeDrafts, () =>
    (files ?? [])
      .filter((entry) => isDraftDirty(getDraft(skillDraftKey(skillId, entry.path))))
      .map((entry) => entry.path)
      .join("\n")
  )
  return useMemo(() => new Set(joined ? joined.split("\n") : []), [joined])
}

/** The file to show: the one asked for if it is a known text file, else SKILL.md. */
function filePath(skill: SkillDetail, file: string | null) {
  const known = !file || skill.files.some((entry) => entry.path === file && entry.isText)
  return file && known ? file : SKILL_MD
}

function SkillError({ skillId, error }: { skillId: string; error: Error }) {
  const gone = error instanceof HttpError && error.status === 404
  useFollowMovedSkill(gone ? skillId : null)
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
 * A skill's ID is its real path. An update can move the folder (the CLI may
 * reinstall a copied skill into .agents/skills and leave a link where the
 * folder was), so the open ID stops existing. Find the same skill in this
 * scope (the old path is now one of its locations, or the folder name is
 * unique) and open it in place of the old entry.
 */
function useFollowMovedSkill(goneId: string | null) {
  const { scope } = usePlace()
  const skills = useSkills(scope)
  useEffect(() => {
    if (!goneId || !skills.data) return
    const oldPath = decodeId(goneId)
    const folder = basename(oldPath)
    const byLocation = skills.data.find((s) => s.id !== goneId && s.locations.includes(oldPath))
    const byFolder = skills.data.filter((s) => basename(s.realPath) === folder)
    const next = byLocation ?? (byFolder.length === 1 ? byFolder[0] : undefined)
    if (next) navigate({ skill: next.id }, { replace: true })
  }, [goneId, skills.data])
}

/**
 * Phone layout: the skill screen (header, files, info) and, on top of it
 * when a file is open, the file screen. On phones SKILL.md is named in the
 * URL (file=SKILL.md), because file=null means "no file open" here.
 */
export function SkillScreens({ skillId, file }: { skillId: string; file: string | null }) {
  const skill = useSkill(skillId)
  const [dirty, setDirty] = useState(false)
  const dirtyPaths = useDirtyFiles(skillId, skill.data?.files)
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
          <SkillError skillId={skillId} error={skill.error} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            <SkillHeader skill={skill.data} />
            <FileTree
              files={skill.data.files}
              selectedPath={file ? path : ""}
              dirtyPaths={dirtyPaths}
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
