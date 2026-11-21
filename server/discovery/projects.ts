import { normalize, isAbsolute } from "node:path"
import { config } from "../config.ts"
import { badRequest } from "../lib/errors.ts"
import { isDirectory } from "../lib/files.ts"
import type { StateStore } from "../state.ts"
import { scanProjects } from "./project-scan.ts"

export interface ProjectRef {
  path: string
  pinned: boolean
  discovered: boolean
}

/** Known projects: the cached scan of ~ plus pinned paths. */
export class ProjectService {
  constructor(private readonly state: StateStore) {}

  /** Scan on first boot, when there is no cached scan yet. */
  async init(): Promise<void> {
    const state = await this.state.load()
    if (!state.lastScanAt) await this.rescan()
  }

  list(): ProjectRef[] {
    const { pinned, discovered } = this.state.get()
    const paths = [...new Set([...discovered, ...pinned])].sort()
    return paths.map((path) => ({
      path,
      pinned: pinned.includes(path),
      discovered: discovered.includes(path),
    }))
  }

  paths(): string[] {
    return this.list().map((p) => p.path)
  }

  has(path: string): boolean {
    return this.paths().includes(path)
  }

  lastScanAt(): string | null {
    return this.state.get().lastScanAt
  }

  async rescan(): Promise<void> {
    const discovered = await scanProjects({
      root: config.home,
      depth: config.scanDepth,
      skipPaths: config.scanSkipPaths,
    })
    await this.state.update({
      discovered,
      lastScanAt: new Date().toISOString(),
    })
  }

  async pin(raw: unknown): Promise<void> {
    const path = requireDirPath(raw)
    if (!(await isDirectory(path))) throw badRequest("path is not a directory")
    if (path === config.home)
      throw badRequest("The home directory is the user scope")
    const pinned = this.state.get().pinned
    if (!pinned.includes(path))
      await this.state.update({ pinned: [...pinned, path] })
  }

  async unpin(raw: unknown): Promise<void> {
    const path = requireDirPath(raw)
    await this.state.update({
      pinned: this.state.get().pinned.filter((p) => p !== path),
    })
  }
}

function requireDirPath(raw: unknown): string {
  if (typeof raw !== "string" || !isAbsolute(raw) || raw.includes("\0"))
    throw badRequest("path must be absolute")
  const path = normalize(raw)
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
}
