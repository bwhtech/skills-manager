import { isAbsolute, normalize } from "node:path"
import type { ScopeKey } from "../../shared/api.ts"
import { decodeId } from "../../shared/api.ts"
import { badRequest, notFound } from "./errors.ts"

// CLI arguments come from the browser. These patterns keep them from being
// read as flags (no leading "-") and keep odd characters out.
const SKILL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:+@-]{0,127}$/
const AGENT_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const SHORTHAND_SOURCE =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:@[A-Za-z0-9_.:+-]+)?$/
const URL_SOURCE =
  /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9_.~%@:+-]+)*\/?(?:#[A-Za-z0-9_./-]+)?$/

export function isSkillName(value: unknown): value is string {
  return typeof value === "string" && SKILL_NAME.test(value)
}

export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value)
}

export function isSource(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300) return false
  if (value.includes("..")) return false
  return SHORTHAND_SOURCE.test(value) || URL_SOURCE.test(value)
}

export function requireSource(value: unknown): string {
  if (!isSource(value))
    throw badRequest(
      "source must be owner/repo, owner/repo@skill or an https URL"
    )
  return value
}

export function requireSkillNames(value: unknown, field = "skills"): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw badRequest(`${field} must be a non-empty array`)
  if (!value.every(isSkillName))
    throw badRequest(`${field} has an invalid name`)
  return [...new Set(value)]
}

/** Agent ids must be well-formed and known to the CLI. */
export function requireAgents(
  value: unknown,
  known: (id: string) => boolean
): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw badRequest("agents must be a non-empty array")
  for (const id of value) {
    if (!isAgentId(id) || !known(id))
      throw badRequest(`Unknown agent: ${String(id)}`)
  }
  return [...new Set(value as string[])]
}

/** Scope must be "user" or the path of a project the server knows. */
export function requireScope(
  value: unknown,
  isKnownProject: (path: string) => boolean
): ScopeKey {
  if (value === "user") return "user"
  if (
    typeof value === "string" &&
    isAbsolute(value) &&
    isKnownProject(normalize(value))
  )
    return normalize(value)
  throw badRequest('scope must be "user" or a known project path')
}

/** Decode an ID into an absolute normalized path, or 404. */
export function decodePathId(id: string): string {
  let path: string
  try {
    path = decodeId(id)
  } catch {
    throw notFound("Invalid id")
  }
  if (!isAbsolute(path) || path.includes("\0") || normalize(path) !== path)
    throw notFound("Invalid id")
  return path
}

/** A relative file path inside a folder: posix, no "..", no absolute paths. */
export function requireRelativePath(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.includes("\0"))
    throw badRequest("path is required")
  if (isAbsolute(value) || value.includes("\\"))
    throw badRequest("path must be relative")
  const parts = value.split("/")
  if (parts.some((p) => p === ".." || p === "." || p === ""))
    throw badRequest("path must not contain . or ..")
  return value
}
