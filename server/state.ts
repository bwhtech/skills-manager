import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { atomicWrite } from "./lib/files.ts"

export interface AppState {
  pinned: string[]
  discovered: string[]
  lastScanAt: string | null
}

const EMPTY: AppState = { pinned: [], discovered: [], lastScanAt: null }

/** App state in ~/.config/skills-manager/state.json. */
export class StateStore {
  private state: AppState = { ...EMPTY }

  constructor(private readonly file: string) {}

  async load(): Promise<AppState> {
    try {
      const raw = JSON.parse(
        await readFile(this.file, "utf8")
      ) as Partial<AppState>
      this.state = {
        pinned: stringArray(raw.pinned),
        discovered: stringArray(raw.discovered),
        lastScanAt: typeof raw.lastScanAt === "string" ? raw.lastScanAt : null,
      }
    } catch {
      this.state = { ...EMPTY }
    }
    return this.get()
  }

  get(): AppState {
    return {
      ...this.state,
      pinned: [...this.state.pinned],
      discovered: [...this.state.discovered],
    }
  }

  async update(patch: Partial<AppState>): Promise<void> {
    this.state = { ...this.state, ...patch }
    await mkdir(dirname(this.file), { recursive: true })
    await atomicWrite(this.file, JSON.stringify(this.state, null, 2) + "\n")
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : []
}
