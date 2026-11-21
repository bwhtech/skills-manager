import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { HttpError } from "../lib/errors.ts"
import type { Checkout, SkillMdRef } from "./source-cache.ts"

/** Runs a follow-up fetch (sparse checkout) in a fetch slot with a timeout. */
export type Limiter = <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T>

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Fetches a Git source the way `skills update` clones it (cloneRepo in
 * skills 1.9.0): depth 1, `--branch <ref>` when the lock has a ref, and a
 * fetch of the exact commit when the ref is a sha that is not a branch.
 * Unlike the CLI it clones without blobs and checks out only the skill
 * folders a preview asks for, so big repos stay cheap. LFS smudging is off,
 * as in the CLI, so LFS files compare as their pointer files.
 */
export class GitSource {
  constructor(private readonly token: string | null) {}

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
    const base = [
      "clone",
      "-q",
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
    ]
    const branch = ref ? ["--branch", ref] : []
    const res = await this.run(
      [...base, ...branch, "--", url, dir],
      signal,
      auth
    )
    if (res.exitCode !== 0) {
      if (!ref || !isCommitSha(ref) || !isMissingRef(res.stderr))
        throw fetchFailed(url, res.stderr)
      await emptyDir(dir)
      await this.fetchSha(url, ref, dir, signal, auth)
    }
    const head = await this.run(["-C", dir, "rev-parse", "HEAD"], signal, auth)
    const sha = head.stdout.trim()
    return new GitCheckout(
      this,
      dir,
      auth,
      /^[0-9a-f]{40}$/.test(sha) ? sha : null,
      limit
    )
  }

  /** cloneAtSha in the CLI. */
  private async fetchSha(
    url: string,
    sha: string,
    dir: string,
    signal: AbortSignal,
    auth: boolean
  ): Promise<void> {
    const steps = [
      ["-C", dir, "init", "-q"],
      ["-C", dir, "remote", "add", "origin", "--", url],
      [
        "-C",
        dir,
        "fetch",
        "-q",
        "--depth",
        "1",
        "--filter=blob:none",
        "origin",
        sha,
      ],
      ["-C", dir, "sparse-checkout", "set", "--cone"],
      ["-C", dir, "checkout", "-q", "FETCH_HEAD"],
    ]
    for (const args of steps) {
      const res = await this.run(args, signal, auth)
      if (res.exitCode !== 0) throw fetchFailed(url, res.stderr)
    }
  }

  /** Runs git with an argument array; kills it when signal aborts. */
  async run(
    args: string[],
    signal: AbortSignal,
    auth: boolean
  ): Promise<GitResult> {
    if (signal.aborted) throw timedOut()
    const proc = Bun.spawn(["git", ...GIT_CONFIG, ...args], {
      env: this.env(auth),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const kill = () => proc.kill()
    signal.addEventListener("abort", kill, { once: true })
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (signal.aborted) throw timedOut()
      return { exitCode, stdout, stderr: this.redact(stderr) }
    } finally {
      signal.removeEventListener("abort", kill)
    }
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
      GIT_ALLOW_PROTOCOL: "https:http:ssh",
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

/** A blobless clone; skill folders are checked out on first use. */
class GitCheckout implements Checkout {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly ready = new Set<string>()
  private skillMds: Promise<SkillMdRef[]> | null = null
  private full = false
  private readonly wanted = new Set<string>()
  private batch: Promise<void> | null = null

  constructor(
    private readonly git: GitSource,
    private readonly dir: string,
    private readonly auth: boolean,
    readonly ref: string | null,
    private readonly limit: Limiter
  ) {}

  listSkillMds(): Promise<SkillMdRef[]> {
    this.skillMds ??= this.serial(async () => {
      const args = [
        "-C",
        this.dir,
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        "HEAD",
      ]
      const res = await this.git.run(
        args,
        AbortSignal.timeout(30_000),
        this.auth
      )
      if (res.exitCode !== 0) throw fetchFailed(this.dir, res.stderr)
      return res.stdout
        .split("\0")
        .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
        .map((path) => ({ path }))
    })
    return this.skillMds
  }

  folder(path: string): Promise<string> {
    const target = path ? join(this.dir, path) : this.dir
    if (this.full || this.ready.has(path)) return Promise.resolve(target)
    this.wanted.add(path)
    // Sparse checkout changes the work tree and index, so it runs one at a
    // time per clone; folders asked for meanwhile go in the next batch.
    this.batch ??= this.serial(() =>
      this.limit((signal) => this.checkout(signal))
    )
    return this.batch.then(() => {
      if (this.full || this.ready.has(path)) return target
      throw fetchFailed(path || "/", "sparse checkout did not include it")
    })
  }

  private async checkout(signal: AbortSignal): Promise<void> {
    this.batch = null
    const paths = [...this.wanted].filter((p) => !this.ready.has(p))
    this.wanted.clear()
    if (this.full || paths.length === 0) return
    const args = paths.includes("")
      ? ["-C", this.dir, "sparse-checkout", "disable"]
      : ["-C", this.dir, "sparse-checkout", "add", ...paths]
    const res = await this.git.run(args, signal, this.auth)
    if (res.exitCode !== 0)
      throw fetchFailed(paths.join(", ") || "/", res.stderr)
    if (paths.includes("")) this.full = true
    for (const p of paths) this.ready.add(p)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }
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
