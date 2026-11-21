import { lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import type { ScopeKey, UpdatePreview } from "../../shared/api.ts"
import { readGlobalLock, readProjectLock } from "../discovery/locks.ts"
import type { IndexedSkill } from "../discovery/skill-index.ts"
import { HttpError, badRequest } from "../lib/errors.ts"
import { isInside } from "../lib/files.ts"
import { parseFrontmatter, stringField } from "../lib/frontmatter.ts"
import { fetchDownload, fetchWellKnown, safeSourceFile } from "./cli-sources.ts"
import { MAX_DIFF_BYTES, diffFolders } from "./folder-diff.ts"
import { GitSource, type GitSourceOptions, type Limiter } from "./git-source.ts"
import { openRegularFile, previewTooLarge, readPrefix } from "./limits.ts"
import {
  cacheKey,
  planUpdate,
  type PreviewPlan,
  type SourceSpec,
} from "./plan.ts"
import {
  SourceCache,
  type Checkout,
  type DiscoveredSkill,
  type Fetcher,
  type SkillMdRef,
  type SourceCacheOptions,
} from "./source-cache.ts"

export interface PreviewOptions extends SourceCacheOptions {
  /** disk quota per fetched Git source */
  maxSourceBytes?: number
}

/**
 * GET /api/skills/:id/update-preview. Fetches what `skills update` would
 * install (cached per source) and diffs it against the folder on disk.
 */
export class UpdatePreviewService {
  private readonly cache: SourceCache
  /** `${scope}\n${lock name}` -> cache key of the source it was previewed from */
  private readonly used = new Map<string, string>()

  constructor(
    options: PreviewOptions,
    fetcher?: Fetcher,
    token: string | null = null
  ) {
    // Follow-up fetches (sparse checkouts) share the fetch slots and timeout.
    const limiter: Limiter = (fn) =>
      this.cache.limit(() => fn(AbortSignal.timeout(options.timeoutMs)))
    this.cache = new SourceCache(
      fetcher ??
        defaultFetcher(token, limiter, {
          maxSourceBytes: options.maxSourceBytes,
        }),
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
      const overrides = renameOverride(upstream.skillMd, plan.renameTo)
      const diff = await diffFolders(skill.realPath, upstream.dir, overrides)
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

/** The upstream skill folder, materialized, and its SKILL.md text. */
export interface UpstreamSkill {
  dir: string
  skillMd: string
}

/**
 * The skill folder `skills update` would copy from, materialized, with its
 * SKILL.md read safely. See findSkill for how the folder is picked.
 */
export async function locateSkill(
  checkout: Checkout,
  plan: PreviewPlan
): Promise<UpstreamSkill> {
  const ref = await findSkill(checkout, plan)
  const dir = await checkout.folder(folderOf(ref.path))
  const skillMd = await readUpstreamSkillMd(checkout.root, dir)
  if (ref.name === undefined) checkSkillName(skillMd, plan.sourceName)
  return { dir, skillMd }
}

/**
 * Mirrors how skills 1.9.0 picks the folder (cli.mjs):
 * - git: the locked skillPath while it exists (for full-depth sources only
 *   when no other skill has the name), else resolveSkillLocations over
 *   discoverSkills(clone, { fullDepth, includeDuplicateNames }): one skill
 *   whose frontmatter name matches, or 409 when there are none or several.
 * - download: findDownloadedSkill: the exact name, the locked path first.
 * - well-known: the skill with that name in the index.
 */
async function findSkill(
  checkout: Checkout,
  plan: PreviewPlan
): Promise<SkillMdRef> {
  if (plan.spec.kind === "download") {
    const named = (await checkout.discover()).filter(
      (s) => s.name === plan.sourceName
    )
    const found = named.find((s) => s.path === plan.skillPath) ?? named[0]
    if (!found) throw notUpstream(plan)
    return found
  }
  if (plan.spec.kind === "well-known") {
    const wanted = normalizeName(plan.sourceName)
    const found = (await checkout.discover()).filter(
      (s) => normalizeName(s.name) === wanted
    )
    if (found.length > 1) throw ambiguous(plan)
    if (!found[0]) throw notUpstream(plan)
    return found[0]
  }
  const mds = await checkout.listSkillMds()
  const locked = plan.skillPath
    ? mds.find((m) => m.path === plan.skillPath)
    : undefined
  if (locked && !plan.fullDepth) return locked
  return resolveByName(await checkout.discover(), plan)
}

/** resolveSkillLocations in the CLI, for one locked skill. */
function resolveByName(
  discovered: DiscoveredSkill[],
  plan: PreviewPlan
): SkillMdRef {
  const wanted = normalizeName(plan.sourceName)
  const candidates = [
    ...new Set(
      discovered
        .filter((s) => normalizeName(s.name) === wanted)
        .map((s) => s.path)
    ),
  ]
  const lockedFound =
    !!plan.skillPath && discovered.some((s) => s.path === plan.skillPath)
  // The locked path, without a name: it is checked against the lock on read.
  const locked = { path: plan.skillPath as string }
  if (lockedFound && !plan.fullDepth) return locked
  if (candidates.length > 1) throw ambiguous(plan)
  if (lockedFound) return locked
  if (candidates.length === 1)
    return { path: candidates[0], name: plan.sourceName }
  throw notUpstream(plan)
}

function notUpstream(plan: PreviewPlan): HttpError {
  return new HttpError(
    409,
    "not_upstream",
    `${plan.sourceName} is no longer in the source (deleted or moved upstream); skills update would skip it`
  )
}

function ambiguous(plan: PreviewPlan): HttpError {
  return new HttpError(
    409,
    "ambiguous_upstream",
    `Several skills named ${plan.sourceName} are in the source; skills update would skip it`
  )
}

/**
 * The upstream SKILL.md, read only when it is safe: the skill folder resolves
 * inside the source, SKILL.md resolves to a regular file inside the skill
 * folder (a link is followed only within it, as the CLI's copy does), and it
 * is at most 256 KB. Opened without following links and without blocking.
 * Errors never quote the file.
 */
export async function readUpstreamSkillMd(
  sourceRoot: string,
  skillDir: string
): Promise<string> {
  const realRoot = await realpath(sourceRoot)
  const realDir = await realpath(skillDir).catch(() => null)
  if (!realDir || !isInside(realRoot, realDir))
    throw unsafeUpstream("The upstream skill folder is outside the source")
  const real = await safeSourceFile(realDir, join(realDir, "SKILL.md"))
  if (!real) {
    const exists = await lstat(join(realDir, "SKILL.md")).catch(() => null)
    if (!exists)
      throw new HttpError(
        409,
        "not_upstream",
        "The source has no SKILL.md for this skill"
      )
    throw unsafeUpstream(
      "The upstream SKILL.md is not a regular file in the skill folder"
    )
  }
  const handle = await openRegularFile(real).catch(() => null)
  if (!handle)
    throw unsafeUpstream("The upstream SKILL.md is not a regular file")
  try {
    const { bytes, truncated } = await readPrefix(handle, MAX_DIFF_BYTES)
    if (truncated)
      throw previewTooLarge("the upstream SKILL.md is larger than 256 KB")
    return new TextDecoder().decode(bytes)
  } finally {
    await handle.close()
  }
}

function unsafeUpstream(detail: string): HttpError {
  return new HttpError(409, "unsafe_upstream", detail)
}

/** The CLI selects by the frontmatter name; a rename upstream makes update fail. */
function checkSkillName(text: string, wanted: string): void {
  const name = stringField(parseFrontmatter(text).data, "name")
  if (name && normalizeName(name) !== normalizeName(wanted))
    throw new HttpError(
      409,
      "renamed_upstream",
      `The skill is now named ${printable(name)} upstream; skills update looks for ${wanted} and would fail`
    )
}

/** A name from upstream, safe to show: no control characters, short. */
function printable(name: string): string {
  const clean = [...name]
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code >= 0x20 && (code < 0x7f || code > 0x9f)
    })
    .join("")
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean
}

/** When installed under another name, the CLI rewrites the SKILL.md `name`. */
function renameOverride(
  skillMd: string,
  renameTo: string | null
): Map<string, Uint8Array> {
  if (!renameTo) return new Map()
  return new Map([
    [
      "SKILL.md",
      new TextEncoder().encode(setFrontmatterName(skillMd, renameTo)),
    ],
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

function defaultFetcher(
  token: string | null,
  limiter: Limiter,
  options: GitSourceOptions
): Fetcher {
  const git = new GitSource(token, options)
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
