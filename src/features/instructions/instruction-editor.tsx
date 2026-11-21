import { Suspense } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { InstructionFile } from "@shared/api"
import { DocumentEditor, type SaveOptions } from "@/components/editor"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { api, errorMessage, keys, useInstruction } from "@/lib/api"
import { EditorSkeleton } from "@/features/skills/skill-file-editor"
import { LinkedBadge } from "./linked-badge"

/** The draft store key of an instruction file (lib/drafts.ts). */
export function instructionDraftKey(fileId: string) {
  return `doc:${fileId}`
}

interface InstructionEditorProps {
  file: InstructionFile
  onDirtyChange?: (dirty: boolean) => void
}

export function InstructionEditor({ file, onDirtyChange }: InstructionEditorProps) {
  const client = useQueryClient()
  const content = useInstruction(file.id, file.exists)

  if (content.isPending) return <EditorSkeleton />
  if (content.isError) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle className="text-base">Could not open {file.fileName}</EmptyTitle>
          <EmptyDescription>{errorMessage(content.error)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const save = (text: string, { baseHash, force }: SaveOptions) =>
    api.saveInstruction(file.id, { content: text, baseHash, force })

  return (
    <Suspense fallback={<EditorSkeleton />}>
      <DocumentEditor
        key={file.id}
        draftKey={instructionDraftKey(file.id)}
        path={file.path}
        title={file.fileName}
        file={content.data}
        meta={
          <>
            <span className="hidden truncate text-xs text-muted-foreground lg:inline">{file.agentLabel}</span>
            {file.linkTarget && <LinkedBadge target={file.linkTarget} />}
          </>
        }
        onSave={save}
        onSaved={() => void client.invalidateQueries({ queryKey: keys.instruction(file.id) })}
        onReload={async () => (await content.refetch()).data}
        onDirtyChange={onDirtyChange}
      />
    </Suspense>
  )
}
