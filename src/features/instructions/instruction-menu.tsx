import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Edit02Icon, Link01Icon, MoreHorizontalIcon, Unlink01Icon } from "@hugeicons/core-free-icons"
import type { InstructionFile } from "@shared/api"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { openInstruction } from "./link-labels"
import { SyncDialog } from "./sync-dialog"
import { UnlinkDialog } from "./unlink-dialog"

const TRIGGER = "mr-1 size-8 self-center text-muted-foreground pointer-coarse:size-11"

/** The ⋯ menu of a row: sync other files to a regular file, or stop syncing a link. */
export function InstructionMenu({ file }: { file: InstructionFile }) {
  const [dialog, setDialog] = useState<"sync" | "unlink" | null>(null)
  const isLink = !!file.linkTarget
  // A missing file has nothing to sync to it; it can become a link from another file's menu.
  if (!isLink && !file.exists) return <span aria-hidden className={TRIGGER} />

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" className={TRIGGER} aria-label={`Actions for ${file.fileName}`} />}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          {isLink ? (
            <>
              {file.linkTargetFile && (
                <DropdownMenuItem onClick={() => openInstruction(file)}>
                  <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
                  Edit {file.linkTargetFile.fileName}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setDialog("unlink")}>
                <HugeiconsIcon icon={Unlink01Icon} strokeWidth={2} />
                Stop syncing…
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onClick={() => setDialog("sync")}>
              <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
              Sync another file to this…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {isLink ? (
        <UnlinkDialog file={file} open={dialog === "unlink"} onOpenChange={(open) => setDialog(open ? "unlink" : null)} />
      ) : (
        <SyncDialog target={file} open={dialog === "sync"} onOpenChange={(open) => setDialog(open ? "sync" : null)} />
      )}
    </>
  )
}
