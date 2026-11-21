import type { InstructionFile } from "@shared/api"
import { Badge } from "@/components/ui/badge"
import { useScopes } from "@/lib/api"
import { tildify } from "@/lib/format"
import { cn } from "@/lib/utils"
import { LinkedBadge } from "./linked-badge"

interface InstructionListProps {
  files: InstructionFile[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function InstructionList({ files, selectedId, onSelect }: InstructionListProps) {
  const home = useScopes().data?.home
  return (
    <ul className="flex flex-col gap-0.5 p-2" aria-label="Instruction files">
      {files.map((file) => (
        <li key={file.id}>
          <button
            type="button"
            onClick={() => onSelect(file.id)}
            aria-current={file.id === selectedId ? "true" : undefined}
            className={cn(
              "flex h-15 w-full flex-col justify-center gap-1 rounded-xl px-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50",
              file.id === selectedId && "bg-muted hover:bg-muted"
            )}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("truncate text-sm font-medium", !file.exists && "text-muted-foreground")}>
                {file.fileName}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{file.agentLabel}</span>
              {file.linkTarget && <LinkedBadge target={file.linkTarget} />}
              {!file.exists && (
                <Badge variant="secondary" className="h-5 px-1.5 font-normal">
                  missing
                </Badge>
              )}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground" title={file.path}>
              {tildify(file.path, home)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
