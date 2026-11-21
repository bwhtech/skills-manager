// One editor is open at a time. It reports here whether it has unsaved
// changes, so navigation can ask before it throws them away.

let dirty = false
let ask: ((proceed: () => void) => void) | null = null

export function setDirty(value: boolean) {
  dirty = value
}

export function isDirty() {
  return dirty
}

/** The unsaved-changes dialog registers itself here. */
export function registerLeavePrompt(prompt: ((proceed: () => void) => void) | null) {
  ask = prompt
}

/** Run proceed now, or after the user agrees to discard unsaved changes. */
export function confirmLeave(proceed: () => void) {
  if (!dirty) return proceed()
  const run = () => {
    dirty = false
    proceed()
  }
  if (ask) ask(run)
  else if (window.confirm("Discard unsaved changes?")) run()
}

window.addEventListener("beforeunload", (event) => {
  if (dirty) event.preventDefault()
})
