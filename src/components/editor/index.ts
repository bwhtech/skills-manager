import { lazy } from "react"

// CodeMirror and the Markdown preview load on first use.
export const DocumentEditor = lazy(() => import("./document-editor"))
export type { DocumentEditorProps, SaveOptions } from "./document-editor"
export { UnsavedChangesDialog } from "./unsaved-dialog"
export { DirtyDot } from "./editor-toolbar"
