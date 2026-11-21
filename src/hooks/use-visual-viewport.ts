import { useEffect } from "react"

/**
 * iOS Safari does not shrink the layout viewport when the soft keyboard
 * opens (it ignores interactive-widget=resizes-content), so a 100dvh shell
 * runs under the keyboard and the editor toolbar can scroll away. Track the
 * visible height in --app-height; the shell falls back to 100dvh without it.
 * Skipped while pinch-zoomed, where the visual viewport is small on purpose.
 */
export function useVisualViewportHeight() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    const update = () => {
      if (viewport.scale > 1.01) root.style.removeProperty("--app-height")
      else root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`)
    }
    update()
    viewport.addEventListener("resize", update)
    return () => {
      viewport.removeEventListener("resize", update)
      root.style.removeProperty("--app-height")
    }
  }, [])
}
