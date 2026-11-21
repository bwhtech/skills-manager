import type { Context, MiddlewareHandler } from "hono"
import { MUTATION_HEADER } from "../../shared/api.ts"

const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"])
/** Host names that are always allowed: a rebinding attack cannot make the browser send them. */
const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"]

/**
 * Blocks DNS rebinding and cross-site reads on every request: the host the
 * browser asked for must be on the allowlist (any port), and a browser
 * request must not come from another site (Sec-Fetch-Site: cross-site).
 * `allowed` adds names to the loopback ones (config.allowedHosts).
 */
export function hostGuard(allowed: readonly string[]): MiddlewareHandler {
  const names = new Set([...LOOPBACK_NAMES, ...allowed].map((h) => h.toLowerCase()))
  return async (c, next) => {
    const bad = requestHosts(c).find((h) => !names.has(hostnameOf(h) ?? ""))
    if (bad !== undefined) return c.json({ error: "bad_host", detail: `Host not allowed: ${bad}` }, 403)
    if (c.req.header("sec-fetch-site") === "cross-site")
      return c.json({ error: "forbidden", detail: "Cross-site request" }, 403)
    return next()
  }
}

/**
 * Blocks CSRF: mutating requests need the custom header (which a cross-site
 * form cannot send without a CORS preflight) and a same-origin Origin.
 */
export const mutationGuard: MiddlewareHandler = async (c, next) => {
  if (!MUTATING.has(c.req.method)) return next()
  const reason = rejectReason(c.req.raw.headers, requestHosts(c))
  if (reason) return c.json({ error: "forbidden", detail: reason }, 403)
  return next()
}

/** Why a mutating request is refused, or null. `hosts` are the request's host values. */
export function rejectReason(headers: Headers, hosts: readonly string[]): string | null {
  if (headers.get(MUTATION_HEADER) !== "1")
    return `Missing ${MUTATION_HEADER}: 1 header`
  const origin = headers.get("origin")
  if (origin === null) return null
  const originHost = hostOf(origin)
  if (!originHost || !hosts.includes(originHost))
    return "Origin does not match Host"
  return null
}

/**
 * The host values of a request, lowercase: Host (or the URL's host when the
 * header is missing), plus X-Forwarded-Host when a local proxy sent it.
 * Tailscale Serve connects from loopback, keeps Host and sets X-Forwarded-Host
 * to the same name. A remote peer's X-Forwarded-Host is ignored.
 */
export function requestHosts(c: Context): string[] {
  const hosts = [c.req.header("host") || new URL(c.req.url).host]
  const forwarded = c.req.header("x-forwarded-host")
  if (forwarded && isLoopback(peerAddress(c))) hosts.push(...forwarded.split(","))
  return hosts.map((h) => h.trim().toLowerCase())
}

/** The TCP peer from Bun's server (the env of app.fetch), or null when unknown (tests). */
function peerAddress(c: Context): string | null {
  const env = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined
  if (typeof env?.requestIP !== "function") return null
  return env.requestIP(c.req.raw)?.address ?? null
}

function isLoopback(address: string | null): boolean {
  if (!address) return false
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.")
}

/** "name:port" or "[v6]:port" to its hostname ("[v6]" keeps its brackets), or null. */
function hostnameOf(host: string): string | null {
  if (!host || /[\s/@?#\\]/.test(host)) return null
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}
