import { toast } from "sonner"
import type { OpenResult } from "@shared/api"
import { HttpError, api, errorMessage } from "@/lib/api"
import { getPlace, navigate } from "@/lib/hash-state"
import type { LinkTarget } from "@/lib/path-links"
import { setPendingLine } from "@/lib/pending-line"
import { ui } from "@/lib/ui-store"

/**
 * A document's address for GET /api/open `from` (relative paths start at its folder),
 * and the key of a line to jump to when its editor mounts.
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
  // Both moves go through the unsaved-changes guard in navigate().
  if (result.kind === "skill-file") {
    const current = getPlace().scope
    const scope = result.scopes.includes(current) ? current : result.scope
    setPendingLine(docAddress.skillFile(result.skillId, result.file), result.line)
    navigate({ tab: "skills", scope, skill: result.skillId, file: result.file })
  } else {
    setPendingLine(docAddress.instruction(result.id), result.line)
    navigate({ tab: "instructions", scope: result.scope, doc: result.id })
  }
}
