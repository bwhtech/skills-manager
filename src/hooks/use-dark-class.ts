import { useSyncExternalStore } from "react"

/**
 * Whether the app is in dark mode now: the `.dark` class on <html> that the
 * theme provider sets (it also covers "system"), not prefers-color-scheme.
 */
export function useDarkClass() {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
      return () => observer.disconnect()
    },
    () => document.documentElement.classList.contains("dark")
  )
}
