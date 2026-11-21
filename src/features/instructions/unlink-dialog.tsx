import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { InstructionFile, UnlinkInstructionRequest } from "@shared/api"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { api, errorMessage, invalidateInstructions, useScopes } from "@/lib/api"
import { tildify } from "@/lib/format"
import { navigate } from "@/lib/hash-state"
import { cn } from "@/lib/utils"
import { refLabel, shortPath } from "./link-labels"

type Mode = UnlinkInstructionRequest["mode"]

interface UnlinkDialogProps {
  file: InstructionFile
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** "Stop syncing…": the link becomes a regular file again. The target is not touched. */
export function UnlinkDialog({ file, open, onOpenChange }: UnlinkDialogProps) {
  const client = useQueryClient()
  const home = useScopes().data?.home
  const broken = !!file.linkBroken
  const [mode, setMode] = useState<Mode>(broken ? "empty" : "copy")
  const target = file.linkTargetFile
    ? refLabel(file.linkTargetFile, file.path, home)
    : shortPath(file.linkTarget ?? "", file.path, home)

  const unlink = useMutation({
    mutationFn: () => api.unlinkInstruction(file.id, { mode }),
    onSuccess: async ({ file: updated }) => {
      // Lists first: until they know the file is no link, opening it would follow the old link.
      await invalidateInstructions(client)
      onOpenChange(false)
      toast.success(`${file.fileName} is its own file again`)
      navigate({ scope: updated.scope, doc: updated.id })
    },
    onError: (error) => toast.error(`Could not stop syncing ${file.fileName}`, { description: errorMessage(error) }),
  })

  const openChange = (next: boolean) => {
    if (unlink.isPending) return
    if (next) setMode(broken ? "empty" : "copy")
    onOpenChange(next)
  }

  return (
    <AlertDialog open={open} onOpenChange={openChange}>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Stop syncing {file.fileName}?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono [overflow-wrap:anywhere]">{tildify(file.path, home)}</span> is a link to {target}. It becomes a
            regular file. {target} stays as it is.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div role="radiogroup" aria-label="Content of the new file" className="flex flex-col gap-2 text-left">
          <Choice
            checked={mode === "copy"}
            disabled={broken}
            onSelect={() => setMode("copy")}
            title="Keep a copy of the current content"
            detail={broken ? "The link is broken: there is no content to copy." : "Starts as a copy. Later edits go to one file only."}
          />
          <Choice
            checked={mode === "empty"}
            onSelect={() => setMode("empty")}
            title="Start empty"
            detail="The new file is empty until you write it."
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="pointer-coarse:h-11" disabled={unlink.isPending}>
            Cancel
          </AlertDialogCancel>
          <Button className="pointer-coarse:h-11" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
            {unlink.isPending && <Spinner />}
            Stop syncing
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface ChoiceProps {
  checked: boolean
  disabled?: boolean
  onSelect: () => void
  title: string
  detail: string
}

function Choice({ checked, disabled, onSelect, title, detail }: ChoiceProps) {
  return (
    <label
      className={cn(
        "flex min-h-11 items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors",
        checked ? "border-primary/50 bg-primary/5" : "hover:bg-muted/40 no-hover:hover:bg-transparent",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      )}
    >
      <input
        type="radio"
        name="unlink-mode"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  )
}
