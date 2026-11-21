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

interface ConflictDialogProps {
  open: boolean
  fileName: string
  onCancel: () => void
  onReload: () => void
  onOverwrite: () => void
}

export function ConflictDialog({ open, fileName, onCancel, onReload, onOverwrite }: ConflictDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Changed on disk</AlertDialogTitle>
          <AlertDialogDescription>
            {fileName} changed on disk after you opened it. Reload to discard your edits and
            load the file from disk, or overwrite the file with your version.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="outline" onClick={onReload}>
            Reload (discard mine)
          </AlertDialogAction>
          <AlertDialogAction variant="destructive" onClick={onOverwrite}>
            Overwrite
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
