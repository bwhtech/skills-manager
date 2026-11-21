import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { FloppyDiskIcon, LockIcon } from "@hugeicons/core-free-icons"
import { InfoTip } from "@/components/info-tip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ViewMode } from "./view-mode"

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
export const modKey = isMac ? "⌘" : "Ctrl"

interface EditorToolbarProps {
  title: string
  dirty: boolean
  meta?: ReactNode
  readOnlyReason?: string
  mode: ViewMode
  onModeChange?: (mode: ViewMode) => void
  /** Split needs width: phones get Edit and Preview only */
  allowSplit: boolean
  canSave: boolean
  saving: boolean
  onSave: () => void
}

export function EditorToolbar(props: EditorToolbarProps) {
  const { title, dirty, meta, readOnlyReason, mode, onModeChange, allowSplit, canSave, saving, onSave } = props
  return (
    // Phones: the screen bar shows the title. Touch (also a landscape phone in
    // the panel layout): the row scrolls sideways rather than overflow.
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3 max-md:overflow-x-auto max-md:overscroll-x-contain max-md:[scrollbar-width:none] pointer-coarse:h-13 pointer-coarse:overflow-x-auto pointer-coarse:overscroll-x-contain pointer-coarse:[scrollbar-width:none]">
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium max-md:hidden">
        <span className="truncate">{title}</span>
        <DirtyDot dirty={dirty} />
      </span>
      {readOnlyReason && <LockBadge reason={readOnlyReason} />}
      {meta}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {onModeChange && (
          <ToggleGroup
            size="sm"
            variant="outline"
            spacing={0}
            value={[mode]}
            onValueChange={(value: string[]) => value[0] && onModeChange(value[0] as ViewMode)}
            aria-label="View mode"
          >
            <ToggleGroupItem value="edit" className="h-7 px-2.5 text-xs pointer-coarse:h-11 pointer-coarse:px-3.5 pointer-coarse:text-sm">Edit</ToggleGroupItem>
            {allowSplit && <ToggleGroupItem value="split" className="h-7 px-2.5 text-xs pointer-coarse:h-11 pointer-coarse:px-3.5 pointer-coarse:text-sm">Split</ToggleGroupItem>}
            <ToggleGroupItem value="preview" className="h-7 px-2.5 text-xs pointer-coarse:h-11 pointer-coarse:px-3.5 pointer-coarse:text-sm">Preview</ToggleGroupItem>
          </ToggleGroup>
        )}
        {!readOnlyReason && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button size="sm" className="h-7 pointer-coarse:h-11 pointer-coarse:px-4" disabled={!canSave || saving} onClick={onSave} />
              }
            >
              {saving ? <Spinner /> : <HugeiconsIcon icon={FloppyDiskIcon} strokeWidth={2} />}
              Save
            </TooltipTrigger>
            <TooltipContent>
              Save <Kbd>{modKey}</Kbd>
              <Kbd>S</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

export function DirtyDot({ dirty }: { dirty: boolean }) {
  return (
    <span
      aria-label={dirty ? "Unsaved changes" : undefined}
      role={dirty ? "img" : undefined}
      className={`size-2 shrink-0 rounded-full bg-chart-3 transition-opacity ${dirty ? "opacity-100" : "opacity-0"}`}
    />
  )
}

function LockBadge({ reason }: { reason: string }) {
  return (
    <InfoTip render={<Badge variant="secondary" tabIndex={0} />} content={reason}>
      <HugeiconsIcon icon={LockIcon} strokeWidth={2} data-icon="inline-start" />
      Read-only
    </InfoTip>
  )
}
