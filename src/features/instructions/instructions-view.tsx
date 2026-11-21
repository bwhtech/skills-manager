import type { ScopeKey } from "@shared/api"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage, useInstructions } from "@/lib/api"
import { navigate } from "@/lib/hash-state"
import { CreateInstruction } from "./create-instruction"
import { InstructionEditor } from "./instruction-editor"
import { InstructionList } from "./instruction-list"

interface InstructionsViewProps {
  scope: ScopeKey
  docId: string | null
}

export function InstructionsView({ scope, docId }: InstructionsViewProps) {
  const files = useInstructions(scope)
  const list = files.data ?? []
  // Default to the first file that exists, so the tab opens on something useful.
  const selected =
    list.find((file) => file.id === docId) ?? list.find((file) => file.exists) ?? list[0] ?? null

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={320} minSize={240} maxSize="50">
        <div className="h-full overflow-y-auto">
          {files.isPending ? (
            <div className="flex flex-col gap-1 p-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex h-15 flex-col justify-center gap-2 px-3">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              ))}
            </div>
          ) : files.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle className="text-base">Could not load instruction files</EmptyTitle>
                <EmptyDescription>{errorMessage(files.error)}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : list.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle className="text-base">No instruction files</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <InstructionList
              files={list}
              selectedId={selected?.id ?? null}
              onSelect={(id) => navigate({ doc: id })}
            />
          )}
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize={480}>
        {selected ? (
          selected.exists ? (
            <InstructionEditor key={selected.id} file={selected} />
          ) : (
            <CreateInstruction key={selected.id} file={selected} />
          )
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
