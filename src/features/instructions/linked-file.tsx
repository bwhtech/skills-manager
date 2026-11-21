import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, Edit02Icon, Link01Icon, Unlink01Icon } from "@hugeicons/core-free-icons"
import type { InstructionFile } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useScopes } from "@/lib/api"
import { tildify } from "@/lib/format"
import { openInstruction, refLabel } from "./link-labels"
import { UnlinkDialog } from "./unlink-dialog"

/**
 * Shown in place of an editor for a link: an editor never opens on the link
 * path. A link to a known file offers to open that file; a link elsewhere,
 * or a broken one, can only be unlinked here.
 */
export function LinkedFile({ file }: { file: InstructionFile }) {
  const home = useScopes().data?.home
  const [unlinking, setUnlinking] = useState(false)
  const target = file.linkTargetFile
  const where = <span className="font-mono [overflow-wrap:anywhere]">{tildify(file.linkTarget ?? "", home)}</span>

  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={file.linkBroken ? Alert02Icon : Link01Icon} strokeWidth={2} />
        </EmptyMedia>
        <EmptyTitle className="text-base">
          {file.linkBroken ? `${file.fileName} is a broken link` : `${file.fileName} is synced`}
        </EmptyTitle>
        <EmptyDescription>
          {file.linkBroken ? (
            <>It points at {where}, which does not exist. {file.agentLabel} reads nothing from it.</>
          ) : target ? (
            <>
              {file.agentLabel} reads {refLabel(target, file.path, home)} through this link. Edit that file.
            </>
          ) : (
            <>
              It is a link to {where}, which is not an instruction file that Skills Manager knows. Edit it there, or
              stop syncing to give {file.fileName} its own content.
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        {target && (
          <Button className="pointer-coarse:h-11" onClick={() => openInstruction(file)}>
            <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
            {file.linkBroken ? `Open ${target.fileName}` : `Edit ${target.fileName}`}
          </Button>
        )}
        <Button variant="outline" className="pointer-coarse:h-11" onClick={() => setUnlinking(true)}>
          <HugeiconsIcon icon={Unlink01Icon} strokeWidth={2} />
          Stop syncing…
        </Button>
      </EmptyContent>
      <UnlinkDialog file={file} open={unlinking} onOpenChange={setUnlinking} />
    </Empty>
  )
}
