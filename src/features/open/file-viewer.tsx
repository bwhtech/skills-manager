import { Suspense, useRef, useState } from "react"
import { CopyButton } from "@/components/copy-button"
import { LazyCodeEditor } from "@/components/editor"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage, useFile, useScopes } from "@/lib/api"
import { basename, tildify } from "@/lib/format"
import { ui, useUi, type ViewedFile } from "@/lib/ui-store"
import { openLink } from "./open-path"

/** A plain file that a document linked to, read-only. Full screen on phones. */
export function FileViewer() {
  const { viewedFile } = useUi()
  const home = useScopes().data?.home
  // Keep the last file while the sheet animates out.
  const [shown, setShown] = useState<ViewedFile | null>(viewedFile)
  // Focus the content, not the Copy path button (its tooltip would cover the title).
  const body = useRef<HTMLDivElement>(null)
  if (viewedFile && viewedFile !== shown) setShown(viewedFile)

  return (
    <Sheet open={!!viewedFile} onOpenChange={(open) => !open && ui.closeFile()}>
      <SheetContent
        side="right"
        initialFocus={body}
        className="w-full gap-0 data-[side=right]:sm:max-w-3xl max-sm:data-[side=right]:w-full max-sm:data-[side=right]:border-l-0 pr-[env(safe-area-inset-right)] *:data-[slot=sheet-close]:top-[calc(1rem+env(safe-area-inset-top))] *:data-[slot=sheet-close]:right-[calc(1rem+env(safe-area-inset-right))] pointer-coarse:*:data-[slot=sheet-close]:size-11"
      >
        <SheetHeader className="gap-1 pt-[calc(1.5rem+env(safe-area-inset-top))] pr-14 pb-3 max-sm:px-4 max-sm:pr-16">
          <SheetTitle className="truncate">{shown ? basename(shown.path) : "File"}</SheetTitle>
          <div className="flex min-w-0 items-center gap-1">
            <SheetDescription className="min-w-0 truncate font-mono text-xs" title={shown?.path}>
              {shown ? tildify(shown.path, home) : ""}
            </SheetDescription>
            {shown && <CopyButton value={shown.path} label="Copy path" />}
          </div>
          <p className="text-xs text-muted-foreground">Read-only</p>
        </SheetHeader>
        <div ref={body} tabIndex={-1} className="min-h-0 flex-1 border-t pb-[env(safe-area-inset-bottom)] outline-none">
          {shown && <FileBody key={`${shown.path}:${shown.line ?? ""}`} file={shown} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function FileBody({ file }: { file: ViewedFile }) {
  const content = useFile(file.path)
  if (content.isPending) return <BodySkeleton />
  if (content.isError) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle className="text-base">Could not open {basename(file.path)}</EmptyTitle>
          <EmptyDescription>{errorMessage(content.error)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <Suspense fallback={<BodySkeleton />}>
      <LazyCodeEditor
        value={content.data.content}
        readOnly
        path={file.path}
        ariaLabel={`${basename(file.path)} (read-only)`}
        initialLine={file.line}
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
