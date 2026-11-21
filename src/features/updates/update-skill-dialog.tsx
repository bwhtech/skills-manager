import { useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon, CircleArrowUp02Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { SkillSummary, UpdatePreview } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { api, errorMessage, previewFailure, useJobMutation, useScopes, useUpdatePreview } from "@/lib/api"
import { plural, scopeLabel } from "@/lib/format"
import { cn } from "@/lib/utils"
import { showJob } from "@/features/jobs/job-store"
import { DiffLayoutToggle, FileChangeList, preloadDiffView } from "./file-changes"
import { OVERWRITE_DETAIL } from "./copy"
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

/** Confirm a single-skill update, with a preview of what `skills update` would change. */
export function UpdateSkillDialog({ skill, open, onOpenChange }: UpdateSkillDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const projects = useScopes().data?.projects
  const preview = useUpdatePreview(skill.id, open)
  const update = useJobMutation(api.runUpdate)

  const data = preview.data
  const failure = preview.isError ? previewFailure(preview.error) : null
  const scopeName = scopeLabel(skill.scope, projects)

  const confirm = () =>
    update.mutate(
      { scope: skill.scope, names: [skill.name] },
      {
        onSuccess: ({ jobId }) => {
          onOpenChange(false)
          showJob(jobId, { previewIds: [skill.id] })
        },
        onError: (error) => toast.error(`Could not update ${skill.name}`, { description: errorMessage(error) }),
      }
    )

  const confirmLabel =
    failure && !failure.blocking ? "Update without preview" : data?.upToDate ? "Update anyway" : "Update"

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
      </UpdateDialogBody>
      <UpdateDialogFooter>
        {failure?.blocking && (
          <p className="mr-auto min-w-0 text-xs text-destructive max-md:col-span-2">Update is off for this skill.</p>
        )}
        <Button ref={cancelRef} variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant={data?.upToDate || (failure && !failure.blocking) ? "secondary" : "default"}
          disabled={preview.isPending || !!failure?.blocking || update.isPending}
          onClick={confirm}
        >
          {update.isPending ? <Spinner /> : <HugeiconsIcon icon={CircleArrowUp02Icon} strokeWidth={2} />}
          {confirmLabel}
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
