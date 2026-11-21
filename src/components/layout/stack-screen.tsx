import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons"
import { DirtyDot } from "@/components/editor"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Phone navigation: screens stack on top of each other. The screen below
// stays mounted (inert), so its scroll position and filters survive a Back.

interface StackScreenProps {
  /** a screen is open on top of this one */
  covered?: boolean
  /** the bottom screen of the stack: no slide-in */
  root?: boolean
  className?: string
  children: ReactNode
}

export function StackScreen({ covered = false, root = false, className, children }: StackScreenProps) {
  return (
    <section
      inert={covered}
      className={cn(
        "absolute inset-0 flex min-h-0 flex-col bg-background",
        !root &&
          "shadow-[-1px_0_0_var(--border)] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-[30%]",
        className
      )}
    >
      {children}
    </section>
  )
}

interface ScreenBarProps {
  title: string
  subtitle?: string
  /** where Back goes, for the button's label */
  backLabel: string
  onBack: () => void
  dirty?: boolean
  children?: ReactNode
}

/** Top bar of a stacked screen: back, title, optional actions. Pads for the notch. */
export function ScreenBar({ title, subtitle, backLabel, onBack, dirty, children }: ScreenBarProps) {
  return (
    <header className="shrink-0 border-b pt-[env(safe-area-inset-top)]">
      <div className="flex h-12 items-center gap-1 pr-3 pl-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-11 rounded-full"
          aria-label={`Back to ${backLabel}`}
          onClick={onBack}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-5" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            <span className="truncate">{title}</span>
            {dirty !== undefined && <DirtyDot dirty={dirty} />}
          </h2>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </div>
    </header>
  )
}
