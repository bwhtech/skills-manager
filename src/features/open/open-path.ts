import { toast } from "sonner"
import type { OpenResult, ScopeKey } from "@shared/api"
import { HttpError, api, errorMessage } from "@/lib/api"
import { getPlace, navigate, subscribePlace, type Place } from "@/lib/hash-state"
import type { LinkTarget } from "@/lib/path-links"
import { hasLineEditor, requestLine } from "@/lib/pending-line"
import { getUi, ui, type ViewedFile } from "@/lib/ui-store"
import { confirmDiscard } from "@/lib/unsaved"

/**
 * A document's address for GET /api/open `from` (relative paths start at its folder),
 * and the key of its editor's line requests (lib/pending-line).
 */
export const docAddress = {
  skillFile: (skillId: string, file: string) => `${skillId}:${file}`,
  instruction: (id: string) => id,
}

/** The draft store key of a file in the viewer (lib/drafts.ts). Its line-request key is the path. */
export function viewedFileDraftKey(path: string) {
  return `file:${path}`
}

/** Close the file viewer (then run `then`), after asking when its file has unsaved edits. */
export function closeFileViewer(then?: () => void) {
  const shown = getUi().viewedFile
  if (!shown) return then?.()
  confirmDiscard(viewedFileDraftKey(shown.path), () => {
    ui.closeFile()
    then?.()
  })
}

/** Show a file in the viewer. Replacing another file asks first when that one has unsaved edits. */
function showFile(next: ViewedFile) {
  const shown = getUi().viewedFile
  if (shown?.path === next.path) {
    // The same file: keep the editor (and its undo history), only move to the line.
    ui.viewFile(next)
    if (next.line && hasLineEditor(next.path)) requestLine(next.path, next.line)
    return
  }
  if (!shown) return ui.viewFile(next)
  confirmDiscard(viewedFileDraftKey(shown.path), () => ui.viewFile(next))
}

/** Open a link from the document at `from` (a docAddress, or a viewed file's absolute path). */
export function openLink(link: LinkTarget, from: string) {
  if (link.kind === "url") {
    window.open(link.target, "_blank", "noopener,noreferrer")
    return
  }
  void openPath(link.target, from)
}

async function openPath(raw: string, from: string) {
  let result: OpenResult
  try {
    result = await api.open(raw, from)
  } catch (error) {
    const reason = error instanceof HttpError ? (error.body.detail ?? error.body.error) : errorMessage(error)
    toast.error(`Could not open ${raw}`, { description: reason })
    return
  }
  if (result.kind === "file") {
    showFile({ path: result.path, line: result.line })
    return
  }
  closeFileViewer(() => goTo(result))
}

/** Show a skill file or instruction file in its own editor, at the line. */
function goTo(result: Exclude<OpenResult, { kind: "file" }>) {
  const { key, place } = destination(result)
  // The document is open already (also SKILL.md at file=null): show the line, no move.
  if (hasLineEditor(key)) {
    requestLine(key, result.line)
    return
  }
  // The move goes through the unsaved-changes guard; the line is requested only once it is
  // accepted, and withdrawn if the user leaves the destination before its editor takes it.
  navigate(place, {
    onAccept: () => {
      const arrived = window.location.hash
      const withdraw = requestLine(key, result.line)
      const stop = subscribePlace(() => {
        if (window.location.hash === arrived) return
        withdraw()
        stop()
      })
    },
  })
}

/** Where a skill file or instruction file opens: its line-request key and its place. */
function destination(result: Exclude<OpenResult, { kind: "file" }>): { key: string; place: Partial<Place> } {
  if (result.kind === "instruction")
    return {
      key: docAddress.instruction(result.id),
      place: { tab: "instructions", scope: result.scope, doc: result.id },
    }
  return {
    key: docAddress.skillFile(result.skillId, result.file),
    place: { tab: "skills", scope: skillScope(result.scope, result.scopes), skill: result.skillId, file: result.file },
  }
}

/** Stay in the shown scope when the skill is listed there. */
function skillScope(scope: ScopeKey, scopes: ScopeKey[]): ScopeKey {
  const current = getPlace().scope
  return scopes.includes(current) ? current : scope
}
