import { useEffect, useRef } from "react"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState } from "@codemirror/state"
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import type { LinkTarget } from "@/lib/path-links"
import { subscribeLineRequests, takePendingLine } from "@/lib/pending-line"
import { cn } from "@/lib/utils"
import { editorTheme } from "./editor-theme"
import { highlighting } from "./highlight"
import { languageForPath } from "./languages"
import { linkClicks } from "./link-clicks"

interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  /** file path, used to pick the language */
  path: string
  ariaLabel: string
  className?: string
  /** Cmd/Ctrl+click on a path or URL in the text */
  onOpenLink?: (link: LinkTarget) => void
  /** 1-based line to put the cursor on and scroll to when the view is created */
  initialLine?: number
  /** this document's key for line requests (lib/pending-line): taken on mount and while mounted */
  lineKey?: string
}

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  path,
  ariaLabel,
  className,
  onOpenLink,
  initialLine,
  lineKey,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const compartments = useRef({ language: new Compartment(), readOnly: new Compartment() })
  const onChangeRef = useRef(onChange)
  const onOpenLinkRef = useRef(onOpenLink)

  useEffect(() => {
    onChangeRef.current = onChange
    onOpenLinkRef.current = onOpenLink
  })

  // Create the view once. Later prop changes go through the effects below.
  useEffect(() => {
    const { language, readOnly: readOnlyCompartment } = compartments.current
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
          editorTheme,
          highlighting,
          language.of([]),
          readOnlyCompartment.of(readOnlyExtensions(readOnly)),
          linkClicks(() => onOpenLinkRef.current),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = editor
    showLine(editor, initialLine ?? (lineKey ? takePendingLine(lineKey) : undefined))
    return () => {
      editor.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once
  }, [])

  // A line request for this document while it is open (a :line link to it).
  useEffect(() => {
    if (!lineKey) return
    return subscribeLineRequests(lineKey, () => {
      const line = takePendingLine(lineKey)
      if (view.current) showLine(view.current, line)
    })
  }, [lineKey])

  useEffect(() => {
    let cancelled = false
    void languageForPath(path).then((support) => {
      if (cancelled || !view.current) return
      view.current.dispatch({
        effects: compartments.current.language.reconfigure(support ?? []),
      })
    })
    return () => {
      cancelled = true
    }
  }, [path])

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure(readOnlyExtensions(readOnly)),
    })
  }, [readOnly])

  // Replace the document when the value changes from outside (reload).
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={host} className={cn("h-full min-h-0 overflow-hidden", className)} />
}

/** Put the cursor at the start of a 1-based line and scroll it to the middle. */
function showLine(editor: EditorView, line: number | undefined) {
  if (!line || line > editor.state.doc.lines) return
  const at = editor.state.doc.line(line).from
  editor.dispatch({
    selection: { anchor: at },
    effects: EditorView.scrollIntoView(at, { y: "center" }),
  })
}

// Read-only keeps the content focusable, so text can still be selected and searched.
function readOnlyExtensions(readOnly: boolean) {
  return EditorState.readOnly.of(readOnly)
}
