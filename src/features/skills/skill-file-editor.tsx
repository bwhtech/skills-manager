import { Suspense, useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { SkillDetail } from "@shared/api"
import { DocumentEditor, type SaveOptions } from "@/components/editor"
import { validateSkillMd } from "@/components/editor/frontmatter"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { api, errorMessage, keys, resetUpdatePreviews, useSkillFile } from "@/lib/api"
import { basename } from "@/lib/format"
import { docAddress } from "@/features/open/open-path"
import { OVERWRITE_WARNING } from "@/features/updates/copy"
import { skillReadOnlyReason } from "./read-only-reason"

export const SKILL_MD = "SKILL.md"
const MARKDOWN = /\.md$/i

/** The draft store key of a file in a skill (lib/drafts.ts). */
export function skillDraftKey(skillId: string, path: string) {
  return `skill:${skillId}:${path}`
}

interface SkillFileEditorProps {
  skill: SkillDetail
  path: string
  onDirtyChange?: (dirty: boolean) => void
}

export function SkillFileEditor({ skill, path, onDirtyChange }: SkillFileEditorProps) {
  return (
    <Suspense fallback={<EditorSkeleton />}>
      {path === SKILL_MD ? (
        <SkillMdEditor skill={skill} onDirtyChange={onDirtyChange} />
      ) : (
        <OtherFileEditor skill={skill} path={path} onDirtyChange={onDirtyChange} />
      )}
    </Suspense>
  )
}

function SkillMdEditor({ skill, onDirtyChange }: Omit<SkillFileEditorProps, "path">) {
  const client = useQueryClient()
  const folder = basename(skill.realPath)
  const validate = useCallback((text: string) => validateSkillMd(text, folder), [folder])

  const save = (content: string, { baseHash, force }: SaveOptions) =>
    api.saveSkillMd(skill.id, { content, baseHash, force })

  const saved = () => {
    void client.invalidateQueries({ queryKey: keys.skill(skill.id) })
    // The skill can be listed in several scopes; refresh every list.
    void client.invalidateQueries({ queryKey: ["skills"] })
    // The update preview diffs against the folder on disk.
    resetUpdatePreviews(client, [skill.id])
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
      draftKey={skillDraftKey(skill.id, SKILL_MD)}
      path={SKILL_MD}
      title={SKILL_MD}
      file={skill.skillMd}
      readOnlyReason={skillReadOnlyReason(skill)}
      warning={skill.origin === "npx" ? OVERWRITE_WARNING : undefined}
      validate={validate}
      onSave={skill.editable ? save : undefined}
      onSaved={saved}
      onReload={reload}
      onDirtyChange={onDirtyChange}
      openFrom={docAddress.skillFile(skill.id, SKILL_MD)}
    />
  )
}

/**
 * Any other file of the skill folder. Markdown files of editable skills save through
 * PUT /api/skills/:id/file (the server decides: SkillFileContent.editable); the rest is
 * read-only. No frontmatter check: that is for SKILL.md only.
 */
function OtherFileEditor({ skill, path, onDirtyChange }: SkillFileEditorProps) {
  const client = useQueryClient()
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
  const editable = skill.editable && file.data.editable

  const save = (content: string, { baseHash, force }: SaveOptions) =>
    api.saveSkillFile(skill.id, path, { content, baseHash, force })

  const saved = () => {
    void client.invalidateQueries({ queryKey: keys.skillFile(skill.id, path) })
    // The file tree shows sizes.
    void client.invalidateQueries({ queryKey: keys.skill(skill.id) })
    // The update preview diffs against the folder on disk.
    resetUpdatePreviews(client, [skill.id])
  }

  return (
    <DocumentEditor
      key={`${skill.id}:${path}`}
      draftKey={skillDraftKey(skill.id, path)}
      path={path}
      title={path}
      file={file.data}
      readOnlyReason={editable ? undefined : otherFileReadOnlyReason(skill, path)}
      warning={editable && skill.origin === "npx" ? OVERWRITE_WARNING : undefined}
      onSave={editable ? save : undefined}
      onSaved={saved}
      onReload={async () => (await file.refetch()).data}
      onDirtyChange={onDirtyChange}
      openFrom={docAddress.skillFile(skill.id, path)}
    />
  )
}

function otherFileReadOnlyReason(skill: SkillDetail, path: string): string {
  const skillReason = skillReadOnlyReason(skill)
  if (skillReason) return skillReason
  if (!MARKDOWN.test(path)) return "Only Markdown files are editable. Other files in the skill folder are read-only."
  return "This file cannot be edited: it links outside the skill folder, or it is not writable."
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
