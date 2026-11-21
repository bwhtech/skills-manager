import { useEffect, useRef } from "react"

/** True when the event comes from a place where typing should win over shortcuts. */
export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return !!target.closest("input, textarea, select, [contenteditable='true']")
}

export function isMod(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey
}

/** Window keydown listener that always calls the latest handler. */
export function useWindowKeydown(handler: (event: KeyboardEvent) => void) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => ref.current(event)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])
}
