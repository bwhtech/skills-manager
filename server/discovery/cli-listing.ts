import type { SkillsCli } from "../cli/skills-cli.ts"
import { realpathOrNull } from "../lib/files.ts"

export interface CliListed {
  name: string
  agents: string[] // display labels, as the CLI prints them
  tracked: boolean
  source: string | null
  sourceUrl: string | null
  sourceType: string | null
}

const LS_TIMEOUT_MS = 15_000

/**
 * `skills ls --json` for one scope, keyed by real path. Best effort: an
 * empty map on any failure, since discovery does not depend on it.
 */
export async function cliListing(
  cli: SkillsCli,
  cwd: string,
  global: boolean
): Promise<Map<string, CliListed>> {
  const map = new Map<string, CliListed>()
  const args = global ? ["ls", "-g", "--json"] : ["ls", "--json"]
  const result = await cli.capture(args, cwd, LS_TIMEOUT_MS).catch(() => null)
  if (!result || result.exitCode !== 0) return map
  let rows: unknown
  try {
    rows = JSON.parse(result.output.slice(result.output.indexOf("[")))
  } catch {
    return map
  }
  if (!Array.isArray(rows)) return map
  await Promise.all(
    rows.map(async (row: Record<string, unknown>) => {
      if (typeof row.path !== "string" || typeof row.name !== "string") return
      const real = await realpathOrNull(row.path)
      if (!real) return
      map.set(real, {
        name: row.name,
        agents: Array.isArray(row.agents)
          ? row.agents.filter((a): a is string => typeof a === "string")
          : [],
        tracked: row.status !== "untracked",
        source: typeof row.source === "string" ? row.source : null,
        sourceUrl: typeof row.sourceUrl === "string" ? row.sourceUrl : null,
        sourceType: typeof row.sourceType === "string" ? row.sourceType : null,
      })
    })
  )
  return map
}
