import { HugeiconsIcon } from "@hugeicons/react"
import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

function resolvedDark(theme: string) {
  if (theme === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches
  return theme === "dark"
}

/** Whether the page is dark now, and a function that flips it. */
export function useThemeToggle() {
  const { theme, setTheme } = useTheme()
  const dark = resolvedDark(theme)
  return { dark, toggle: () => setTheme(dark ? "light" : "dark") }
}

export function ThemeToggle() {
  const { dark, toggle } = useThemeToggle()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggle}
          />
        }
      >
        <HugeiconsIcon icon={dark ? Sun03Icon : Moon02Icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>
        Toggle theme <Kbd>D</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
