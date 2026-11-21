import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { config } from "../config.ts"
import { HttpError } from "../lib/errors.ts"
import { isInside } from "../lib/files.ts"
import type { Checkout, SkillMdRef } from "./source-cache.ts"

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
    options: { fullDepth: boolean }
  ): Promise<{ name: string; path: string }[]>
  sanitizeName(name: string): string
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
  const refs: SkillMdRef[] = []
  for (const skill of skills) {
    const folder = cli.sanitizeName(skill.installName)
    await writeSkillFiles(join(dir, folder), skill.files)
    refs.push({ path: `${folder}/SKILL.md`, name: skill.installName })
  }
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
  try {
    await cp(downloaded.rootDir, dir, {
      recursive: true,
      verbatimSymlinks: true,
    })
  } finally {
    await rm(downloaded.tempDir, { recursive: true, force: true })
  }
  const found = await cli.discoverSkills(dir, undefined, { fullDepth: true })
  const refs = found.map((skill) => {
    const folder = relative(dir, skill.path).split(sep).join("/")
    return {
      path: folder ? `${folder}/SKILL.md` : "SKILL.md",
      name: skill.name,
    }
  })
  return new StaticCheckout(dir, refs)
}

/** A source fetched in full up front. */
class StaticCheckout implements Checkout {
  readonly ref = null

  constructor(
    private readonly dir: string,
    private readonly refs: SkillMdRef[]
  ) {}

  async listSkillMds(): Promise<SkillMdRef[]> {
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
      !mod.sanitizeName
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
