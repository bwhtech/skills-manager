import type { InstructionFile } from "@shared/api"
import { Badge } from "@/components/ui/badge"
import { useScopes } from "@/lib/api"
import { tildify } from "@/lib/format"
import { cn } from "@/lib/utils"
import { InstructionMenu } from "./instruction-menu"
import { AlsoReadAsLine, LinkLine, alsoReadAs, refLabel } from "./link-labels"

interface InstructionListProps {
  files: InstructionFile[]
  selectedId: string | null
  onSelect: (file: InstructionFile) => void
}

export function InstructionList({ files, selectedId, onSelect }: InstructionListProps) {
  const home = useScopes().data?.home
  return (
    <ul className="flex flex-col gap-0.5 p-2" aria-label="Instruction files">
      {files.map((file) => {
        const selected = file.id === selectedId
        return (
          <li
            key={file.id}
            className={cn(
              "group/row relative flex items-stretch rounded-xl hover:bg-muted/60 no-hover:hover:bg-transparent",
              selected && "bg-muted hover:bg-muted no-hover:hover:bg-muted"
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(file)}
              aria-current={selected ? "true" : undefined}
              aria-label={rowLabel(file, home)}
              className="pressable flex min-h-15 min-w-0 flex-1 flex-col justify-center gap-1 rounded-xl py-2 pr-1 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("truncate text-sm font-medium", !file.exists && !file.linkTarget && "text-muted-foreground")}>
                  {file.fileName}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{file.agentLabel}</span>
                <StateBadge file={file} />
              </span>
              {file.linkTarget ? (
                <LinkLine file={file} home={home} />
              ) : (
                <span className="truncate font-mono text-xs text-muted-foreground" title={file.path}>
                  {tildify(file.path, home)}
                </span>
              )}
              <AlsoReadAsLine file={file} home={home} />
            </button>
            <InstructionMenu file={file} />
          </li>
        )
      })}
    </ul>
  )
}

function StateBadge({ file }: { file: InstructionFile }) {
  if (file.linkBroken) {
    return (
      <Badge variant="outline" className="h-5 border-amber-500/50 px-1.5 font-normal text-amber-700 dark:text-amber-300">
        broken link
      </Badge>
    )
  }
  if (file.linkTarget) {
    return (
      <Badge variant="outline" className="h-5 px-1.5 font-normal">
        synced
      </Badge>
    )
  }
  if (!file.exists) {
    return (
      <Badge variant="secondary" className="h-5 px-1.5 font-normal">
        missing
      </Badge>
    )
  }
  return null
}

/** What a screen reader hears for a row, with where a link leads. */
function rowLabel(file: InstructionFile, home: string | undefined) {
  const parts = [file.fileName, file.agentLabel]
  if (file.linkBroken) parts.push(`broken link to ${tildify(file.linkTarget!, home)}`)
  else if (file.linkTargetFile) parts.push(`synced to ${refLabel(file.linkTargetFile, file.path, home)}, opens it`)
  else if (file.linkTarget) parts.push(`synced to ${tildify(file.linkTarget, home)}`)
  else if (!file.exists) parts.push("missing")
  else parts.push(tildify(file.path, home))
  const also = alsoReadAs(file, home)
  if (also) parts.push(also)
  return parts.join(", ")
}
