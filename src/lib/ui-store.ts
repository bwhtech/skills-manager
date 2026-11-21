import { useSyncExternalStore } from "react"
import type { ScopeKey } from "@shared/api"

// App-wide UI state that several unrelated components open or read:
// the jobs drawer, the command palette, the install dialog, the Update all dialog and the file viewer.

/** A plain file a document linked to, shown in the file viewer. */
export interface ViewedFile {
  /** absolute path, as resolved from the link (GET /api/open) */
  path: string
  line?: number
}

interface UiState {
  jobsOpen: boolean
  selectedJobId: string | null
  paletteOpen: boolean
  installOpen: boolean
  /** skills.sh search text the install dialog opens with */
  installQuery: string
  /** the scope whose Update all dialog is open */
  updateAllScope: ScopeKey | null
  viewedFile: ViewedFile | null
}

let state: UiState = {
  jobsOpen: false,
  selectedJobId: null,
  paletteOpen: false,
  installOpen: false,
  installQuery: "",
  updateAllScope: null,
  viewedFile: null,
}
const listeners = new Set<() => void>()

function set(patch: Partial<UiState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUi() {
  return useSyncExternalStore(subscribe, () => state)
}

/** The current state, outside React. */
export function getUi(): UiState {
  return state
}

export const ui = {
  openJobs: (jobId?: string) =>
    set({ jobsOpen: true, selectedJobId: jobId ?? state.selectedJobId }),
  setJobsOpen: (open: boolean) => set({ jobsOpen: open }),
  selectJob: (jobId: string) => set({ selectedJobId: jobId }),
  setPaletteOpen: (open: boolean) => set({ paletteOpen: open }),
  setInstallOpen: (open: boolean, query = "") =>
    set(open ? { installOpen: true, installQuery: query, paletteOpen: false } : { installOpen: false }),
  openUpdateAll: (scope: ScopeKey) => set({ updateAllScope: scope }),
  closeUpdateAll: () => set({ updateAllScope: null }),
  /** Raw: features/open closes and replaces the viewer through its unsaved-changes guard. */
  viewFile: (file: ViewedFile) => set({ viewedFile: file }),
  closeFile: () => set({ viewedFile: null }),
}
