import { Suspense, useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { SkillDetail } from "@shared/api"
import { DocumentEditor, type SaveOptions } from "@/components/editor"
import { validateSkillMd } from "@/components/editor/frontmatter"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { api, errorMessage, keys, useSkillFile } from "@/lib/api"
import { basename } from "@/lib/format"
import { skillReadOnlyReason } from "./read-only-reason"

export const SKILL_MD = "SKILL.md"

interface SkillFileEditorProps {
  skill: SkillDetail
  path: string
  onDirtyChange: (dirty: boolean) => void
}

export function SkillFileEditor({ skill, path, onDirtyChange }: SkillFileEditorProps) {
  return (
    <Suspense fallback={<EditorSkeleton />}>
      {path === SKILL_MD ? (
        <SkillMdEditor skill={skill} onDirtyChange={onDirtyChange} />
      ) : (
        <OtherFileViewer skill={skill} path={path} />
      )}
    </Suspense>
  )
}

function SkillMdEditor({ skill, onDirtyChange }: Omit<SkillFileEditorProps, "path">) {
  const client = useQueryClient()
  const folder = basename(skill.realPath)
  const validate = useCallback((text: string) => validateSkillMd(text, folder), [folder])

  const save = async (content: string, { baseHash, force }: SaveOptions) => {
    const result = await api.saveSkillMd(skill.id, { content, baseHash, force })
    void client.invalidateQueries({ queryKey: keys.skill(skill.id) })
    // The skill can be listed in several scopes; refresh every list.
    void client.invalidateQueries({ queryKey: ["skills"] })
    return result
  }

  const reload = async () => {
    const fresh = await client.fetchQuery({
      queryKey: keys.skill(skill.id),
      queryFn: () => api.skill(skill.id),
      staleTime: 0,
    })
    return fresh.skillMd
  }

  return (
    <DocumentEditor
      key={skill.id}
      path={SKILL_MD}
      title={SKILL_MD}
      file={skill.skillMd}
      readOnlyReason={skillReadOnlyReason(skill)}
      warning={skill.origin === "npx" ? "Update overwrites local edits." : undefined}
      validate={validate}
      onSave={skill.editable ? save : undefined}
      onReload={reload}
      onDirtyChange={onDirtyChange}
    />
  )
}

function OtherFileViewer({ skill, path }: { skill: SkillDetail; path: string }) {
  const file = useSkillFile(skill.id, path)
  if (file.isPending) return <EditorSkeleton />
  if (file.isError) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle className="text-base">Could not open {path}</EmptyTitle>
          <EmptyDescription>{errorMessage(file.error)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <DocumentEditor
      key={`${skill.id}:${path}`}
      path={path}
      title={path}
      file={file.data}
      readOnlyReason="Only SKILL.md is editable. Other files in the skill folder are read-only."
      onReload={async () => (await file.refetch()).data}
    />
  )
}

export function EditorSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading file">
      <div className="flex h-11 items-center border-b px-3">
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="flex flex-col gap-2.5 p-4">
        {[60, 85, 40, 75, 90, 55].map((width, i) => (
          <Skeleton key={i} className="h-3.5" style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  )
}
