import type { RepoSkill, SearchResult } from "../shared/api.ts"
import { parseRepoListOutput } from "./cli/parsers.ts"
import type { SkillsCli } from "./cli/skills-cli.ts"
import { config } from "./config.ts"
import { HttpError } from "./lib/errors.ts"

const SEARCH_API = "https://skills.sh/api/search"
const SEARCH_TIMEOUT_MS = 10_000
const LIST_TIMEOUT_MS = 90_000

interface ApiSkill {
  id?: string
  source?: string
  skillId?: string
  name?: string
  installs?: number
}

/** skills.sh search and repo listing. Neither changes anything on disk. */
export class Catalog {
  constructor(private readonly cli: SkillsCli) {}

  async search(query: string): Promise<SearchResult[]> {
    const q = query.trim().slice(0, 200)
    if (!q) return []
    let res: Response
    try {
      res = await fetch(`${SEARCH_API}?${new URLSearchParams({ q })}`, {
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      })
    } catch (err) {
      throw new HttpError(502, "search_failed", (err as Error).message)
    }
    if (!res.ok)
      throw new HttpError(
        502,
        "search_failed",
        `skills.sh answered ${res.status}`
      )
    const body = (await res.json()) as { skills?: ApiSkill[] }
    return (body.skills ?? [])
      .filter((s) => s.source && (s.name || s.skillId))
      .map(toResult)
  }

  async repoSkills(source: string): Promise<RepoSkill[]> {
    const res = await this.cli.capture(
      ["add", source, "--list"],
      config.home,
      LIST_TIMEOUT_MS
    )
    if (res.timedOut)
      throw new HttpError(
        504,
        "timeout",
        "Listing the repository took too long"
      )
    const skills = parseRepoListOutput(res.output)
    if (res.exitCode !== 0 && skills.length === 0)
      throw new HttpError(502, "list_failed", lastLines(res.output))
    return skills
  }
}

function toResult(s: ApiSkill): SearchResult {
  const source = s.source!
  const skill = s.name || s.skillId!
  return {
    id: `${source}@${skill}`,
    source,
    skill,
    installs: typeof s.installs === "number" ? s.installs : 0,
    url: `https://skills.sh/${source}/${s.skillId || skill}`,
  }
}

function lastLines(output: string): string {
  return output
    .split("\n")
    .filter((l) => l.trim())
    .slice(-5)
    .join("\n")
}
