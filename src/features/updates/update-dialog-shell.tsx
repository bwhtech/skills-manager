import type { ReactNode, RefObject } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

// Layout shared by the update dialogs. Desktop: a wide dialog, up to 85% of
// the viewport tall, with a scrolling body and the footer pinned below it.
// Phones: full screen like the install dialog, with safe-area padding and the
// footer above the home indicator.

interface UpdateDialogShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Cancel: an update overwrites files, so focus starts on the safe choice. */
  initialFocus: RefObject<HTMLElement | null>
  children: ReactNode
}

export function UpdateDialogShell({ open, onOpenChange, initialFocus, children }: UpdateDialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={initialFocus}
        className={cn(
          "flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1100px,calc(100%-2rem))]",
          "max-md:inset-0 max-md:h-[var(--app-height,100dvh)] max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:ring-0",
          "max-md:*:data-[slot=dialog-close]:top-[calc(0.75rem+env(safe-area-inset-top))] max-md:*:data-[slot=dialog-close]:right-[max(0.75rem,env(safe-area-inset-right))] max-md:*:data-[slot=dialog-close]:size-11"
        )}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

export function UpdateDialogHeader({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <DialogHeader
      className={cn(
        "shrink-0 border-b px-6 pt-6 pr-14 pb-4",
        "max-md:pt-[calc(1.25rem+env(safe-area-inset-top))] max-md:pr-16 max-md:pl-[max(1rem,env(safe-area-inset-left))]"
      )}
    >
      <DialogTitle className="leading-snug break-words">{title}</DialogTitle>
      <DialogDescription render={<div />} className="text-xs">
        {description}
      </DialogDescription>
    </DialogHeader>
  )
}

export function UpdateDialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 py-4",
        "max-md:pr-[max(1rem,env(safe-area-inset-right))] max-md:pl-[max(1rem,env(safe-area-inset-left))]",
        className
      )}
    >
      {children}
    </div>
  )
}

export function UpdateDialogFooter({ children }: { children: ReactNode }) {
  return (
    <DialogFooter
      className={cn(
        "shrink-0 items-center border-t bg-popover px-6 py-3",
        "max-md:grid max-md:grid-cols-2 max-md:pt-3 max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
        "max-md:pr-[max(1rem,env(safe-area-inset-right))] max-md:pl-[max(1rem,env(safe-area-inset-left))]",
        "pointer-coarse:**:data-[slot=button]:h-11"
      )}
    >
      {children}
    </DialogFooter>
  )
}
