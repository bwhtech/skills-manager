import type { MiddlewareHandler } from "hono"
import { MUTATION_HEADER } from "../../shared/api.ts"

const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"])

/**
 * Blocks CSRF: mutating requests need the custom header (which a cross-site
 * form cannot send without a CORS preflight) and a same-origin Origin.
 */
export const mutationGuard: MiddlewareHandler = async (c, next) => {
  if (!MUTATING.has(c.req.method)) return next()
  const reason = rejectReason(c.req.raw.headers)
  if (reason) return c.json({ error: "forbidden", detail: reason }, 403)
  return next()
}

export function rejectReason(headers: Headers): string | null {
  if (headers.get(MUTATION_HEADER) !== "1")
    return `Missing ${MUTATION_HEADER}: 1 header`
  const origin = headers.get("origin")
  if (origin === null) return null
  const originHost = hostOf(origin)
  // A local reverse proxy (Tailscale Serve) may rewrite Host; it then sets X-Forwarded-Host.
  const hosts = [headers.get("host"), headers.get("x-forwarded-host")]
    .filter(Boolean)
    .map((h) => h!.toLowerCase())
  if (!originHost || !hosts.includes(originHost))
    return "Origin does not match Host"
  return null
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}
