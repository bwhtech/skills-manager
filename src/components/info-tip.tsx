import type { ReactElement, ReactNode } from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useCanHover } from "@/hooks/use-media-query"
import { cn } from "@/lib/utils"

interface InfoTipProps {
  /** the trigger element, as for TooltipTrigger's render prop */
  render: ReactElement<Record<string, unknown>>
  children: ReactNode
  content: ReactNode
  contentClassName?: string
}

/**
 * A tooltip that also works on touch. Tooltips open on hover, which touch
 * does not have, so without a hover-capable pointer a tap opens the same
 * text as a popover. With a mouse it is the plain Tooltip.
 */
export function InfoTip({ render, children, content, contentClassName }: InfoTipProps) {
  const canHover = useCanHover()
  if (canHover) {
    return (
      <Tooltip>
        <TooltipTrigger render={render}>{children}</TooltipTrigger>
        <TooltipContent className={contentClassName}>{content}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        render={render}
        nativeButton={false}
        // Inside a list row, a tap shows the tip instead of opening the row.
        onClick={(event) => event.stopPropagation()}
        // A badge is small: grow its hit area to 44px without moving the layout.
        className="relative overflow-visible! after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']"
      >
        {children}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="bottom" sideOffset={8} collisionPadding={12} className="isolate z-50">
          <PopoverPrimitive.Popup
            className={cn(
              "max-w-[min(20rem,calc(100vw-1.5rem))] origin-(--transform-origin) rounded-xl bg-foreground px-3 py-2 text-xs text-background shadow-lg outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              contentClassName
            )}
          >
            {content}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
