import type { LockEntry } from "../discovery/locks.ts"
import { HttpError, badRequest } from "../lib/errors.ts"

/** Where `skills update` gets a skill from, and how to find it there. */
export type SourceSpec =
  | { kind: "git"; url: string; ref: string | null }
  | { kind: "well-known"; url: string }
  | { kind: "download"; url: string }

export interface PreviewPlan {
  spec: SourceSpec
  /** repo-relative SKILL.md path from the lock; tried first */
  skillPath: string | null
  /** the name the CLI selects the skill by in its source */
  sourceName: string
  /** set when the CLI rewrites the installed SKILL.md `name` to the lock name */
  renameTo: string | null
  /**
   * shouldUseFullDepthForUpdate in the CLI: the source takes no subpath (an
   * ssh or `.git` URL, or a host other than github.com and gitlab.com), so
   * update finds the skill by name even while the locked path exists.
   */
  fullDepth: boolean
}

export function cacheKey(spec: SourceSpec): string {
  return [
    spec.kind,
    spec.url,
    spec.kind === "git" ? (spec.ref ?? "") : "",
  ].join("\n")
}

/**
 * Mirrors updateGlobalSkills / updateProjectSkills in skills 1.9.0 (cli.mjs):
 * which entries the CLI can update, and from which URL and ref.
 */
export function planUpdate(
  entry: LockEntry,
  lockName: string,
  global: boolean
): PreviewPlan {
  const spec = global ? globalSpec(entry) : projectSpec(entry)
  const sourceName = entry.skillName ?? lockName
  return {
    spec,
    skillPath: entry.skillPath ?? null,
    sourceName,
    renameTo: entry.skillName && entry.skillName !== lockName ? lockName : null,
    fullDepth: usesFullDepth(entry),
  }
}

/** shouldUseFullDepthForUpdate in the CLI. */
function usesFullDepth(entry: LockEntry): boolean {
  if (!entry.skillPath) return false
  const source =
    entry.sourceType && entry.sourceType !== "github"
      ? localSource(entry)
      : entry.source
  return source !== null && !supportsAppendedSubpath(source)
}

/** supportsAppendedSubpath in the CLI. */
function supportsAppendedSubpath(source: string): boolean {
  if (source.startsWith("git@") || source.startsWith("ssh://")) return false
  if (source.endsWith(".git")) return false
  if (source.startsWith("http://") || source.startsWith("https://")) {
    try {
      const host = new URL(source).hostname
      return host === "github.com" || host === "gitlab.com"
    } catch {
      return false
    }
  }
  return true
}

function globalSpec(entry: LockEntry): SourceSpec {
  if (
    entry.sourceType === "well-known" &&
    entry.sourceBaseUrl &&
    entry.wellKnownDigest
  )
    return { kind: "well-known", url: checkHttpUrl(entry.sourceBaseUrl) }
  if (entry.sourceType === "download" && entry.sourceUrl)
    return downloadSpec(entry.sourceUrl)
  if (!entry.skillFolderHash || !entry.skillPath)
    throw unsupported(`skills update skips this skill (${skipReason(entry)})`)
  // buildUpdateInstallSource: GitHub entries use `source`, others the URL.
  const source =
    entry.sourceType && entry.sourceType !== "github"
      ? localSource(entry)
      : entry.source
  if (!source) throw missingSourceUrl()
  return gitSpec(toCloneUrl(source, entry.sourceType), entry.ref)
}

function projectSpec(entry: LockEntry): SourceSpec {
  if (entry.sourceType === "node_modules" || entry.sourceType === "local")
    throw unsupported(`skills update skips ${entry.sourceType} skills`)
  if (entry.sourceType === "download" && entry.sourceUrl)
    return downloadSpec(entry.sourceUrl)
  if (
    entry.sourceType === "well-known" &&
    entry.sourceUrl &&
    entry.wellKnownDigest
  )
    return { kind: "well-known", url: checkHttpUrl(entry.sourceUrl) }
  if (!entry.skillPath)
    throw unsupported(
      "skills update cannot update this skill in place (installed before skillPath tracking)"
    )
  // buildLocalCloneSource
  const source = localSource(entry)
  if (!source) throw missingSourceUrl()
  return gitSpec(toCloneUrl(source, entry.sourceType), entry.ref)
}

function gitSpec(url: string, ref: string | undefined): SourceSpec {
  if (ref !== undefined && !isSafeRef(ref))
    throw badRequest(`Unsupported ref in lock file: ${ref}`)
  return { kind: "git", url: checkGitUrl(url), ref: ref ?? null }
}

function downloadSpec(url: string): SourceSpec {
  const checked = checkHttpUrl(url)
  // The CLI downloads Notion skills through the `ntn` CLI; not mirrored here.
  if (/^https?:\/\/([^/]*\.)?notion\.(so|site)\//i.test(checked))
    throw unsupported("Previews of Notion skills are not supported")
  return { kind: "download", url: checked }
}

/** getLocalSource in the CLI. */
function localSource(entry: LockEntry): string | null {
  if (entry.sourceUrl) return entry.sourceUrl
  const bare = isBareShorthand(entry.source)
  if ((entry.sourceType === "git" || entry.sourceType === "gitlab") && bare)
    return null
  return entry.source
}

/**
 * The repo the CLI clones. `owner/repo` (with or without a subpath) and
 * github.com URLs become https://github.com/owner/repo.git, as parseSource does.
 */
export function toCloneUrl(source: string, sourceType?: string): string {
  if (isBareShorthand(source)) {
    const [owner, repo] = source.split(/[/#@]/)
    if (!owner || !repo || (sourceType && sourceType !== "github"))
      throw unsupported(`Cannot resolve source ${source}`)
    return `https://github.com/${owner}/${repo.replace(/\.git$/, "")}.git`
  }
  const github = /^https:\/\/github\.com\/([^/]+)\/([^/#]+)/.exec(source)
  if (github)
    return `https://github.com/${github[1]}/${github[2].replace(/\.git$/, "")}.git`
  return source
}

function isBareShorthand(source: string): boolean {
  return (
    !source.includes(":") && !source.startsWith(".") && !source.startsWith("/")
  )
}

/** getSkipReason in the CLI. */
function skipReason(entry: LockEntry): string {
  if (entry.sourceType === "local") return "local path"
  if (entry.sourceType === "git") return "Git URL"
  if (entry.sourceType === "well-known") return "well-known skill"
  if (!entry.skillFolderHash) return "private or deleted repo"
  return "no skill path recorded"
}

const HTTPS_GIT = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_.~%@+/-]+$/
const SSH_GIT =
  /^(?:git@[A-Za-z0-9.-]+:|ssh:\/\/[A-Za-z0-9_.@-]+(?::\d+)?\/)[A-Za-z0-9_.~/-]+$/
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9_./+-]{0,199}$/

function checkGitUrl(url: string): string {
  if ((HTTPS_GIT.test(url) || SSH_GIT.test(url)) && !url.includes(".."))
    return url
  throw unsupported("Only https and ssh Git sources can be previewed")
}

function checkHttpUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url
  } catch {
    // fall through
  }
  throw unsupported("The lock file has an invalid source URL")
}

function isSafeRef(ref: string): boolean {
  return SAFE_REF.test(ref) && !ref.includes("..")
}

function unsupported(detail: string): HttpError {
  return new HttpError(400, "unsupported_source", detail)
}

function missingSourceUrl(): HttpError {
  return unsupported(
    "The lock file is missing sourceUrl for this generic Git source"
  )
}
