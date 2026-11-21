import { useState } from "react"

export type ViewMode = "edit" | "preview" | "split"

const STORAGE_KEY = "skills-manager:view-mode"

function read(): ViewMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === "edit" || value === "preview" || value === "split") return value
  } catch {
    // storage blocked
  }
  return "edit"
}

/** Edit / Preview / Split, remembered across files and reloads. */
export function useViewMode() {
  const [mode, setModeState] = useState<ViewMode>(read)
  const setMode = (next: ViewMode) => {
    setModeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // storage blocked
    }
  }
  return [mode, setMode] as const
}
