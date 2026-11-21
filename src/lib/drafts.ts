// Drafts of open documents, kept outside React so they survive a remount.
//
// Crossing the 768px breakpoint (a phone rotating, a window resize) swaps the
// phone screens for the desktop panels. The editor of a document can unmount
// without a leave (the phone skill screen has no editor), and a new one can
// mount while a save of the old one is still running. So the draft, the
// version it is based on and a running save live here, keyed by document,
// and every editor of that document reads them from here.
//
// The leave guard (lib/unsaved.ts) asks before navigation while any draft is
// dirty, mounted or not. An accepted leave discards them all.
//
// Plain TS, no DOM or React: unit-tested with bun test.

/** A version of a file on disk (FileContent in the API contract). */
export interface Version {
  content: string
  hash: string
  mtimeMs: number
  /**
   * requestGeneration() taken right before the fetch that loaded this version
   * was sent. Tells a response that may predate a save (obsolete) from the
   * state of the disk after it. Unset: unknown, judged by hash (see isObsolete).
   */
  generation?: number
}

let clock = 0

/**
 * A number from one clock shared by fetches and saves. Take it right before
 * sending a document fetch and put it on the loaded Version.
 */
export function requestGeneration(): number {
  return ++clock
}

export interface DraftState {
  /** the version on disk the draft started from */
  base: Version
  /** what the editor shows */
  content: string
  /** set while a save runs: what it writes, and the hash it expects on disk */
  saving: SaveStart | null
  /** the last save found the file changed on disk, or the draft is stale */
  conflict: boolean
}

export interface SaveStart {
  content: string
  baseHash: string
}

/** The last save that landed, to judge responses that arrive after it. */
interface LastSave {
  /** requestGeneration() when the save response arrived: fetches sent later see it on disk */
  generation: number
  /** the base the save replaced: what a fetch sent before it can still bring back */
  replacedHash: string
}

interface Entry extends DraftState {
  lastSave: LastSave | null
  /** editors showing this document now */
  mounts: number
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The state of one document, or undefined. Same object until it changes. */
export function getDraft(key: string): DraftState | undefined {
  return entries.get(key)
}

export function isDraftDirty(state: DraftState | undefined): boolean {
  return !!state && state.content !== state.base.content
}

/** Some document has edits that are not on disk. */
export function hasDirtyDrafts(): boolean {
  for (const entry of entries.values()) if (isDraftDirty(entry)) return true
  return false
}

function update(key: string, patch: Partial<Entry>) {
  const entry = entries.get(key)
  if (!entry) return
  const next = { ...entry, ...patch }
  // Nobody shows it and there is nothing to keep: forget it.
  if (next.mounts <= 0 && !isDraftDirty(next) && !next.saving) entries.delete(key)
  else entries.set(key, next)
  emit()
}

/**
 * A loaded version that says nothing about the disk now: it was fetched
 * before the last save landed, so the save replaced it. Without a generation,
 * only the base that save replaced counts as obsolete (the cached version an
 * editor still holds while the refetch runs). Any other version is the disk
 * now, including a rollback to a version this draft had before.
 */
function isObsolete(entry: Entry, file: Version): boolean {
  const save = entry.lastSave
  if (!save) return false
  if (file.generation !== undefined) return file.generation < save.generation
  return file.hash === save.replacedHash
}

/**
 * What a loaded version that differs from the base means for the draft:
 * "keep" (it predates a save, or a save runs and its answer decides),
 * "adopt" (the disk changed and the draft is clean) or "conflict" (the disk
 * changed under unsaved edits).
 */
function judge(entry: Entry, file: Version): "keep" | "adopt" | "conflict" {
  if (file.hash === entry.base.hash || entry.saving || isObsolete(entry, file)) return "keep"
  return isDraftDirty(entry) ? "conflict" : "adopt"
}

/**
 * The document an editor is about to show, with `file` as loaded now. A kept
 * draft is restored when `file` is its base, or a version its last save
 * replaced. A draft based on another version is stale: the file changed on
 * disk meanwhile. It is kept and marked as a conflict, so the editor asks
 * (reload or overwrite) instead of dropping the edits silently.
 * Idempotent: safe to call from a React state initializer.
 */
export function openDraft(key: string, file: Version): DraftState {
  const entry = entries.get(key)
  if (!entry) {
    const fresh: Entry = {
      base: file,
      content: file.content,
      saving: null,
      conflict: false,
      lastSave: null,
      mounts: 0,
    }
    entries.set(key, fresh)
    return fresh
  }
  if (entry.conflict) return entry
  const verdict = judge(entry, file)
  if (verdict === "keep") return entry
  // Nothing to lose: start over from the file as loaded. Or keep the edits and ask.
  const next: Entry =
    verdict === "adopt" ? { ...entry, base: file, content: file.content } : { ...entry, conflict: true }
  entries.set(key, next)
  return next
}

/**
 * An editor shows the document (call it on mount, after openDraft). Returns
 * the release for its unmount. A clean document is forgotten once no editor
 * shows it, so a remount (React StrictMode) opens it again from `file`.
 */
export function retainDraft(key: string, file: Version): () => void {
  if (!entries.has(key)) {
    openDraft(key, file)
    emit()
  }
  // The count is not part of DraftState: change it in place, so the snapshot
  // editors hold stays the same object.
  entries.get(key)!.mounts++
  let released = false
  return () => {
    if (released) return
    released = true
    const current = entries.get(key)
    if (!current) return
    current.mounts--
    if (current.mounts <= 0 && !isDraftDirty(current) && !current.saving) entries.delete(key)
  }
}

export function editDraft(key: string, content: string) {
  const entry = entries.get(key)
  if (entry && entry.content !== content) update(key, { content })
}

/**
 * A version was loaded (a refetch, or Reload after a conflict). Without
 * options it becomes the base and the content. With `keepDraft` (a refetch),
 * a version that predates the last save is ignored; a newer one replaces a
 * clean document, and under unsaved edits it raises the conflict.
 */
export function rebaseDraft(key: string, file: Version, options: { keepDraft?: boolean } = {}) {
  const entry = entries.get(key)
  if (!entry) return
  if (options.keepDraft) {
    const verdict = judge(entry, file)
    if (verdict === "keep") return
    if (verdict === "conflict") {
      if (!entry.conflict) update(key, { conflict: true })
      return
    }
  }
  update(key, { base: file, content: file.content, conflict: false })
}

/** Starts a save of the current content. Null when one is running already. */
export function beginSave(key: string): SaveStart | null {
  const entry = entries.get(key)
  if (!entry || entry.saving) return null
  const start = { content: entry.content, baseHash: entry.base.hash }
  update(key, { saving: start })
  return start
}

/**
 * The save wrote `start.content`: that is the new base. The draft stays
 * dirty only if it was edited after the save started. Call it as soon as the
 * save response arrives, before anything refetches the document: fetches sent
 * after this call count as the disk after the save.
 */
export function finishSave(key: string, start: SaveStart, saved: { hash: string; mtimeMs: number }) {
  const entry = entries.get(key)
  if (!entry || entry.saving !== start) return
  update(key, {
    base: { content: start.content, hash: saved.hash, mtimeMs: saved.mtimeMs },
    lastSave: { generation: requestGeneration(), replacedHash: start.baseHash },
    saving: null,
    conflict: false,
  })
}

export function failSave(key: string, start: SaveStart, options: { conflict: boolean }) {
  const entry = entries.get(key)
  if (!entry || entry.saving !== start) return
  update(key, { saving: null, conflict: options.conflict || entry.conflict })
}

export function setDraftConflict(key: string, conflict: boolean) {
  if (entries.get(key)?.conflict !== conflict) update(key, { conflict })
}

/**
 * The user agreed to throw away unsaved edits: every draft goes back to the
 * version on disk. A running save still lands, so its content counts as on
 * disk already.
 */
export function discardDrafts() {
  let changed = false
  for (const [key, entry] of [...entries]) {
    const clean = entry.saving ? entry.saving.content : entry.base.content
    if (entry.content === clean && !entry.conflict) continue
    changed = true
    const next = { ...entry, content: clean, conflict: false }
    if (next.mounts <= 0 && !next.saving) entries.delete(key)
    else entries.set(key, next)
  }
  if (changed) emit()
}

/** For tests. */
export function resetDrafts() {
  entries.clear()
  emit()
}
