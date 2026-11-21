import { mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { HttpError } from "../lib/errors.ts"
import { DISCOVERY_MANIFESTS, discoverInView } from "./cli-sources.ts"
import { PREVIEW_LIMITS, dirSize, formatMb, previewTooLarge } from "./limits.ts"
import type { Checkout, DiscoveredSkill, SkillMdRef } from "./source-cache.ts"

/** Runs a follow-up fetch (sparse checkout) in a fetch slot with a timeout. */
export type Limiter = <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T>

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface RunOptions {
  /** a dir whose size must stay under the quota while git runs */
  watch?: string
  /** stdout beyond this is a 413 */
  maxStdout?: number
}

export interface GitSourceOptions {
  /** disk quota per clone */
  maxSourceBytes?: number
  /** GIT_ALLOW_PROTOCOL; tests add `file` */
  protocols?: string
}

const QUOTA_POLL_MS = 250
const MAX_LS_TREE_BYTES = 64 * 1024 * 1024

/**
 * Fetches a Git source the way `skills update` clones it (cloneRepo in
 * skills 1.9.0): depth 1, `--branch <ref>` when the lock has a ref, and a
 * fetch of the exact commit when the ref is a sha that is not a branch.
 * Unlike the CLI it clones without blobs and without a checkout, then checks
 * out only the paths a preview asks for (no root files), so big repos stay
 * cheap. A server may ignore the blob filter, so the clone's disk use is
 * watched while git runs and checked after: past the quota git is killed
 * and the preview is a 413. LFS smudging is off, as in the CLI, so LFS
 * files compare as their pointer files.
 *
 * Layout of `dir`: `repo/` is the clone, `discover/` the discovery view.
 */
export class GitSource {
  private readonly maxBytes: number
  private readonly protocols: string

  constructor(
    private readonly token: string | null,
    options: GitSourceOptions = {}
  ) {
    this.maxBytes = options.maxSourceBytes ?? PREVIEW_LIMITS.maxSourceBytes
    this.protocols = options.protocols ?? "https:http:ssh"
  }

  async fetch(
    url: string,
    ref: string | null,
    dir: string,
    signal: AbortSignal,
    limit: Limiter
  ): Promise<Checkout> {
    const auth = this.wantsAuth(url)
    try {
      return await this.clone(url, ref, dir, signal, auth, limit)
    } catch (err) {
      // A stale token must not block a public repo: retry without it.
      if (!auth || !isAuthFailure(err) || signal.aborted) throw err
      await emptyDir(dir)
      return this.clone(url, ref, dir, signal, false, limit)
    }
  }

  private async clone(
    url: string,
    ref: string | null,
    dir: string,
    signal: AbortSignal,
    auth: boolean,
    limit: Limiter
  ): Promise<Checkout> {
    const repo = join(dir, "repo")
    const base = [
      "clone",
      "-q",
      "--no-checkout",
      "--depth",
      "1",
      "--filter=blob:none",
    ]
    const branch = ref ? ["--branch", ref] : []
    const res = await this.run(
      [...base, ...branch, "--", url, repo],
      signal,
      auth,
      { watch: dir }
    )
    if (res.exitCode !== 0) {
      if (!ref || !isCommitSha(ref) || !isMissingRef(res.stderr))
        throw fetchFailed(url, res.stderr)
      await emptyDir(dir)
      await this.fetchSha(url, ref, repo, signal, auth)
    }
    const head = await this.run(["-C", repo, "rev-parse", "HEAD"], signal, auth)
    const sha = head.stdout.trim()
    return new GitCheckout(
      this,
      repo,
      join(dir, "discover"),
      auth,
      /^[0-9a-f]{40}$/.test(sha) ? sha : null,
      limit
    )
  }

  /** cloneAtSha in the CLI, without the checkout. */
  private async fetchSha(
    url: string,
    sha: string,
    repo: string,
    signal: AbortSignal,
    auth: boolean
  ): Promise<void> {
    await mkdir(repo, { recursive: true })
    const steps = [
      ["-C", repo, "init", "-q"],
      ["-C", repo, "remote", "add", "origin", "--", url],
      [
        "-C",
        repo,
        "fetch",
        "-q",
        "--depth",
        "1",
        "--filter=blob:none",
        "origin",
        sha,
      ],
      ["-C", repo, "update-ref", "--no-deref", "HEAD", "FETCH_HEAD"],
    ]
    for (const args of steps) {
      const res = await this.run(args, signal, auth, { watch: repo })
      if (res.exitCode !== 0) throw fetchFailed(url, res.stderr)
    }
  }

  /**
   * Runs git with an argument array; kills it when signal aborts, when the
   * watched dir passes the quota, or when stdout passes its cap.
   */
  async run(
    args: string[],
    signal: AbortSignal,
    auth: boolean,
    options: RunOptions = {}
  ): Promise<GitResult> {
    if (signal.aborted) throw timedOut()
    const proc = Bun.spawn(["git", ...GIT_CONFIG, ...args], {
      env: this.env(auth),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    let tooLarge: HttpError | null = null
    const stop = (err: HttpError) => {
      tooLarge ??= err
      proc.kill()
    }
    const kill = () => proc.kill()
    signal.addEventListener("abort", kill, { once: true })
    const watcher = options.watch ? this.watchQuota(options.watch, stop) : null
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readCapped(proc.stdout, options.maxStdout ?? Infinity, () =>
          stop(previewTooLarge("the source lists too many files"))
        ),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (signal.aborted) throw timedOut()
      if (tooLarge) throw tooLarge
      if (options.watch) await this.checkQuota(options.watch)
      return { exitCode, stdout, stderr: this.redact(stderr) }
    } finally {
      watcher?.stop()
      signal.removeEventListener("abort", kill)
    }
  }

  /** Throws 413 when dir uses more than the quota. */
  async checkQuota(dir: string): Promise<void> {
    if ((await dirSize(dir, this.maxBytes)) > this.maxBytes)
      throw this.overQuota()
  }

  private overQuota(): HttpError {
    return previewTooLarge(
      `the source is larger than ${formatMb(this.maxBytes)}`
    )
  }

  private watchQuota(dir: string, stop: (err: HttpError) => void) {
    let busy = false
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      dirSize(dir, this.maxBytes)
        .then((size) => {
          if (size > this.maxBytes) stop(this.overQuota())
        })
        .catch(() => {})
        .finally(() => {
          busy = false
        })
    }, QUOTA_POLL_MS)
    return { stop: () => clearInterval(timer) }
  }

  private wantsAuth(url: string): boolean {
    return !!this.token && url.startsWith("https://github.com/")
  }

  /** The token goes in a config env var: never in the URL, argv or .git/config. */
  private env(auth: boolean): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !/^GIT_(TRACE|CURL_VERBOSE|CONFIG)/.test(k))
        env[k] = v
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: this.protocols,
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
      LC_ALL: "C",
    })
    if (auth && this.token) {
      const basic = Buffer.from(`x-access-token:${this.token}`).toString(
        "base64"
      )
      Object.assign(env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      })
    }
    return env
  }

  private redact(text: string): string {
    return this.token ? text.split(this.token).join("***") : text
  }
}

/**
 * A blobless clone with nothing checked out. Paths are checked out on first
 * use with non-cone sparse patterns, so only the folders asked for (and, to
 * find a moved skill, every SKILL.md plus the root manifests) reach the disk.
 */
class GitCheckout implements Checkout {
  private chain: Promise<unknown> = Promise.resolve()
  private skillMds: Promise<SkillMdRef[]> | null = null
  private discovered: Promise<DiscoveredSkill[]> | null = null
  private readonly included = new Set<string>()
  private readonly wanted = new Set<string>()
  private batch: Promise<void> | null = null
  private started = false
  private broken: HttpError | null = null

  constructor(
    private readonly git: GitSource,
    readonly root: string,
    private readonly view: string,
    private readonly auth: boolean,
    readonly ref: string | null,
    private readonly limit: Limiter
  ) {}

  listSkillMds(): Promise<SkillMdRef[]> {
    this.skillMds ??= retryable(
      this.serial(async () => {
        const args = [
          "-C",
          this.root,
          "ls-tree",
          "-r",
          "-z",
          "--name-only",
          "HEAD",
        ]
        const res = await this.git.run(
          args,
          AbortSignal.timeout(30_000),
          this.auth,
          { maxStdout: MAX_LS_TREE_BYTES }
        )
        if (res.exitCode !== 0) throw fetchFailed("the file list", res.stderr)
        return res.stdout
          .split("\0")
          .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
          .map((path) => ({ path }))
      }),
      () => (this.skillMds = null)
    )
    return this.skillMds
  }

  /**
   * discoverSkills(clone, undefined, { fullDepth, includeDuplicateNames }),
   * as update runs it when a locked skillPath is gone.
   */
  discover(): Promise<DiscoveredSkill[]> {
    this.discovered ??= retryable(
      (async () => {
        const mds = (await this.listSkillMds()).map((m) => m.path)
        // Check before the checkout downloads them all.
        if (mds.length > PREVIEW_LIMITS.maxSkillMds)
          throw previewTooLarge(
            `the source has more than ${PREVIEW_LIMITS.maxSkillMds.toLocaleString("en-US")} SKILL.md files`
          )
        await this.include(DISCOVERY_PATTERNS)
        return discoverInView(this.root, mds, this.view, {
          fullDepth: true,
          includeDuplicateNames: true,
        })
      })(),
      () => (this.discovered = null)
    )
    return this.discovered
  }

  async folder(path: string): Promise<string> {
    await this.include([folderPattern(path)])
    return path ? join(this.root, path) : this.root
  }

  private async include(patterns: string[]): Promise<void> {
    if (this.broken) throw this.broken
    const missing = patterns.filter((p) => !this.included.has(p))
    if (missing.length === 0) return
    for (const p of missing) this.wanted.add(p)
    // Sparse checkout changes the work tree and index, so it runs one at a
    // time per clone; paths asked for meanwhile go in the next batch.
    this.batch ??= this.serial(() =>
      this.limit((signal) => this.checkout(signal))
    )
    await this.batch
    if (this.broken) throw this.broken
    if (!patterns.every((p) => this.included.has(p)))
      throw fetchFailed("a folder", "sparse checkout did not include it")
  }

  private async checkout(signal: AbortSignal): Promise<void> {
    this.batch = null
    const patterns = [...this.wanted].filter((p) => !this.included.has(p))
    this.wanted.clear()
    if (patterns.length === 0 || this.broken) return
    const steps = this.started
      ? [["sparse-checkout", "add", ...patterns]]
      : [
          ["sparse-checkout", "set", "--no-cone", ...patterns],
          ["checkout", "-q"],
        ]
    try {
      for (const step of steps) {
        const res = await this.git.run(
          ["-C", this.root, ...step],
          signal,
          this.auth,
          { watch: this.root }
        )
        if (res.exitCode !== 0) throw fetchFailed("a folder", res.stderr)
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) {
        // Over the quota: free the disk now; this source stays too large.
        this.broken = err
        await rm(this.root, { recursive: true, force: true }).catch(() => {})
      }
      throw err
    }
    this.started = true
    for (const p of patterns) this.included.add(p)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }
}

/** What discoverSkills reads: every SKILL.md and the manifests at the root. */
const DISCOVERY_PATTERNS = [
  "SKILL.md",
  ...DISCOVERY_MANIFESTS.map((path) => `/${path}`),
]

/**
 * The sparse pattern for exactly one folder (and what is under it); "" is
 * the whole tree. Glob characters are escaped so a name matches literally.
 */
export function folderPattern(path: string): string {
  if (path === "") return "/*"
  if (hasControlChar(path) || path.startsWith("/") || path.endsWith("/"))
    throw new HttpError(
      400,
      "unsupported_source",
      "The skill folder has a name previews do not support"
    )
  return `/${path.replace(/[\\*?[\]!# ]/g, "\\$&")}/`
}

function hasControlChar(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Clears a cached promise when it fails, so the next call tries again. */
function retryable<T>(promise: Promise<T>, clear: () => void): Promise<T> {
  promise.catch(clear)
  return promise
}

/** Reads a stream as text; calls onOver (once) and stops past max bytes. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number,
  onOver: () => void
): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      onOver()
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// Same overrides as the CLI's git client, plus no hooks from global config.
const GIT_CONFIG = [
  "-c",
  "filter.lfs.required=false",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "advice.detachedHead=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
]

async function emptyDir(dir: string): Promise<void> {
  for (const name of await readdir(dir))
    await rm(join(dir, name), { recursive: true, force: true })
}

function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref)
}

function isMissingRef(message: string): boolean {
  return (
    /Remote branch .* not found in upstream origin/i.test(message) ||
    /couldn't find remote ref/i.test(message) ||
    /upload-pack: not our ref/i.test(message)
  )
}

function isAuthFailure(err: unknown): boolean {
  const detail = err instanceof HttpError ? (err.detail ?? "") : ""
  return /Authentication failed|could not read Username|Invalid username or token|returned error: 40[13]/.test(
    detail
  )
}

function fetchFailed(what: string, stderr: string): HttpError {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  const detail = lines.slice(-2).join(" ") || "git failed"
  return new HttpError(
    502,
    "fetch_failed",
    `Could not fetch ${what}: ${detail}`
  )
}

function timedOut(): HttpError {
  return new HttpError(504, "fetch_timeout", "Fetching the source timed out")
}
