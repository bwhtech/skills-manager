import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { ApiError } from "../../shared/api.ts"

/** Throw from a route to send an ApiError body with a status. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode
  readonly detail?: string
  readonly extra?: Record<string, unknown>

  constructor(
    status: ContentfulStatusCode,
    error: string,
    detail?: string,
    extra?: Record<string, unknown>
  ) {
    super(error)
    this.status = status
    this.detail = detail
    this.extra = extra
  }
}

export function badRequest(detail: string): HttpError {
  return new HttpError(400, "bad_request", detail)
}

export function notFound(detail = "Not found"): HttpError {
  return new HttpError(404, "not_found", detail)
}

export function forbidden(detail: string): HttpError {
  return new HttpError(403, "forbidden", detail)
}

export function handleError(err: Error, c: Context) {
  if (err instanceof HttpError) {
    const body: ApiError = {
      error: err.message,
      ...(err.detail ? { detail: err.detail } : {}),
      ...err.extra,
    }
    return c.json(body, err.status)
  }
  const code = (err as NodeJS.ErrnoException).code
  if (code === "ENOENT")
    return c.json(
      { error: "not_found", detail: "File not found" } satisfies ApiError,
      404
    )
  if (code === "EACCES" || code === "EPERM")
    return c.json(
      { error: "forbidden", detail: err.message } satisfies ApiError,
      403
    )
  console.error(err)
  const body: ApiError = { error: "internal", detail: err.message }
  return c.json(body, 500)
}

/** Parse a JSON body or fail with 400. */
export async function readJson<T>(c: Context): Promise<T> {
  try {
    const body = await c.req.json()
    if (body && typeof body === "object") return body as T
  } catch {
    // fall through
  }
  throw badRequest("Body must be a JSON object")
}
