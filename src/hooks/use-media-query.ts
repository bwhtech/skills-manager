import { useSyncExternalStore } from "react"

/** Live result of a media query. */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query)
      media.addEventListener("change", onChange)
      return () => media.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches
  )
}

/** Layout breakpoint (Tailwind `md`): below it the app stacks screens instead of side-by-side panels. */
export const DESKTOP_QUERY = "(min-width: 768px)"

export function useIsDesktop() {
  return useMediaQuery(DESKTOP_QUERY)
}

/** Capability, not size: true when the primary input can hover (a mouse or trackpad). */
export function useCanHover() {
  return useMediaQuery("(hover: hover)")
}
