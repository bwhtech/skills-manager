import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { FloppyDiskIcon, LockIcon } from "@hugeicons/core-free-icons"
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
  canSave: boolean
  saving: boolean
  onSave: () => void
}

export function EditorToolbar(props: EditorToolbarProps) {
  const { title, dirty, meta, readOnlyReason, mode, onModeChange, canSave, saving, onSave } = props
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <span className="truncate">{title}</span>
        <DirtyDot dirty={dirty} />
      </span>
      {readOnlyReason && <LockBadge reason={readOnlyReason} />}
      {meta}
      <div className="ml-auto flex items-center gap-2">
        {onModeChange && (
          <ToggleGroup
            size="sm"
            variant="outline"
            spacing={0}
            value={[mode]}
            onValueChange={(value: string[]) => value[0] && onModeChange(value[0] as ViewMode)}
            aria-label="View mode"
          >
            <ToggleGroupItem value="edit" className="h-7 px-2.5 text-xs">Edit</ToggleGroupItem>
            <ToggleGroupItem value="split" className="h-7 px-2.5 text-xs">Split</ToggleGroupItem>
            <ToggleGroupItem value="preview" className="h-7 px-2.5 text-xs">Preview</ToggleGroupItem>
          </ToggleGroup>
        )}
        {!readOnlyReason && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button size="sm" className="h-7" disabled={!canSave || saving} onClick={onSave} />
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
    <Tooltip>
      <TooltipTrigger render={<Badge variant="secondary" tabIndex={0} />}>
        <HugeiconsIcon icon={LockIcon} strokeWidth={2} data-icon="inline-start" />
        Read-only
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}
