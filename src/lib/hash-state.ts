import { useSyncExternalStore } from "react"
import type { ScopeKey } from "@shared/api"
import { confirmLeave, isDirty } from "@/lib/unsaved"

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
/** The hash the app shows. It lags the URL while a leave prompt is open. */
let committedHash = window.location.hash
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
  if (cachedHash !== committedHash) {
    cachedHash = committedHash
    cachedPlace = parse(committedHash)
  }
  return cachedPlace
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePlace() {
  return useSyncExternalStore(subscribe, getPlace)
}

function leavesEditor(current: Place, next: Place) {
  return (
    next.scope !== current.scope ||
    next.tab !== current.tab ||
    next.skill !== current.skill ||
    next.file !== current.file ||
    next.doc !== current.doc
  )
}

/** Show the place of this hash. replaceState does not fire hashchange. */
function commit(hash: string) {
  if (window.location.hash !== hash) history.replaceState(null, "", hash)
  committedHash = hash
  for (const listener of listeners) listener()
}

// Back/forward, hand-edited hashes and hash links change the URL first. Put
// the shown hash back while the leave prompt is open; move on only if the
// user agrees to discard the draft.
window.addEventListener("hashchange", () => {
  const hash = window.location.hash
  if (hash === committedHash) return
  if (!isDirty() || !leavesEditor(getPlace(), parse(hash))) return commit(hash)
  history.replaceState(null, "", committedHash)
  confirmLeave(() => commit(hash))
})

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
  if (hash === committedHash) return
  const go = () => commit(hash)
  if (options.force || !leavesEditor(current, next)) go()
  else confirmLeave(go)
}
