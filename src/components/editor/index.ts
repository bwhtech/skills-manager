import { lazy } from "react"

// CodeMirror and the Markdown preview load on first use.
export const DocumentEditor = lazy(() => import("./document-editor"))
export const LazyCodeEditor = lazy(() => import("./code-editor").then((module) => ({ default: module.CodeEditor })))
export type { DocumentEditorProps, SaveOptions } from "./document-editor"
export { UnsavedChangesDialog } from "./unsaved-dialog"
export { DirtyDot } from "./editor-toolbar"
