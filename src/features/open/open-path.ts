import { toast } from "sonner"
import type { OpenResult, ScopeKey } from "@shared/api"
import { HttpError, api, errorMessage } from "@/lib/api"
import { getPlace, navigate, type Place } from "@/lib/hash-state"
import type { LinkTarget } from "@/lib/path-links"
import { hasLineEditor, requestLine } from "@/lib/pending-line"
import { ui } from "@/lib/ui-store"

/**
 * A document's address for GET /api/open `from` (relative paths start at its folder),
 * and the key of its editor's line requests (lib/pending-line).
 */
export const docAddress = {
  skillFile: (skillId: string, file: string) => `${skillId}:${file}`,
  instruction: (id: string) => id,
}

/** Open a link from the document at `from` (a docAddress, or a viewed file's absolute path). */
export function openLink(link: LinkTarget, from: string) {
  if (link.kind === "url") {
    window.open(link.target, "_blank", "noopener,noreferrer")
    return
  }
  void openPath(link.target, from)
}

async function openPath(raw: string, from: string) {
  let result: OpenResult
  try {
    result = await api.open(raw, from)
  } catch (error) {
    const reason = error instanceof HttpError ? (error.body.detail ?? error.body.error) : errorMessage(error)
    toast.error(`Could not open ${raw}`, { description: reason })
    return
  }
  if (result.kind === "file") {
    ui.viewFile({ path: result.path, line: result.line })
    return
  }
  ui.closeFile()
  const { key, place } = destination(result)
  // The document is open already (also SKILL.md at file=null): show the line, no move.
  if (hasLineEditor(key)) return requestLine(key, result.line)
  // The move goes through the unsaved-changes guard; the line is requested only once it is accepted.
  navigate(place, { onAccept: () => requestLine(key, result.line) })
}

/** Where a skill file or instruction file opens: its line-request key and its place. */
function destination(result: Exclude<OpenResult, { kind: "file" }>): { key: string; place: Partial<Place> } {
  if (result.kind === "instruction")
    return {
      key: docAddress.instruction(result.id),
      place: { tab: "instructions", scope: result.scope, doc: result.id },
    }
  return {
    key: docAddress.skillFile(result.skillId, result.file),
    place: { tab: "skills", scope: skillScope(result.scope, result.scopes), skill: result.skillId, file: result.file },
  }
}

/** Stay in the shown scope when the skill is listed there. */
function skillScope(scope: ScopeKey, scopes: ScopeKey[]): ScopeKey {
  const current = getPlace().scope
  return scopes.includes(current) ? current : scope
}
