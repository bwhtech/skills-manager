import { useSyncExternalStore } from "react"
import type { ScopeKey } from "@shared/api"
import { confirmLeave } from "@/lib/unsaved"

export type MainTab = "skills" | "instructions"

export interface Place {
  scope: ScopeKey
  tab: MainTab
  /** selected skill id */
  skill: string | null
  /** file inside the selected skill, relative path; null = SKILL.md */
  file: string | null
  /** selected instruction file id */
  doc: string | null
}

const listeners = new Set<() => void>()
let cachedHash: string | null = null
let cachedPlace: Place

function parse(hash: string): Place {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const tab = params.get("tab") === "instructions" ? "instructions" : "skills"
  return {
    scope: params.get("scope") || "user",
    tab,
    skill: params.get("skill"),
    file: params.get("file"),
    doc: params.get("doc"),
  }
}

function serialize(place: Place) {
  const params = new URLSearchParams()
  params.set("scope", place.scope)
  params.set("tab", place.tab)
  if (place.skill) params.set("skill", place.skill)
  if (place.file) params.set("file", place.file)
  if (place.doc) params.set("doc", place.doc)
  return "#" + params.toString()
}

export function getPlace(): Place {
  if (cachedHash !== window.location.hash) {
    cachedHash = window.location.hash
    cachedPlace = parse(cachedHash)
  }
  return cachedPlace
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener("hashchange", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("hashchange", listener)
  }
}

export function usePlace() {
  return useSyncExternalStore(subscribe, getPlace)
}

/**
 * Move to another place. Asks first when the open editor has unsaved changes.
 * Uses replaceState, so moving around does not fill the history.
 */
export function navigate(patch: Partial<Place>, options: { force?: boolean } = {}) {
  const current = getPlace()
  const next = { ...current, ...patch }
  // A new scope resets the selection inside it; a new skill resets the file.
  if (patch.scope !== undefined && patch.scope !== current.scope) {
    if (!("skill" in patch)) next.skill = null
    if (!("doc" in patch)) next.doc = null
    if (!("file" in patch)) next.file = null
  }
  if (patch.skill !== undefined && patch.skill !== current.skill && !("file" in patch)) {
    next.file = null
  }
  const hash = serialize(next)
  if (hash === window.location.hash) return

  const go = () => {
    history.replaceState(null, "", hash)
    for (const listener of listeners) listener()
  }
  const leavesEditor =
    next.scope !== current.scope ||
    next.tab !== current.tab ||
    next.skill !== current.skill ||
    next.file !== current.file ||
    next.doc !== current.doc
  if (options.force || !leavesEditor) go()
  else confirmLeave(go)
}
