import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { api, errorMessage, useScopesMutation } from "@/lib/api"
import { navigate } from "@/lib/hash-state"

interface PinProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PinProjectDialog({ open, onOpenChange }: PinProjectDialogProps) {
  const [path, setPath] = useState("")
  const pin = useScopesMutation(api.pin)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = path.trim().replace(/\/+$/, "")
    if (!value) return
    pin.mutate(value, {
      onSuccess: (data) => {
        onOpenChange(false)
        setPath("")
        pin.reset()
        if (data.projects.some((project) => project.path === value)) navigate({ scope: value })
      },
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) pin.reset()
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="grid gap-6">
          <DialogHeader>
            <DialogTitle>Pin a project</DialogTitle>
            <DialogDescription>
              Add a project folder that the scan did not find. Pinned projects stay at the top.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="pin-path">Absolute path</Label>
            <Input
              id="pin-path"
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/home/me/code/my-project"
              aria-invalid={pin.isError || undefined}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            {pin.isError && <p className="text-xs text-destructive">{errorMessage(pin.error)}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!path.trim() || pin.isPending}>
              {pin.isPending && <Spinner />}
              Pin project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
