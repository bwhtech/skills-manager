import { useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon, CircleArrowUp02Icon, Delete02Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { SkillSummary, UpdatePreview, UpstreamSkillRef } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import {
  api,
  errorMessage,
  isBeingUpdated,
  previewFailure,
  useJobMutation,
  useRunningUpdates,
  useScopes,
  useUpdatePreview,
  useUpdates,
} from "@/lib/api"
import { plural, scopeLabel } from "@/lib/format"
import { ambiguousInScope, cliNameOf, cliSourceOf, deletedInScope, sameSource } from "@/lib/upstream"
import { cn } from "@/lib/utils"
import { showJob } from "@/features/jobs/job-store"
import { DiffLayoutToggle, FileChangeList, preloadDiffView } from "./file-changes"
import { OVERWRITE_DETAIL } from "./copy"
import { AmbiguousUpstreamNote, confirmLabel, DeletedUpstreamSection, useDeletedChoices } from "./deleted-upstream"
import {
  OverwriteWarning,
  PreviewSummary,
  overwritesFiles,
  shortRef,
  sourceHref,
} from "./preview-parts"
import { PreviewError, PreviewLoading, UpToDateNote } from "./preview-states"
import { UpdateDialogBody, UpdateDialogFooter, UpdateDialogHeader, UpdateDialogShell } from "./update-dialog-shell"

interface UpdateSkillDialogProps {
  skill: SkillSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Confirm a single-skill update, with a preview of what `skills update` would change.
 * Other skills from the same source that are deleted upstream are listed to be removed
 * too. When the skill itself is deleted upstream (flagged by the check, or its preview
 * says 409 not_upstream), the dialog becomes a "Remove deleted skill" confirmation.
 */
export function UpdateSkillDialog({ skill, open, onOpenChange }: UpdateSkillDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const projects = useScopes().data?.projects
  const status = useUpdates().data
  const cliName = cliNameOf(skill)
  // A skill the check already found deleted needs no upstream fetch.
  const preview = useUpdatePreview(skill.id, open && !skill.deletedUpstream)
  const update = useJobMutation(api.runUpdate)
  const runningTargets = useRunningUpdates()
  // A preview taken while an update of this skill runs predates that update.
  const running = isBeingUpdated(runningTargets, skill.scope, cliName)

  const data = preview.data
  const failure = preview.isError ? previewFailure(preview.error) : null
  const selfDeleted = !!skill.deletedUpstream || !!failure?.deletedUpstream
  const scopeName = scopeLabel(skill.scope, projects)

  const self: UpstreamSkillRef = { scope: skill.scope, name: cliName, source: cliSourceOf(skill) ?? "" }
  const sameSourceDeleted = deletedInScope(status, skill.scope).filter(
    (item) => sameSource(item, skill) && item.name.toLowerCase() !== cliName.toLowerCase()
  )
  const deletedItems = selfDeleted ? [self, ...sameSourceDeleted] : sameSourceDeleted
  const choices = useDeletedChoices(deletedItems, (name) =>
    isBeingUpdated(runningTargets, skill.scope, name) ? "Running…" : null
  )
  const remove = choices.selected
  const ambiguous = ambiguousInScope(status, skill.scope).filter((item) => sameSource(item, skill))

  const confirm = () =>
    update.mutate(
      // names empty + remove: the job only removes.
      { scope: skill.scope, names: selfDeleted ? [] : [cliName], ...(remove.length ? { remove } : {}) },
      {
        onSuccess: ({ jobId }) => {
          onOpenChange(false)
          showJob(jobId)
        },
        onError: (error) =>
          toast.error(selfDeleted ? `Could not remove ${skill.name}` : `Could not update ${skill.name}`, {
            description: errorMessage(error),
          }),
      }
    )

  if (selfDeleted) {
    return (
      <UpdateDialogShell open={open} onOpenChange={onOpenChange} initialFocus={cancelRef}>
        <UpdateDialogHeader
          title={`Remove deleted skill ${skill.name}?`}
          description={<SkillMeta skill={skill} scopeName={scopeName} />}
        />
        <UpdateDialogBody>
          <p className="text-sm">
            <span className="font-medium">{skill.name}</span> is no longer in its source, so skills update skips it
            and cannot bring it back. Remove the local copy, or keep it as it is.
          </p>
          <DeletedUpstreamSection scope={skill.scope} choices={choices} />
        </UpdateDialogBody>
        <UpdateDialogFooter>
          <p className="mr-auto min-w-0 text-xs text-muted-foreground max-md:col-span-2">
            {running
              ? "An update of this skill is running. Wait for it to finish."
              : remove.length
                ? `Runs skills remove for ${remove.length > 2 ? plural(remove.length, "skill") : remove.join(", ")}.`
                : "Nothing selected: every skill is kept."}
          </p>
          <Button ref={cancelRef} variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={remove.length === 0 || update.isPending || running} onClick={confirm}>
            {update.isPending || running ? <Spinner /> : <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />}
            {running ? "Running…" : confirmLabel(0, remove.length)}
          </Button>
        </UpdateDialogFooter>
      </UpdateDialogShell>
    )
  }

  const baseLabel =
    failure && !failure.blocking ? "Update without preview" : data?.upToDate ? "Update anyway" : "Update"
  const updateLabel = running ? "Update running…" : remove.length ? `${baseLabel} · remove ${remove.length}` : baseLabel

  return (
    <UpdateDialogShell open={open} onOpenChange={onOpenChange} initialFocus={cancelRef}>
      <UpdateDialogHeader
        title={`Update ${skill.name}?`}
        description={<SkillMeta skill={skill} scopeName={scopeName} preview={data} />}
      />
      <UpdateDialogBody>
        {preview.isPending ? (
          <PreviewLoading />
        ) : preview.isError ? (
          <PreviewError error={preview.error} onRetry={() => void preview.refetch()} retrying={preview.isFetching} />
        ) : preview.data.upToDate ? (
          <UpToDateNote />
        ) : (
          <PreviewDetails preview={preview.data} />
        )}
        <DeletedUpstreamSection scope={skill.scope} choices={choices} />
        <AmbiguousUpstreamNote items={ambiguous} />
      </UpdateDialogBody>
      <UpdateDialogFooter>
        {running ? (
          <p className="mr-auto min-w-0 text-xs text-muted-foreground max-md:col-span-2">
            An update of this skill is running. Wait for it to finish.
          </p>
        ) : failure?.blocking ? (
          <p className="mr-auto min-w-0 text-xs text-destructive max-md:col-span-2">Update is off for this skill.</p>
        ) : (
          remove.length > 0 && (
            <p className="mr-auto min-w-0 text-xs text-muted-foreground max-md:col-span-2">
              Then removes {remove.length > 2 ? plural(remove.length, "skill") : remove.join(", ")}.
            </p>
          )
        )}
        <Button ref={cancelRef} variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant={data?.upToDate || (failure && !failure.blocking) ? "secondary" : "default"}
          disabled={preview.isPending || !!failure?.blocking || update.isPending || running}
          onClick={confirm}
        >
          {update.isPending || running ? <Spinner /> : <HugeiconsIcon icon={CircleArrowUp02Icon} strokeWidth={2} />}
          {updateLabel}
        </Button>
      </UpdateDialogFooter>
    </UpdateDialogShell>
  )
}

/** "User scope · owner/repo · 1a2b3c4" under the title. */
function SkillMeta({ skill, scopeName, preview }: { skill: SkillSummary; scopeName: string; preview?: UpdatePreview }) {
  const source = preview?.source ?? skill.source?.source
  const href = source ? sourceHref(source, skill.source?.sourceUrl) : null
  const ref = shortRef(preview?.remoteRef ?? null)
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{skill.scope === "user" ? "User scope" : `Project ${scopeName}`}</span>
      {source && (
        <>
          <span aria-hidden>·</span>
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="font-mono break-all">
              {source}
            </a>
          ) : (
            <span className="font-mono break-all">{source}</span>
          )}
        </>
      )}
      {ref && (
        <>
          <span aria-hidden>·</span>
          <span className="font-mono" title={`Upstream version ${preview?.remoteRef}`}>
            {ref}
          </span>
        </>
      )}
    </span>
  )
}

/** Summary, the overwrite warning, and the per-file diffs behind "Show changes". */
export function PreviewDetails({ preview }: { preview: UpdatePreview }) {
  const [open, setOpen] = useState(false)
  const count = preview.files.length
  return (
    <>
      <PreviewSummary preview={preview} />
      {overwritesFiles(preview) && <OverwriteWarning detail={OVERWRITE_DETAIL} />}
      <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <CollapsibleTrigger
            onPointerEnter={preloadDiffView}
            onFocus={preloadDiffView}
            render={
              <Button
                variant="ghost"
                size="sm"
                className="group/changes -ml-2 pointer-coarse:h-11"
              />
            }
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="transition-transform duration-150 group-data-panel-open/changes:rotate-90 motion-reduce:transition-none"
            />
            {open ? "Hide changes" : "Show changes"}
            <span className="text-muted-foreground">({plural(count, "file")})</span>
          </CollapsibleTrigger>
          <div className={cn("ml-auto", !open && "hidden")}>
            <DiffLayoutToggle />
          </div>
        </div>
        <CollapsibleContent>
          <FileChangeList files={preview.files} />
        </CollapsibleContent>
      </Collapsible>
    </>
  )
}
