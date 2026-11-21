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
/**
 * History index of the entry the app shows. Entries the app creates carry
 * their index in history.state.smIdx, so a Back or Forward can be measured
 * (delta = arrived index - shown index) and undone with history.go(-delta).
 */
let shownIdx = 0
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

function entryIdx(): number | null {
  const idx = (history.state as { smIdx?: unknown } | null)?.smIdx
  return typeof idx === "number" ? idx : null
}

function stampEntry(idx: number) {
  history.replaceState({ ...(history.state as object | null), smIdx: idx }, "")
}

function show(hash: string) {
  committedHash = hash
  for (const listener of listeners) listener()
}

/** An in-app move: a new history entry, or replace the shown one. No events fire. */
function movePlace(hash: string, replace: boolean) {
  if (replace) history.replaceState({ smIdx: shownIdx }, "", hash)
  else history.pushState({ smIdx: ++shownIdx }, "", hash)
  show(hash)
}

/**
 * Accept the entry the browser is on now. An entry without an index is new
 * (a typed hash or a hash link), so it comes right after the shown one.
 */
function adoptEntry() {
  const idx = entryIdx() ?? shownIdx + 1
  if (entryIdx() !== idx) stampEntry(idx)
  shownIdx = idx
  show(window.location.hash)
}

interface OwnMove {
  /** where the move lands: the hash and the entry index (null = no index) */
  hash: string
  idx: number | null
  done: () => void
  timer: number
}

/** Set while the app itself moves through history; its events are not user moves. */
let ownMove: OwnMove | null = null

function moveBy(delta: number, to: { hash: string; idx: number | null }, done: () => void) {
  // Give up waiting if the browser does not move (it should always move).
  const timer = window.setTimeout(() => {
    if (ownMove?.timer === timer) ownMove = null
  }, 2000)
  ownMove = { ...to, done, timer }
  history.go(delta)
}

// Back/forward, typed hashes and hash links change the URL first. While the
// editor is dirty, undo the move (history.go(-delta)) so the entries stay as
// they were, then ask; on Discard, replay it (history.go(delta)).
function onHistoryChange() {
  const hash = window.location.hash
  const idx = entryIdx()
  if (ownMove) {
    // A late hashchange of the user's move can come before our move lands.
    if (hash !== ownMove.hash || idx !== ownMove.idx) return
    const { done, timer } = ownMove
    ownMove = null
    window.clearTimeout(timer)
    return done()
  }
  if (hash === committedHash && (idx === null || idx === shownIdx)) {
    if (idx === null) stampEntry(shownIdx)
    return
  }
  if (!isDirty() || !leavesEditor(getPlace(), parse(hash))) return adoptEntry()

  // An entry without an index is new (typed hash, hash link): one step ahead.
  const delta = idx === null ? 1 : idx - shownIdx
  if (delta === 0) {
    // The shown entry itself was replaced: no move to undo. Put the hash back.
    const state = history.state as unknown
    history.replaceState(state, "", committedHash)
    return confirmLeave(() => {
      history.replaceState(state, "", hash)
      adoptEntry()
    })
  }
  const back = { hash: committedHash, idx: shownIdx }
  moveBy(-delta, back, () => confirmLeave(() => moveBy(delta, { hash, idx }, adoptEntry)))
}

window.addEventListener("popstate", onHistoryChange)
// Fires after popstate for the same move; by then there is nothing to do.
window.addEventListener("hashchange", onHistoryChange)

if (entryIdx() === null) stampEntry(0)
else shownIdx = entryIdx()!

/**
 * Move to another place. Asks first when the open editor has unsaved changes.
 * Each move is a new history entry, so Back and Forward walk through places;
 * `replace` changes the shown entry instead (keyboard steps through a list).
 */
export function navigate(
  patch: Partial<Place>,
  options: { force?: boolean; replace?: boolean } = {}
) {
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
  const go = () => movePlace(hash, options.replace ?? false)
  if (options.force || !leavesEditor(current, next)) go()
  else confirmLeave(go)
}
