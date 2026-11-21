import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type { ScopeKey, UpdatePreview } from "../../shared/api.ts"
import { readGlobalLock, readProjectLock } from "../discovery/locks.ts"
import type { IndexedSkill } from "../discovery/skill-index.ts"
import { HttpError, badRequest } from "../lib/errors.ts"
import { parseFrontmatter, stringField } from "../lib/frontmatter.ts"
import { fetchDownload, fetchWellKnown } from "./cli-sources.ts"
import { diffFolders } from "./folder-diff.ts"
import { GitSource, type Limiter } from "./git-source.ts"
import {
  cacheKey,
  planUpdate,
  type PreviewPlan,
  type SourceSpec,
} from "./plan.ts"
import {
  SourceCache,
  type Checkout,
  type Fetcher,
  type SourceCacheOptions,
} from "./source-cache.ts"

/**
 * GET /api/skills/:id/update-preview. Fetches what `skills update` would
 * install (cached per source) and diffs it against the folder on disk.
 */
export class UpdatePreviewService {
  private readonly cache: SourceCache
  /** `${scope}\n${lock name}` -> cache key of the source it was previewed from */
  private readonly used = new Map<string, string>()

  constructor(
    options: SourceCacheOptions,
    fetcher?: Fetcher,
    token: string | null = null
  ) {
    // Follow-up fetches (sparse checkouts) share the fetch slots and timeout.
    const limiter: Limiter = (fn) =>
      this.cache.limit(() => fn(AbortSignal.timeout(options.timeoutMs)))
    this.cache = new SourceCache(
      fetcher ?? defaultFetcher(token, limiter),
      options
    )
  }

  init(): Promise<void> {
    return this.cache.init()
  }

  async preview(skill: IndexedSkill): Promise<UpdatePreview> {
    if (skill.origin !== "npx")
      throw badRequest(
        "Update previews are only for skills installed with the skills CLI"
      )
    const { plan, source } = await this.planFor(skill)
    const lease = await this.cache.acquire(plan.spec)
    this.used.set(usedKey(skill.scope, skill.cliName), cacheKey(plan.spec))
    try {
      const upstream = await locateSkill(lease.checkout, plan)
      const overrides = await renameOverride(upstream, plan.renameTo)
      const diff = await diffFolders(skill.realPath, upstream, overrides)
      return {
        skillId: skill.id,
        name: skill.name,
        scope: skill.scope,
        source,
        remoteRef: lease.checkout.ref,
        ...diff,
        fetchedAt: lease.fetchedAt,
      }
    } finally {
      lease.release()
    }
  }

  /** After an update job: drop the sources those skills were previewed from. */
  invalidate(scope: ScopeKey, names: string[]): void {
    const prefix = usedKey(scope, "")
    for (const [key, sourceKey] of [...this.used]) {
      if (!key.startsWith(prefix)) continue
      const name = key.slice(prefix.length).toLowerCase()
      if (names.length && !names.some((n) => n.toLowerCase() === name)) continue
      this.cache.invalidate(sourceKey)
      this.used.delete(key)
    }
  }

  private async planFor(
    skill: IndexedSkill
  ): Promise<{ plan: PreviewPlan; source: string }> {
    const global = skill.scope === "user"
    const lock = global
      ? await readGlobalLock()
      : await readProjectLock(skill.scope)
    const entry = lock.skills.get(skill.cliName)
    if (!entry)
      throw badRequest(
        `${skill.cliName} has no entry in the ${global ? "global" : "project"} lock file`
      )
    return {
      plan: planUpdate(entry, skill.cliName, global),
      source: entry.source,
    }
  }
}

/**
 * The skill folder `skills update` would copy from, materialized. Like the
 * CLI: the locked skillPath first, else the one skill with that name.
 */
export async function locateSkill(
  checkout: Checkout,
  plan: PreviewPlan
): Promise<string> {
  const mds = await checkout.listSkillMds()
  const locked = plan.skillPath && mds.find((m) => m.path === plan.skillPath)
  const wanted = normalizeName(plan.sourceName)
  const found = locked
    ? [locked]
    : mds.filter(
        (m) => normalizeName(m.name ?? basename(folderOf(m.path))) === wanted
      )
  if (found.length === 0)
    throw new HttpError(
      409,
      "not_upstream",
      `${plan.sourceName} is no longer in the source (deleted or moved upstream); skills update would skip it`
    )
  if (found.length > 1)
    throw new HttpError(
      409,
      "ambiguous_upstream",
      `Several skills named ${plan.sourceName} are in the source; skills update would skip it`
    )
  const ref = found[0]
  const dir = await checkout.folder(folderOf(ref.path))
  if (ref.name === undefined)
    await checkSkillName(join(dir, "SKILL.md"), plan.sourceName)
  return dir
}

/** The CLI selects by the frontmatter name; a rename upstream makes update fail. */
async function checkSkillName(skillMd: string, wanted: string): Promise<void> {
  const text = await readFile(skillMd, "utf8").catch(() => null)
  if (text === null)
    throw new HttpError(
      409,
      "not_upstream",
      `The source has no SKILL.md for ${wanted}`
    )
  const name = stringField(parseFrontmatter(text).data, "name")
  if (name && normalizeName(name) !== normalizeName(wanted))
    throw new HttpError(
      409,
      "renamed_upstream",
      `The skill is now named ${name} upstream; skills update looks for ${wanted} and would fail`
    )
}

/** When installed under another name, the CLI rewrites the SKILL.md `name`. */
async function renameOverride(
  dir: string,
  renameTo: string | null
): Promise<Map<string, Uint8Array>> {
  if (!renameTo) return new Map()
  const raw = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => null)
  if (raw === null) return new Map()
  return new Map([
    ["SKILL.md", new TextEncoder().encode(setFrontmatterName(raw, renameTo))],
  ])
}

/** Port of setFrontmatterName in skills 1.9.0. */
export function setFrontmatterName(raw: string, name: string): string {
  const match = raw.match(/^(\uFEFF?---(\r?\n))([\s\S]*?)(\r?\n---(?:\r?\n|$))/)
  if (!match) return raw
  const [whole, open, eol, body, close] = match
  const nameLine = `name: ${/^[a-z0-9][a-z0-9._-]*$/.test(name) && !/^[\d.]+$/.test(name) ? name : JSON.stringify(name)}`
  const lines = body.split(/\r?\n/)
  const index = lines.findIndex((line) => /^name\s*:/.test(line))
  if (index === -1) lines.unshift(nameLine)
  else {
    let end = index + 1
    while (end < lines.length && /^[ \t]/.test(lines[end])) end++
    lines.splice(index, end - index, nameLine)
  }
  return open + lines.join(eol) + close + raw.slice(whole.length)
}

function defaultFetcher(token: string | null, limiter: Limiter): Fetcher {
  const git = new GitSource(token)
  return (spec: SourceSpec, dir, signal) => {
    if (spec.kind === "git")
      return git.fetch(spec.url, spec.ref, dir, signal, limiter)
    if (spec.kind === "well-known") return fetchWellKnown(spec.url, dir, signal)
    return fetchDownload(spec.url, dir, signal)
  }
}

function folderOf(skillMdPath: string): string {
  return skillMdPath === "SKILL.md"
    ? ""
    : skillMdPath.slice(0, -"/SKILL.md".length)
}

/** normalizeSkillName in the CLI. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, "-")
}

function usedKey(scope: ScopeKey, name: string): string {
  return `${scope}\n${name}`
}
