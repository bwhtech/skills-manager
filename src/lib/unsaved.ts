// The leave guard. Drafts (lib/drafts.ts) know whether any document has
// unsaved changes, also one whose editor is not mounted right now (a layout
// switch unmounted it), so navigation can ask before it throws them away.

import { discardDrafts, hasDirtyDrafts } from "@/lib/drafts"

let ask: ((proceed: () => void) => void) | null = null

export function isDirty() {
  return hasDirtyDrafts()
}

/** The unsaved-changes dialog registers itself here. */
export function registerLeavePrompt(prompt: ((proceed: () => void) => void) | null) {
  ask = prompt
}

/** Run proceed now, or after the user agrees to discard unsaved changes. */
export function confirmLeave(proceed: () => void) {
  if (!isDirty()) return proceed()
  const run = () => {
    discardDrafts()
    proceed()
  }
  if (ask) ask(run)
  else if (window.confirm("Discard unsaved changes?")) run()
}

window.addEventListener("beforeunload", (event) => {
  if (isDirty()) event.preventDefault()
})
