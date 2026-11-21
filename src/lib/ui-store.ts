import { useSyncExternalStore } from "react"

// App-wide UI state that several unrelated components open or read:
// the jobs drawer and the install dialog.

interface UiState {
  jobsOpen: boolean
  selectedJobId: string | null
  installOpen: boolean
}

let state: UiState = { jobsOpen: false, selectedJobId: null, installOpen: false }
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
}
