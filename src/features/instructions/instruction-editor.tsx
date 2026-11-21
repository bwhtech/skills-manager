import { Suspense } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { InstructionFile } from "@shared/api"
import { DocumentEditor, type SaveOptions } from "@/components/editor"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { HttpError, api, errorMessage, keys, useInstruction, useScopes } from "@/lib/api"
import { tildify } from "@/lib/format"
import { docAddress } from "@/features/open/open-path"
import { EditorSkeleton } from "@/features/skills/skill-file-editor"
import { alsoReadAs } from "./link-labels"

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
  const home = useScopes().data?.home
  // Other files are links to this one: say so, so edits here are not a surprise there.
  const also = alsoReadAs(file, home)

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

  const save = async (text: string, { baseHash, force }: SaveOptions) => {
    try {
      return await api.saveInstruction(file.id, { content: text, baseHash, force })
    } catch (error) {
      throw nowLinkedError(error, file, home) ?? error
    }
  }

  return (
    <Suspense fallback={<EditorSkeleton />}>
      <DocumentEditor
        key={file.id}
        draftKey={instructionDraftKey(file.id)}
        path={file.path}
        title={file.fileName}
        file={content.data}
        warning={also ? `${also}. Edits here apply to all of them.` : undefined}
        meta={<span className="hidden truncate text-xs text-muted-foreground lg:inline">{file.agentLabel}</span>}
        onSave={save}
        onSaved={() => void client.invalidateQueries({ queryKey: keys.instruction(file.id) })}
        onReload={async () => (await content.refetch()).data}
        onDirtyChange={onDirtyChange}
        openFrom={docAddress.instruction(file.id)}
      />
    </Suspense>
  )
}

/**
 * The file became a symlink since it was opened (a sync from another tab):
 * the server refused the save so it cannot land in the linked file. Not a
 * 409 for the editor, so it shows this message and keeps the draft.
 */
function nowLinkedError(error: unknown, file: InstructionFile, home: string | undefined) {
  if (!(error instanceof HttpError) || error.body.error !== "now_linked") return null
  const target = typeof error.body.linkTarget === "string" ? tildify(error.body.linkTarget, home) : "another file"
  return new Error(
    `${file.fileName} is now synced to ${target}, so this save was refused. Copy your changes, then reload the list and edit ${target}.`
  )
}
