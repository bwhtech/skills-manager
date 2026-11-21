import type { Dirent } from "node:fs"
import {
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { config } from "../config.ts"
import { HttpError } from "../lib/errors.ts"
import { isInside } from "../lib/files.ts"
import {
  PREVIEW_LIMITS,
  ReadBudget,
  dirSize,
  formatMb,
  openRegularFile,
  previewTooLarge,
  readPrefix,
} from "./limits.ts"
import type { Checkout, DiscoveredSkill, SkillMdRef } from "./source-cache.ts"

/** Options of the CLI's discoverSkills. */
export interface DiscoverOptions {
  fullDepth: boolean
  includeDuplicateNames?: boolean
  includeInternal?: boolean
}

/** The parts of the pinned skills CLI (1.9.0) used for non-Git sources. */
interface CliModule {
  wellKnownProvider: {
    fetchAllSkills(
      url: string,
      options?: { includeInternal?: boolean }
    ): Promise<
      { installName: string; files: Map<string, string | Uint8Array> }[]
    >
  }
  downloadSource(url: string): Promise<{ rootDir: string; tempDir: string }>
  discoverSkills(
    base: string,
    subpath: undefined,
    options: DiscoverOptions
  ): Promise<{ name: string; path: string }[]>
  sanitizeName(name: string): string
  withWarnings<T>(handler: (warning: unknown) => void, fn: () => T): T
}

let cliModule: Promise<CliModule> | null = null

/**
 * Well-known and download sources go through the CLI's own fetchers, so the
 * files are exactly what `skills update` would write. They fetch into memory
 * or the OS temp dir; the result is copied into `dir` and the rest deleted.
 */
export async function fetchWellKnown(
  url: string,
  dir: string,
  signal: AbortSignal
): Promise<Checkout> {
  const cli = await loadCli()
  const skills = await withSignal(
    cli.wellKnownProvider.fetchAllSkills(url, { includeInternal: true }),
    signal
  )
  const refs: DiscoveredSkill[] = []
  for (const skill of skills) {
    const folder = cli.sanitizeName(skill.installName)
    await writeSkillFiles(join(dir, folder), skill.files)
    refs.push({ path: `${folder}/SKILL.md`, name: skill.installName })
  }
  await checkSourceSize(dir)
  return new StaticCheckout(dir, refs)
}

export async function fetchDownload(
  url: string,
  dir: string,
  signal: AbortSignal
): Promise<Checkout> {
  const cli = await loadCli()
  const downloading = cli.downloadSource(url)
  // A late result after a timeout still has a temp dir to clean up.
  downloading
    .then(async (d) => {
      if (signal.aborted) await rm(d.tempDir, { recursive: true, force: true })
    })
    .catch(() => {})
  const downloaded = await withSignal(downloading, signal)
  const source = join(dir, "source")
  try {
    await cp(downloaded.rootDir, source, {
      recursive: true,
      verbatimSymlinks: true,
    })
  } finally {
    await rm(downloaded.tempDir, { recursive: true, force: true })
  }
  await checkSourceSize(dir)
  // resolveSkills for a download in update: full depth, internal skills
  // included (a skill is asked for by name), duplicate names dropped.
  const mds = await findSkillMds(source)
  const found = await discoverInView(source, mds, join(dir, "discover"), {
    fullDepth: true,
    includeInternal: true,
  })
  return new StaticCheckout(source, found)
}

/** fetch, as the strict index check uses it (a test seam). */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>

/**
 * The skill names a well-known source's indexes list, for deciding that a skill is gone.
 * Mirrors the CLI's fetchIndexCandidates and the scope filter of discoverSkills (the same
 * index URLs in the same order), but keeps every error: the CLI turns a network error, a bad
 * status or a failed artifact download into "no skills", which would read as "deleted".
 *
 * - A network error, a status other than 404 or 410, or a body that is not JSON: 502.
 * - No index found at all (every candidate 404/410 or not an index): 502, as nothing proves
 *   the skill is gone.
 * - Names come from the index entries themselves (any entry with a string name), never from
 *   the artifacts that happened to download.
 */
export async function wellKnownIndexNames(
  url: string,
  signal: AbortSignal,
  fetchFn: FetchLike = (u, init) => fetch(u, init)
): Promise<string[][]> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HttpError(400, "unsupported_source", `Not a URL: ${url}`)
  }
  const basePath = parsed.pathname.replace(/\/$/, "")
  const origin = `${parsed.protocol}//${parsed.host}`
  const tries: { indexUrl: string; base: string }[] = []
  for (const wellKnown of [".well-known/agent-skills", ".well-known/skills"]) {
    tries.push({ indexUrl: `${origin}${basePath}/${wellKnown}/index.json`, base: `${origin}${basePath}` })
    if (basePath) tries.push({ indexUrl: `${origin}/${wellKnown}/index.json`, base: origin })
  }
  const found: { base: string; names: string[] }[] = []
  for (const { indexUrl, base } of tries) {
    let response: Response
    try {
      response = await fetchFn(indexUrl, { signal })
    } catch (err) {
      if (signal.aborted) throw new HttpError(504, "fetch_timeout", "Fetching the source timed out")
      throw new HttpError(502, "fetch_failed", `Could not fetch ${indexUrl}: ${(err as Error).message}`)
    }
    if (response.status === 404 || response.status === 410) continue
    if (!response.ok)
      throw new HttpError(502, "fetch_failed", `${indexUrl} answered ${response.status}`)
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      throw new HttpError(502, "fetch_failed", `${indexUrl} is not valid JSON`)
    }
    const skills = (raw as { skills?: unknown } | null)?.skills
    if (!Array.isArray(skills)) continue
    const names = skills
      .map((entry) => (entry as { name?: unknown } | null)?.name)
      .filter((name): name is string => typeof name === "string")
    found.push({ base, names })
  }
  // discoverSkills: a URL with a path never falls back to the root index.
  const scoped = basePath ? found.filter((c) => c.base !== origin) : found
  if (scoped.length === 0)
    throw new HttpError(502, "fetch_failed", `No skills index found for ${url}; could not verify that the skill is gone`)
  return scoped.map((c) => c.names)
}

/**
 * Runs the CLI's discoverSkills over a copy of just what it reads: each
 * SKILL.md (its first 64 KB: discovery uses the frontmatter only) and the
 * manifests at the source root. Links are copied only when they resolve to a
 * regular file inside the source, so discovery never reads outside it or
 * blocks on a FIFO. `mdPaths` are source-relative posix SKILL.md paths.
 */
export async function discoverInView(
  root: string,
  mdPaths: string[],
  view: string,
  options: DiscoverOptions
): Promise<DiscoveredSkill[]> {
  if (mdPaths.length > PREVIEW_LIMITS.maxSkillMds)
    throw previewTooLarge(
      `the source has more than ${PREVIEW_LIMITS.maxSkillMds.toLocaleString("en-US")} SKILL.md files`
    )
  const realRoot = await realpath(root)
  const budget = new ReadBudget(PREVIEW_LIMITS.maxReadBytes)
  await rm(view, { recursive: true, force: true })
  await mkdir(view, { recursive: true })
  for (const path of mdPaths)
    await copyIntoView(realRoot, view, path, DISCOVERY_MD_BYTES, budget, false)
  for (const path of DISCOVERY_MANIFESTS)
    await copyIntoView(realRoot, view, path, MAX_MANIFEST_BYTES, budget, true)
  return discoverWithCli(view, options)
}

/** The CLI's discoverSkills on `dir`, its warnings silenced. */
export async function discoverWithCli(
  dir: string,
  options: DiscoverOptions
): Promise<DiscoveredSkill[]> {
  const cli = await loadCli()
  let found: { name: string; path: string }[]
  try {
    found = await cli.withWarnings(
      () => {},
      () => cli.discoverSkills(dir, undefined, options)
    )
  } catch {
    // e.g. an invalid skills-lock.json in the source; update fails the same way
    throw new HttpError(
      409,
      "upstream_unreadable",
      "skills update could not list the skills in the source"
    )
  }
  return found.map((skill) => {
    const folder = relative(dir, skill.path).split(sep).join("/")
    return {
      path: folder ? `${folder}/SKILL.md` : "SKILL.md",
      name: skill.name,
    }
  })
}

/** Files at the source root that discoverSkills reads besides SKILL.md. */
export const DISCOVERY_MANIFESTS = [
  "skills-lock.json",
  "skills.sh.json",
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
]
const DISCOVERY_MD_BYTES = 64 * 1024
const MAX_MANIFEST_BYTES = PREVIEW_LIMITS.maxDiffBytes

async function copyIntoView(
  realRoot: string,
  view: string,
  path: string,
  maxBytes: number,
  budget: ReadBudget,
  whole: boolean
): Promise<void> {
  const real = await safeSourceFile(realRoot, join(realRoot, path))
  if (!real) return
  const handle = await openRegularFile(real).catch(() => null)
  if (!handle) return
  try {
    const { bytes, truncated } = await readPrefix(handle, maxBytes, budget)
    if (whole && truncated)
      throw previewTooLarge(
        `${path} in the source is larger than ${maxBytes / 1024} KB`
      )
    const target = join(view, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  } finally {
    await handle.close()
  }
}

/**
 * The real path of a regular file inside realRoot, or null when it is
 * missing, special, or reached through a link that leaves realRoot.
 */
export async function safeSourceFile(
  realRoot: string,
  path: string
): Promise<string | null> {
  const real = await realpath(path).catch(() => null)
  if (!real || !isInside(realRoot, real)) return null
  const target = await lstat(real).catch(() => null)
  return target?.isFile() ? real : null
}

/** SKILL.md paths under dir, without following links to folders. */
async function findSkillMds(dir: string): Promise<string[]> {
  const found: string[] = []
  const stack: [string, string][] = [[dir, ""]]
  let entries = 0
  while (stack.length > 0) {
    const [current, prefix] = stack.pop() as [string, string]
    let list: Dirent[]
    try {
      list = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of list) {
      if (++entries > MAX_WALK_ENTRIES)
        throw previewTooLarge(
          `the source has more than ${MAX_WALK_ENTRIES.toLocaleString("en-US")} files`
        )
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) stack.push([join(current, entry.name), rel])
      else if (entry.name === "SKILL.md") found.push(rel)
    }
  }
  return found
}
const MAX_WALK_ENTRIES = 100_000

/** A fetched source must fit the disk quota; the caller deletes the dir. */
export async function checkSourceSize(
  dir: string,
  max: number = PREVIEW_LIMITS.maxSourceBytes
): Promise<void> {
  if ((await dirSize(dir, max)) > max)
    throw previewTooLarge(`the source is larger than ${formatMb(max)}`)
}

/** A source fetched in full up front; its skills are known by name. */
class StaticCheckout implements Checkout {
  readonly ref = null

  constructor(
    private readonly dir: string,
    private readonly refs: DiscoveredSkill[]
  ) {}

  get root(): string {
    return this.dir
  }

  async listSkillMds(): Promise<SkillMdRef[]> {
    return this.refs
  }

  async discover(): Promise<DiscoveredSkill[]> {
    return this.refs
  }

  async folder(path: string): Promise<string> {
    return path ? join(this.dir, path) : this.dir
  }
}

/** Like the CLI's writeSkillFiles: paths that leave the folder are skipped. */
async function writeSkillFiles(
  target: string,
  files: Map<string, string | Uint8Array>
): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const [path, content] of files) {
    const full = resolve(target, path)
    if (full === target || !isInside(target, full)) continue
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
}

function loadCli(): Promise<CliModule> {
  cliModule ??= (
    import(config.skillsAgentsModule) as Promise<Partial<CliModule>>
  ).then((mod) => {
    if (
      !mod.wellKnownProvider ||
      !mod.downloadSource ||
      !mod.discoverSkills ||
      !mod.sanitizeName ||
      !mod.withWarnings
    )
      throw new HttpError(
        400,
        "unsupported_source",
        "This skills CLI version does not expose its well-known or download fetchers"
      )
    return mod as CliModule
  })
  return cliModule
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        new HttpError(504, "fetch_timeout", "Fetching the source timed out")
      )
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, (err) =>
      reject(
        err instanceof HttpError
          ? err
          : new HttpError(502, "fetch_failed", (err as Error).message)
      )
    )
  })
}
