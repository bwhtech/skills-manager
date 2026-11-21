import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, Link01Icon } from "@hugeicons/core-free-icons"
import type { InstructionFile, InstructionLinkRef, ScopeKey } from "@shared/api"
import { navigate } from "@/lib/hash-state"
import { tildify } from "@/lib/format"
import { cn } from "@/lib/utils"

/** A short name for another file: its name when it sits next to `from`, else its ~ path. */
export function shortPath(path: string, from: string, home: string | undefined) {
  const dir = (p: string) => p.slice(0, p.lastIndexOf("/"))
  return dir(path) === dir(from) ? path.slice(path.lastIndexOf("/") + 1) : tildify(path, home)
}

/** "CLAUDE.md (Claude Code)" */
export function refLabel(ref: InstructionLinkRef, from: string, home: string | undefined) {
  return `${shortPath(ref.path, from, home)} (${ref.agentLabel})`
}

/**
 * Open a file in the editor. A link opens the real file it points at, in its
 * own scope: an editor never opens on the link path. Goes through the
 * unsaved-changes guard like every move.
 */
export function openInstruction(file: InstructionFile, options: { replace?: boolean } = {}) {
  const target: { id: string; scope: ScopeKey } = file.linkTargetFile ?? file
  navigate({ scope: target.scope, doc: target.id }, options)
}

/** Second line of a link's row: where it points, or that it is broken. */
export function LinkLine({ file, home, className }: { file: InstructionFile; home: string | undefined; className?: string }) {
  if (!file.linkTarget) return null
  if (file.linkBroken) {
    return (
      <span className={cn("flex min-w-0 items-start gap-1 text-xs text-amber-700 dark:text-amber-300", className)}>
        <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="mt-px size-3.5 shrink-0" />
        <span className="line-clamp-2 [overflow-wrap:anywhere]" title={file.linkTarget}>
          Broken link → {shortPath(file.linkTarget, file.path, home)}
        </span>
      </span>
    )
  }
  const label = file.linkTargetFile
    ? refLabel(file.linkTargetFile, file.path, home)
    : shortPath(file.linkTarget, file.path, home)
  return (
    <span className={cn("flex min-w-0 items-start gap-1 text-xs text-muted-foreground", className)}>
      <HugeiconsIcon icon={Link01Icon} strokeWidth={2} className="mt-px size-3.5 shrink-0" />
      <span className="line-clamp-2 [overflow-wrap:anywhere]" title={`${file.path} → ${file.linkTarget}`}>
        Synced → {label}
      </span>
    </span>
  )
}

/** "Also read as: ~/.codex/AGENTS.md (Codex)" for a file other files link to. */
export function alsoReadAs(file: InstructionFile, home: string | undefined) {
  const refs = file.linkedFrom ?? []
  if (refs.length === 0) return null
  return `Also read as: ${refs.map((ref) => refLabel(ref, file.path, home)).join(", ")}`
}

export function AlsoReadAsLine({ file, home, className }: { file: InstructionFile; home: string | undefined; className?: string }) {
  const text = alsoReadAs(file, home)
  if (!text) return null
  return (
    <span className={cn("flex min-w-0 items-start gap-1 text-xs text-muted-foreground", className)}>
      <HugeiconsIcon icon={Link01Icon} strokeWidth={2} className="mt-px size-3.5 shrink-0" />
      <span className="line-clamp-2 [overflow-wrap:anywhere]" title={(file.linkedFrom ?? []).map((ref) => ref.path).join("\n")}>
        {text}
      </span>
    </span>
  )
}
