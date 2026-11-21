import { useSyncExternalStore } from "react"
import type { ScopeKey } from "@shared/api"

// App-wide UI state that several unrelated components open or read:
// the jobs drawer, the install dialog and the Update all dialog.

interface UiState {
  jobsOpen: boolean
  selectedJobId: string | null
  installOpen: boolean
  /** the scope whose Update all dialog is open */
  updateAllScope: ScopeKey | null
}

let state: UiState = { jobsOpen: false, selectedJobId: null, installOpen: false, updateAllScope: null }
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

export const ui = {
  openJobs: (jobId?: string) =>
    set({ jobsOpen: true, selectedJobId: jobId ?? state.selectedJobId }),
  setJobsOpen: (open: boolean) => set({ jobsOpen: open }),
  selectJob: (jobId: string) => set({ selectedJobId: jobId }),
  setInstallOpen: (open: boolean) => set({ installOpen: open }),
  openUpdateAll: (scope: ScopeKey) => set({ updateAllScope: scope }),
  closeUpdateAll: () => set({ updateAllScope: null }),
}
