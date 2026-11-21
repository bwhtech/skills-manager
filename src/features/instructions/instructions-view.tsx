import { useEffect, useState, useSyncExternalStore } from "react"
import type { InstructionFile, ScopeKey } from "@shared/api"
import { ScreenBar, StackScreen } from "@/components/layout/stack-screen"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage, useInstructions } from "@/lib/api"
import { useIsDesktop } from "@/hooks/use-media-query"
import { getDraft, isDraftDirty, subscribeDrafts } from "@/lib/drafts"
import { goUp, navigate } from "@/lib/hash-state"
import { EditorSkeleton } from "@/features/skills/skill-file-editor"
import { CreateInstruction } from "./create-instruction"
import { InstructionEditor, instructionDraftKey } from "./instruction-editor"
import { InstructionList } from "./instruction-list"
import { openInstruction } from "./link-labels"
import { LinkedFile } from "./linked-file"

interface InstructionsViewProps {
  scope: ScopeKey
  docId: string | null
}

export function InstructionsView({ scope, docId }: InstructionsViewProps) {
  const isDesktop = useIsDesktop()
  const files = useInstructions(scope)
  const list = files.data ?? []
  // Desktop shows a default file at doc=null. If it has a draft when the
  // layout switches to phones, open its screen, so the draft stays in view.
  const fallbackId = docId ? null : (pickDefault(list, null)?.id ?? null)
  const fallbackDirty = useSyncExternalStore(subscribeDrafts, () =>
    fallbackId ? isDraftDirty(getDraft(instructionDraftKey(fallbackId))) : false
  )
  useEffect(() => {
    if (!isDesktop && fallbackId && fallbackDirty) navigate({ doc: fallbackId }, { replace: true, force: true })
  }, [isDesktop, fallbackId, fallbackDirty])

  // A link opened by its id (a reload, Back, a typed hash) shows the file it
  // points at instead, in that file's scope: an editor never opens on a link.
  const docFile = docId ? list.find((file) => file.id === docId) : undefined
  const redirect = docFile?.linkTargetFile ? docFile : null
  useEffect(() => {
    if (redirect) openInstruction(redirect, { replace: true })
  }, [redirect])

  const listPane = (
    <InstructionListPane
      files={files}
      list={list}
      selectedId={isDesktop ? (pickDefault(list, docId)?.id ?? null) : docId}
    />
  )

  if (!isDesktop) {
    // Phones: the list, and the file on top of it once one is picked.
    const open = docId ? list.find((file) => file.id === docId) : undefined
    return (
      <div className="relative min-h-0 flex-1">
        <StackScreen root covered={!!docId}>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            {listPane}
          </div>
        </StackScreen>
        {docId && (
          <InstructionScreen key={docId} file={open} loading={files.isPending} />
        )}
      </div>
    )
  }

  // Default to the first file that exists, so the tab opens on something useful.
  const selected = pickDefault(list, docId)

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={320} minSize={240} maxSize="50">
        <div className="h-full overflow-y-auto">{listPane}</div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize={480}>
        {selected ? (
          <InstructionBody key={selected.id} file={selected} />
        ) : (
          !files.isPending && (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle className="text-base">Nothing selected</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

/** The file at docId, else the first real file: links come after the files they point at. */
function pickDefault(list: InstructionFile[], docId: string | null) {
  return (
    list.find((file) => file.id === docId) ??
    list.find((file) => file.exists && !file.linkTarget) ??
    list.find((file) => file.exists) ??
    list[0] ??
    null
  )
}

function InstructionBody({ file, onDirtyChange }: { file: InstructionFile; onDirtyChange?: (dirty: boolean) => void }) {
  if (file.linkTarget) return <LinkedFile file={file} />
  return file.exists ? (
    <InstructionEditor file={file} onDirtyChange={onDirtyChange} />
  ) : (
    <CreateInstruction file={file} />
  )
}

interface InstructionListPaneProps {
  files: ReturnType<typeof useInstructions>
  list: InstructionFile[]
  selectedId: string | null
}

function InstructionListPane({ files, list, selectedId }: InstructionListPaneProps) {
  if (files.isPending) {
    return (
      <div className="flex flex-col gap-1 p-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-15 flex-col justify-center gap-2 px-3">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    )
  }
  if (files.isError) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle className="text-base">Could not load instruction files</EmptyTitle>
          <EmptyDescription>{errorMessage(files.error)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (list.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle className="text-base">No instruction files</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }
  return <InstructionList files={list} selectedId={selectedId} onSelect={(file) => openInstruction(file)} />
}

/** Phone screen for one instruction file. */
function InstructionScreen({ file, loading }: { file: InstructionFile | undefined; loading: boolean }) {
  const [dirty, setDirty] = useState(false)
  return (
    <StackScreen>
      <ScreenBar
        title={file?.fileName ?? "Instruction file"}
        subtitle={file?.agentLabel}
        backLabel="instruction files"
        dirty={file?.exists && !file.linkTarget ? dirty : undefined}
        onBack={() => goUp({ doc: null })}
      />
      <div className="min-h-0 flex-1">
        {file ? (
          <InstructionBody file={file} onDirtyChange={setDirty} />
        ) : loading ? (
          <EditorSkeleton />
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle className="text-base">File not found</EmptyTitle>
              <EmptyDescription>Go back and pick another instruction file.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </StackScreen>
  )
}
