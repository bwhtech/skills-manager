import { useCallback, useDeferredValue, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { toast } from "sonner"
import type { FileContent, SaveResponse } from "@shared/api"
import { errorMessage, isConflict } from "@/lib/api"
import { isMod, useWindowKeydown } from "@/lib/hotkeys"
import { useIsDesktop } from "@/hooks/use-media-query"
import {
  beginSave,
  editDraft,
  failSave,
  finishSave,
  getDraft,
  isDraftDirty,
  openDraft,
  rebaseDraft,
  retainDraft,
  setDraftConflict,
  subscribeDrafts,
} from "@/lib/drafts"
import type { LinkTarget } from "@/lib/path-links"
import { cn } from "@/lib/utils"
import { openLink } from "@/features/open/open-path"
import { CodeEditor } from "./code-editor"
import { ConflictDialog } from "./conflict-dialog"
import { ValidationBanner, WarningLine } from "./editor-banners"
import { EditorToolbar } from "./editor-toolbar"
import { isMarkdownPath } from "./languages"
import { MarkdownPreview } from "./markdown-preview"
import { useViewMode } from "./view-mode"

export interface SaveOptions {
  /** FileContent.hash of the version the draft started from */
  baseHash: string
  force?: boolean
}

export interface DocumentEditorProps {
  /** names this document across mounts, e.g. "skill:<id>:SKILL.md" */
  draftKey: string
  /** file path; picks the language */
  path: string
  title: string
  /** as loaded; `generation` (lib/drafts.ts) tells a late, pre-save response from the disk now */
  file: FileContent & { generation?: number }
  /** set for read-only files: why they are read-only */
  readOnlyReason?: string
  /** fixed warning line under the toolbar */
  warning?: string
  /** extra badges in the toolbar */
  meta?: ReactNode
  validate?: (text: string) => string[]
  /** writes the file; refetch nothing here, do that in onSaved */
  onSave?: (content: string, options: SaveOptions) => Promise<SaveResponse>
  /** after a save landed in the draft store: refetch what it changed */
  onSaved?: () => void
  /** load the file from disk again */
  onReload: () => Promise<FileContent | undefined>
  onDirtyChange?: (dirty: boolean) => void
  /** this document's docAddress (features/open): paths in it open on Cmd/Ctrl+click */
  openFrom?: string
  /** 1-based line to show when the editor mounts */
  initialLine?: number
  /** false when the surrounding header already shows the title and the dirty dot */
  toolbarTitle?: boolean
}

/**
 * Editor for one file. Mount it with a key per file. The draft, the version
 * it is based on and a running save live in the draft store (lib/drafts.ts),
 * keyed by draftKey, so they survive a remount: crossing the 768px
 * breakpoint swaps the phone screens for the desktop panels, and the new
 * editor can mount before the old one unmounts, or while its save runs.
 */
export default function DocumentEditor(props: DocumentEditorProps) {
  const { draftKey, path, title, file, readOnlyReason, warning, meta, validate } = props
  const [opened] = useState(() => openDraft(draftKey, file))
  const doc = useSyncExternalStore(subscribeDrafts, () => getDraft(draftKey)) ?? opened
  const { content: draft, conflict } = doc
  const saving = !!doc.saving
  const [mode, setMode] = useViewMode()
  const isDesktop = useIsDesktop()
  const dirty = isDraftDirty(doc)
  const markdown = isMarkdownPath(path)
  const viewMode = !markdown ? "edit" : mode === "split" && !isDesktop ? "edit" : mode
  const preview = useDeferredValue(draft)
  const { openFrom } = props
  const root = useRef<HTMLDivElement>(null)
  const onOpenLink = useCallback(
    (link: LinkTarget) => {
      if (openFrom) openLink(link, openFrom)
    },
    [openFrom]
  )

  useEffect(
    () => retainDraft(draftKey, file),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- file only seeds a forgotten clean doc
    [draftKey]
  )
  // A refetch brought a newer version: take it while there is nothing to lose.
  useEffect(() => rebaseDraft(draftKey, file, { keepDraft: true }), [draftKey, file])

  const dirtyCallback = useRef(props.onDirtyChange)
  useEffect(() => {
    dirtyCallback.current = props.onDirtyChange
  })
  useEffect(() => {
    dirtyCallback.current?.(dirty)
  }, [dirty])
  useEffect(() => () => dirtyCallback.current?.(false), [])

  const save = async (force = false) => {
    if (!props.onSave || readOnlyReason) return
    const current = getDraft(draftKey)
    if (!current || current.saving || (!isDraftDirty(current) && !force)) return
    const start = beginSave(draftKey)
    if (!start) return
    try {
      const result = await props.onSave(start.content, { baseHash: start.baseHash, force })
      // Lands in the store, so an editor that replaced this one sees it too.
      // Before any refetch: fetches sent from here on count as the disk after the save.
      finishSave(draftKey, start, result)
      props.onSaved?.()
      toast.success(`Saved ${title}`)
    } catch (error) {
      failSave(draftKey, start, { conflict: isConflict(error) })
      if (!isConflict(error)) toast.error(`Could not save ${title}`, { description: errorMessage(error) })
    }
  }

  const reload = async () => {
    setDraftConflict(draftKey, false)
    try {
      const fresh = await props.onReload()
      if (fresh) rebaseDraft(draftKey, fresh)
    } catch (error) {
      toast.error(`Could not reload ${title}`, { description: errorMessage(error) })
    }
  }

  useWindowKeydown((event) => {
    if (isMod(event) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault()
      if (!hasKeyboard(root.current)) return
      void save()
    }
  })

  const problems = validate ? validate(preview) : []

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col">
      <EditorToolbar
        title={title}
        showTitle={props.toolbarTitle !== false}
        dirty={dirty}
        meta={meta}
        readOnlyReason={readOnlyReason}
        mode={viewMode}
        onModeChange={markdown ? setMode : undefined}
        allowSplit={isDesktop}
        canSave={dirty && !!props.onSave}
        saving={saving}
        onSave={() => void save()}
      />
      {warning && <WarningLine text={warning} />}
      <ValidationBanner problems={problems} />
      <div
        className={cn(
          "grid min-h-0 flex-1",
          viewMode === "split" ? "grid-cols-2 divide-x" : "grid-cols-1"
        )}
      >
        {/* Hidden, not unmounted, in preview: the view keeps its undo history. */}
        <CodeEditor
          value={draft}
          onChange={(text) => editDraft(draftKey, text)}
          readOnly={!!readOnlyReason}
          path={path}
          ariaLabel={`${title} editor`}
          className={viewMode === "preview" ? "hidden" : undefined}
          onOpenLink={openFrom ? onOpenLink : undefined}
          lineKey={openFrom}
          initialLine={props.initialLine}
        />
        {viewMode !== "edit" && (
          <div
            className="min-h-0 overflow-auto overscroll-contain px-6 py-4 max-md:px-4 max-md:pb-[calc(1rem+env(safe-area-inset-bottom))]"
            tabIndex={0}
            aria-label={`${title} preview`}
          >
            <MarkdownPreview text={preview} onOpenLink={openFrom ? onOpenLink : undefined} />
          </div>
        )}
      </div>
      <ConflictDialog
        open={conflict}
        fileName={title}
        onCancel={() => setDraftConflict(draftKey, false)}
        onReload={() => void reload()}
        onOverwrite={() => {
          setDraftConflict(draftKey, false)
          void save(true)
        }}
      />
    </div>
  )
}

/**
 * Whether keyboard shortcuts go to the editor in `root`: not while focus is in a dialog
 * that does not hold it (the file viewer's editor over the page's editor, a confirm dialog).
 */
function hasKeyboard(root: HTMLElement | null): boolean {
  if (!root) return false
  const focused = document.activeElement
  const dialog = focused instanceof HTMLElement ? focused.closest('[role="dialog"], [role="alertdialog"]') : null
  return !dialog || dialog.contains(root)
}
