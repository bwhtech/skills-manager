import { useRef, useState, useSyncExternalStore } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { InstructionFile, SyncCandidate, SyncPreview, UpdateFileChange } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import {
  api,
  errorMessage,
  invalidateInstructions,
  isConflict,
  keys,
  useScopes,
  useSyncPreview,
} from "@/lib/api"
import { beginSave, failSave, finishSave, getDraft, isDraftDirty, rebaseDraft, subscribeDrafts } from "@/lib/drafts"
import { plural, scopeLabel, tildify } from "@/lib/format"
import { cn } from "@/lib/utils"
import { DiffLayoutToggle, FileChangeList, preloadDiffView } from "@/features/updates/file-changes"
import {
  CONFIRM_WRAP,
  UpdateDialogBody,
  UpdateDialogFooter,
  UpdateDialogHeader,
  UpdateDialogShell,
} from "@/features/updates/update-dialog-shell"
import { instructionDraftKey } from "./instruction-editor"

/** The file has edits in an editor (mounted or not) that are not on disk. */
function hasUnsavedDraft(fileId: string) {
  return isDraftDirty(getDraft(instructionDraftKey(fileId)))
}

interface SyncDialogProps {
  /** the regular file the picked files will link to */
  target: InstructionFile
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * "Sync another file to this…": pick instruction files that become symlinks
 * to the target. Each shows how its content differs from the target's and
 * where the server backs it up before the link replaces it.
 */
export function SyncDialog({ target, open, onOpenChange }: SyncDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const client = useQueryClient()
  const { data: scopes } = useScopes()
  const home = scopes?.home
  const preview = useSyncPreview(target.id, open)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [running, setRunning] = useState(false)

  const openChange = (next: boolean) => {
    if (running) return
    if (next) {
      setTicked(new Set())
      preloadDiffView()
    }
    onOpenChange(next)
  }

  const candidates = preview.data?.candidates ?? []
  const chosen = candidates.filter((c) => !c.blocked && ticked.has(c.file.id))
  // Linking a file with unsaved edits would swap its editor for the link
  // view: the edits would vanish without the leave guard. Block until they
  // are saved (then the preview has the new hash) or discarded.
  const dirtyIds = useSyncExternalStore(subscribeDrafts, () =>
    candidates
      .filter((c) => hasUnsavedDraft(c.file.id))
      .map((c) => c.file.id)
      .join("\n")
  )
  const dirty = new Set(dirtyIds.split("\n").filter(Boolean))
  const chosenDirty = chosen.filter((c) => dirty.has(c.file.id))
  const [savingDraft, setSavingDraft] = useState<string | null>(null)

  const saveDraft = async (file: InstructionFile) => {
    const key = instructionDraftKey(file.id)
    const start = beginSave(key)
    if (!start) return
    setSavingDraft(file.id)
    try {
      const result = await api.saveInstruction(file.id, { content: start.content, baseHash: start.baseHash })
      finishSave(key, start, result)
      toast.success(`Saved ${file.fileName}`)
      void client.invalidateQueries({ queryKey: keys.instruction(file.id) })
      // The preview compared the old content: compare again before a sync.
      await preview.refetch()
    } catch (error) {
      failSave(key, start, { conflict: isConflict(error) })
      toast.error(`Could not save ${file.fileName}`, {
        description: isConflict(error) ? "It changed on disk. Open it to resolve the conflict." : errorMessage(error),
      })
    } finally {
      setSavingDraft(null)
    }
  }

  const discardDraft = (file: InstructionFile) => {
    const key = instructionDraftKey(file.id)
    const draft = getDraft(key)
    if (draft && !draft.saving) rebaseDraft(key, draft.base)
  }

  const toggle = (id: string, value: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (value) next.add(id)
      else next.delete(id)
      return next
    })

  const confirm = async () => {
    setRunning(true)
    const done: { file: InstructionFile; backupPath: string | null }[] = []
    const failed: { file: InstructionFile; error: unknown }[] = []
    for (const candidate of chosen) {
      // Again right before sending: an editor may have changed it meanwhile.
      if (hasUnsavedDraft(candidate.file.id)) {
        failed.push({ file: candidate.file, error: new Error(`${candidate.file.fileName} has unsaved changes`) })
        continue
      }
      try {
        const res = await api.linkInstruction(candidate.file.id, {
          targetId: target.id,
          baseHash: candidate.hash,
          backup: true,
        })
        done.push({ file: candidate.file, backupPath: res.backupPath })
      } catch (error) {
        failed.push({ file: candidate.file, error })
      }
    }
    await invalidateInstructions(client)
    setRunning(false)
    if (done.length > 0) {
      const backups = done.flatMap((d) => (d.backupPath ? [tildify(d.backupPath, home)] : []))
      toast.success(`Synced ${plural(done.length, "file")} to ${target.fileName}`, {
        description: backups.length > 0 ? `Backed up to ${backups.join(", ")}` : undefined,
      })
    }
    for (const { file, error } of failed) {
      toast.error(`Could not sync ${tildify(file.path, home)}`, { description: errorMessage(error) })
    }
    if (failed.length === 0) onOpenChange(false)
    else {
      setTicked(new Set(failed.map((f) => f.file.id)))
      void preview.refetch()
    }
  }

  return (
    <UpdateDialogShell open={open} onOpenChange={openChange} initialFocus={cancelRef}>
      <UpdateDialogHeader
        title={<>Sync other files to {target.fileName}</>}
        description={
          <>
            Each file you tick becomes a symlink to{" "}
            <span className="font-mono [overflow-wrap:anywhere]">{tildify(target.path, home)}</span>. Its agent then reads this file,
            and edits to it apply to every synced file.
          </>
        }
      />
      <UpdateDialogBody>
        {preview.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Comparing files…
          </p>
        ) : preview.isError ? (
          <p className="text-sm text-destructive">Could not compare files: {errorMessage(preview.error)}</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">There are no other instruction files to sync here.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Files that can read {target.fileName}
              </span>
              <DiffLayoutToggle />
            </div>
            <ul className="flex flex-col gap-2" aria-label="Files to sync">
              {candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.file.id}
                  candidate={candidate}
                  preview={preview.data}
                  target={target}
                  scopeName={candidate.file.scope === target.scope ? null : scopeLabel(candidate.file.scope, scopes?.projects)}
                  home={home}
                  ticked={ticked.has(candidate.file.id)}
                  disabled={running}
                  onTick={(value) => toggle(candidate.file.id, value)}
                  unsaved={
                    dirty.has(candidate.file.id) && !candidate.blocked
                      ? {
                          saving: savingDraft === candidate.file.id,
                          onSave: () => void saveDraft(candidate.file),
                          onDiscard: () => discardDraft(candidate.file),
                        }
                      : null
                  }
                />
              ))}
            </ul>
          </>
        )}
      </UpdateDialogBody>
      <UpdateDialogFooter>
        <Button ref={cancelRef} variant="outline" onClick={() => openChange(false)} disabled={running}>
          Cancel
        </Button>
        <Button
          onClick={() => void confirm()}
          disabled={chosen.length === 0 || chosenDirty.length > 0 || running || !!savingDraft}
          className={CONFIRM_WRAP}
        >
          {running && <Spinner />}
          {chosen.length === 0 ? "Sync files" : `Sync ${plural(chosen.length, "file")}`}
        </Button>
      </UpdateDialogFooter>
    </UpdateDialogShell>
  )
}

interface CandidateRowProps {
  candidate: SyncCandidate
  preview: SyncPreview
  target: InstructionFile
  /** set when the file is in another scope than the target */
  scopeName: string | null
  home: string | undefined
  ticked: boolean
  disabled: boolean
  onTick: (value: boolean) => void
  /** set when the file has unsaved edits in an editor */
  unsaved: { saving: boolean; onSave: () => void; onDiscard: () => void } | null
}

function CandidateRow(props: CandidateRowProps) {
  const { candidate, preview, target, scopeName, home, ticked, disabled, onTick, unsaved } = props
  const { file, blocked } = candidate
  const changed = candidate.linesAdded + candidate.linesRemoved
  const differs = file.exists && !candidate.identical && !blocked
  const change: UpdateFileChange = {
    path: tildify(file.path, home),
    status: "modified",
    binary: false,
    oldContent: candidate.content ?? "",
    newContent: preview.targetContent,
    linesAdded: candidate.linesAdded,
    linesRemoved: candidate.linesRemoved,
  }

  return (
    <li className={cn("overflow-hidden rounded-2xl border", ticked && "border-primary/40 bg-primary/3")}>
      <label
        className={cn(
          "flex min-h-11 items-start gap-2.5 px-3 py-2.5",
          blocked ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-muted/40 no-hover:hover:bg-transparent"
        )}
      >
        <Checkbox
          className="mt-0.5"
          checked={ticked && !blocked}
          disabled={!!blocked || disabled}
          onCheckedChange={(value) => onTick(value)}
          aria-label={`Make ${file.path} a link to ${target.path}`}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
            <span className="font-medium">{file.fileName}</span>
            <span className="text-xs text-muted-foreground">
              {scopeName ? `${scopeName} · ` : ""}
              {file.agentLabel}
            </span>
          </span>
          <span className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground" title={file.path}>
            {tildify(file.path, home)}
          </span>
          <span className="text-xs">
            {blocked ? (
              <span className="text-muted-foreground">{blocked}</span>
            ) : !file.exists ? (
              <span className="text-muted-foreground">Missing: it will be created as a link. Nothing to back up.</span>
            ) : candidate.identical ? (
              <span className="text-muted-foreground">Same content as {target.fileName}</span>
            ) : (
              <span className="text-amber-700 dark:text-amber-300">
                Differs — {plural(changed, "line")}. {file.agentLabel} will read {target.fileName} instead.
              </span>
            )}
          </span>
          {!blocked && (file.linkedFrom?.length ?? 0) > 0 && (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              {plural(file.linkedFrom!.length, "other file")} {file.linkedFrom!.length === 1 ? "reads" : "read"} it
              through a link ({file.linkedFrom!.map((ref) => tildify(ref.path, home)).join(", ")}). They will read{" "}
              {target.fileName} too.
            </span>
          )}
          {candidate.backupPath && !blocked && (
            <span className="text-xs text-muted-foreground">
              Will be backed up to <span className="font-mono [overflow-wrap:anywhere]">{tildify(candidate.backupPath, home)}</span>
            </span>
          )}
        </span>
      </label>
      {unsaved && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-amber-500/8 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200"
        >
          <span className="min-w-0 flex-1 basis-56">
            {file.fileName} has unsaved changes — save or discard them first. The diff below is of the file on disk.
          </span>
          <span className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" className="h-7 pointer-coarse:h-11" onClick={unsaved.onDiscard} disabled={unsaved.saving}>
              Discard
            </Button>
            <Button size="sm" className="h-7 pointer-coarse:h-11" onClick={unsaved.onSave} disabled={unsaved.saving}>
              {unsaved.saving && <Spinner />}
              Save
            </Button>
          </span>
        </div>
      )}
      {differs && <FileChangeList files={[change]} className="rounded-none border-x-0 border-b-0" />}
    </li>
  )
}
