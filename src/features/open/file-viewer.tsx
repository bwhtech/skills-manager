import { Suspense, useRef, useState, useSyncExternalStore } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowExpand01Icon, ArrowShrink01Icon } from "@hugeicons/core-free-icons"
import { CopyButton } from "@/components/copy-button"
import { DirtyDot, DocumentEditor, LazyCodeEditor, type SaveOptions } from "@/components/editor"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api, errorMessage, keys, useFile, useScopes } from "@/lib/api"
import { getDraft, isDraftDirty, subscribeDrafts } from "@/lib/drafts"
import { basename, tildify } from "@/lib/format"
import { useIsDesktop } from "@/hooks/use-media-query"
import { useUi, type ViewedFile } from "@/lib/ui-store"
import { cn } from "@/lib/utils"
import { closeFileViewer, openLink, viewedFileDraftKey } from "./open-path"

/**
 * A plain file that a document linked to. Markdown files open in the document editor
 * (save, conflicts, drafts); other files are read-only. Full screen on phones.
 */
export function FileViewer() {
  const { viewedFile } = useUi()
  const home = useScopes().data?.home
  // Keep the last file while the sheet animates out.
  const [shown, setShown] = useState<ViewedFile | null>(viewedFile)
  // Desktop: a wider sheet, for Split view.
  const [wide, setWide] = useState(false)
  const isDesktop = useIsDesktop()
  // Focus the content, not the Copy path button (its tooltip would cover the title).
  const body = useRef<HTMLDivElement>(null)
  if (viewedFile && viewedFile !== shown) setShown(viewedFile)
  const file = useFile(shown?.path ?? null)
  const editable = file.data?.editable ?? false
  const dirty = useSyncExternalStore(subscribeDrafts, () =>
    shown ? isDraftDirty(getDraft(viewedFileDraftKey(shown.path))) : false
  )

  return (
    // A dismiss (Esc, the backdrop, Close) asks first when the file has unsaved edits.
    <Sheet open={!!viewedFile} onOpenChange={(open) => !open && closeFileViewer()}>
      <SheetContent
        side="right"
        initialFocus={body}
        className={cn(
          "w-full gap-0 max-sm:data-[side=right]:w-full max-sm:data-[side=right]:border-l-0 pr-[env(safe-area-inset-right)] *:data-[slot=sheet-close]:top-[calc(1rem+env(safe-area-inset-top))] *:data-[slot=sheet-close]:right-[calc(1rem+env(safe-area-inset-right))] pointer-coarse:*:data-[slot=sheet-close]:size-11",
          wide && isDesktop ? "data-[side=right]:sm:max-w-[min(90rem,calc(100vw-4rem))]" : "data-[side=right]:sm:max-w-3xl"
        )}
      >
        <SheetHeader className="gap-1 pt-[calc(1.5rem+env(safe-area-inset-top))] pr-14 pb-3 max-sm:px-4 max-sm:pr-16">
          <div className="flex min-w-0 items-center gap-1.5">
            <SheetTitle className="truncate">{shown ? basename(shown.path) : "File"}</SheetTitle>
            <DirtyDot dirty={dirty} />
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <SheetDescription className="min-w-0 truncate font-mono text-xs" title={shown?.path}>
              {shown ? tildify(shown.path, home) : ""}
            </SheetDescription>
            {shown && <CopyButton value={shown.path} label="Copy path" />}
          </div>
          <div className="flex min-h-5 items-center gap-2">
            {file.data && (
              <p className="text-xs text-muted-foreground">{editable ? "Markdown — editable" : "Read-only"}</p>
            )}
            {editable && isDesktop && <WidthToggle wide={wide} onChange={setWide} />}
          </div>
        </SheetHeader>
        <div ref={body} tabIndex={-1} className="min-h-0 flex-1 border-t pb-[env(safe-area-inset-bottom)] outline-none">
          {shown && <FileBody key={shown.path} file={shown} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function WidthToggle({ wide, onChange }: { wide: boolean; onChange: (wide: boolean) => void }) {
  const label = wide ? "Narrower" : "Wider"
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-xs" aria-label={label} aria-pressed={wide} onClick={() => onChange(!wide)} />
        }
      >
        <HugeiconsIcon icon={wide ? ArrowShrink01Icon : ArrowExpand01Icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Mounted once per path. `file.line` counts when the editor is created; later lines come as line requests. */
function FileBody({ file }: { file: ViewedFile }) {
  const client = useQueryClient()
  const content = useFile(file.path)
  const name = basename(file.path)
  if (content.isPending) return <BodySkeleton />
  if (content.isError) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle className="text-base">Could not open {name}</EmptyTitle>
          <EmptyDescription>{errorMessage(content.error)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (content.data.editable) {
    const save = (text: string, { baseHash, force }: SaveOptions) =>
      api.saveFile(file.path, { content: text, baseHash, force })
    return (
      <Suspense fallback={<BodySkeleton />}>
        <DocumentEditor
          draftKey={viewedFileDraftKey(file.path)}
          path={file.path}
          title={name}
          toolbarTitle={false}
          file={content.data}
          onSave={save}
          onSaved={() => void client.invalidateQueries({ queryKey: keys.file(file.path) })}
          onReload={async () => (await content.refetch()).data}
          openFrom={file.path}
          initialLine={file.line}
        />
      </Suspense>
    )
  }
  return (
    <Suspense fallback={<BodySkeleton />}>
      <LazyCodeEditor
        value={content.data.content}
        readOnly
        path={file.path}
        ariaLabel={`${name} (read-only)`}
        initialLine={file.line}
        lineKey={file.path}
        onOpenLink={(link) => openLink(link, file.path)}
      />
    </Suspense>
  )
}

function BodySkeleton() {
  return (
    <div className="flex flex-col gap-2.5 p-4" aria-busy="true" aria-label="Loading file">
      {[60, 85, 40, 75, 90, 55].map((width, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${width}%` }} />
      ))}
    </div>
  )
}
