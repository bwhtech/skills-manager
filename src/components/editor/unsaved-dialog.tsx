import { useEffect, useRef, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { registerLeavePrompt } from "@/lib/unsaved"

/** Asks before navigation throws away unsaved editor changes. Mount once. */
export function UnsavedChangesDialog() {
  const [open, setOpen] = useState(false)
  const proceed = useRef<(() => void) | null>(null)

  useEffect(() => {
    registerLeavePrompt((next) => {
      proceed.current = next
      setOpen(true)
    })
    return () => registerLeavePrompt(null)
  }, [])

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            The open file has edits that are not saved. They will be lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              setOpen(false)
              proceed.current?.()
              proceed.current = null
            }}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
