import { useDeferredValue, useEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { FileContent, SaveResponse } from "@shared/api"
import { errorMessage, isConflict } from "@/lib/api"
import { isMod, useWindowKeydown } from "@/lib/hotkeys"
import { setDirty } from "@/lib/unsaved"
import { cn } from "@/lib/utils"
import { CodeEditor } from "./code-editor"
import { ConflictDialog } from "./conflict-dialog"
import { ValidationBanner, WarningLine } from "./editor-banners"
import { EditorToolbar } from "./editor-toolbar"
import { isMarkdownPath } from "./languages"
import { MarkdownPreview } from "./markdown-preview"
import { useViewMode } from "./view-mode"

export interface SaveOptions {
  baseMtimeMs: number
  force?: boolean
}

export interface DocumentEditorProps {
  /** file path; picks the language */
  path: string
  title: string
  file: FileContent
  /** set for read-only files: why they are read-only */
  readOnlyReason?: string
  /** fixed warning line under the toolbar */
  warning?: string
  /** extra badges in the toolbar */
  meta?: ReactNode
  validate?: (text: string) => string[]
  onSave?: (content: string, options: SaveOptions) => Promise<SaveResponse>
  /** load the file from disk again */
  onReload: () => Promise<FileContent | undefined>
  onDirtyChange?: (dirty: boolean) => void
}

/**
 * Editor for one file. Mount it with a key per file: it keeps the draft and
 * the version it was loaded from.
 */
export default function DocumentEditor(props: DocumentEditorProps) {
  const { path, title, file, readOnlyReason, warning, meta, validate } = props
  const [base, setBase] = useState(file)
  const [draft, setDraft] = useState(file.content)
  const [seen, setSeen] = useState(file)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [mode, setMode] = useViewMode()
  const dirty = draft !== base.content
  const markdown = isMarkdownPath(path)
  const viewMode = markdown ? mode : "edit"
  const preview = useDeferredValue(draft)

  // A refetch brought a newer version: take it while there is nothing to lose.
  if (seen !== file) {
    setSeen(file)
    if (!dirty && file.mtimeMs !== base.mtimeMs) {
      setBase(file)
      setDraft(file.content)
    }
  }

  const dirtyCallback = useRef(props.onDirtyChange)
  useEffect(() => {
    dirtyCallback.current = props.onDirtyChange
  })
  useEffect(() => {
    setDirty(dirty)
    dirtyCallback.current?.(dirty)
  }, [dirty])
  useEffect(
    () => () => {
      setDirty(false)
      dirtyCallback.current?.(false)
    },
    []
  )

  const save = async (force = false) => {
    if (!props.onSave || readOnlyReason || saving) return
    if (!dirty && !force) return
    const content = draft
    setSaving(true)
    try {
      const result = await props.onSave(content, { baseMtimeMs: base.mtimeMs, force })
      setBase({ content, mtimeMs: result.mtimeMs })
      toast.success(`Saved ${title}`)
    } catch (error) {
      if (isConflict(error)) setConflict(true)
      else toast.error(`Could not save ${title}`, { description: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  const reload = async () => {
    setConflict(false)
    try {
      const fresh = await props.onReload()
      if (!fresh) return
      setBase(fresh)
      setDraft(fresh.content)
    } catch (error) {
      toast.error(`Could not reload ${title}`, { description: errorMessage(error) })
    }
  }

  useWindowKeydown((event) => {
    if (isMod(event) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault()
      void save()
    }
  })

  const problems = validate ? validate(preview) : []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorToolbar
        title={title}
        dirty={dirty}
        meta={meta}
        readOnlyReason={readOnlyReason}
        mode={viewMode}
        onModeChange={markdown ? setMode : undefined}
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
        {viewMode !== "preview" && (
          <CodeEditor
            value={draft}
            onChange={setDraft}
            readOnly={!!readOnlyReason}
            path={path}
            ariaLabel={`${title} editor`}
          />
        )}
        {viewMode !== "edit" && (
          <div className="min-h-0 overflow-auto px-6 py-4" tabIndex={0} aria-label={`${title} preview`}>
            <MarkdownPreview text={preview} />
          </div>
        )}
      </div>
      <ConflictDialog
        open={conflict}
        fileName={title}
        onCancel={() => setConflict(false)}
        onReload={() => void reload()}
        onOverwrite={() => {
          setConflict(false)
          void save(true)
        }}
      />
    </div>
  )
}
