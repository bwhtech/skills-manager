import type { ApiError } from "@shared/api"

// Errors from the API client and how a save reads them. No runtime imports, so bun test
// can load it without the @shared path alias.

/** A non-2xx response, with the parsed ApiError body. */
export class HttpError extends Error {
  readonly status: number
  readonly body: ApiError & Record<string, unknown>

  constructor(status: number, body: ApiError & Record<string, unknown>) {
    super(body.detail ? `${body.error}: ${body.detail}` : body.error)
    this.name = "HttpError"
    this.status = status
    this.body = body
  }
}

/**
 * A save's content conflict (409 SaveConflict): the file changed on disk. The only error that
 * may open the conflict dialog, whose Overwrite sends a forced save. Other 409s (moved,
 * now_linked, exists, ...) are not: a forced save there could write into another file.
 */
export function isConflict(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 409 && error.body.error === "conflict"
}

/**
 * A save refused because the path now leads to another file (409 moved, from PUT /api/file
 * and the skill file saves, or 409 now_linked, from an instruction save). `target` is the
 * new path when the server named it. Null for any other error.
 */
export function relocation(error: unknown): { target?: string } | null {
  if (!(error instanceof HttpError) || error.status !== 409) return null
  const { error: code, currentPath, linkTarget } = error.body
  if (code !== "moved" && code !== "now_linked") return null
  const target = code === "moved" ? currentPath : linkTarget
  return typeof target === "string" && target ? { target } : {}
}
