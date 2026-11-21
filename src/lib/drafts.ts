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

interface Entry extends DraftState {
  /** hashes this draft was based on: its first base, then each save */
  lineage: string[]
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
 * The document an editor is about to show, with `file` as loaded now. A kept
 * draft is restored when `file` is a version it was based on (its first base
 * or one of its saves). A draft based on another version is stale: the file
 * changed on disk meanwhile. It is kept and marked as a conflict, so the
 * editor asks (reload or overwrite) instead of dropping the edits silently.
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
      lineage: [file.hash],
      mounts: 0,
    }
    entries.set(key, fresh)
    return fresh
  }
  if (entry.lineage.includes(file.hash) || entry.conflict) return entry
  if (!isDraftDirty(entry) && !entry.saving) {
    // Nothing to lose: start over from the file as loaded.
    const fresh: Entry = { ...entry, base: file, content: file.content, lineage: [file.hash] }
    entries.set(key, fresh)
    return fresh
  }
  const stale: Entry = { ...entry, conflict: true }
  entries.set(key, stale)
  return stale
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
 * A newer version was loaded (a refetch, or Reload after a conflict). Takes it
 * as the base and the content; with `keepDraft`, only when nothing is lost.
 */
export function rebaseDraft(key: string, file: Version, options: { keepDraft?: boolean } = {}) {
  const entry = entries.get(key)
  if (!entry) return
  if (options.keepDraft) {
    if (isDraftDirty(entry) || entry.saving || entry.lineage.includes(file.hash)) return
  }
  update(key, {
    base: file,
    content: file.content,
    lineage: [...entry.lineage, file.hash],
    conflict: false,
  })
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
 * dirty only if it was edited after the save started.
 */
export function finishSave(key: string, start: SaveStart, saved: { hash: string; mtimeMs: number }) {
  const entry = entries.get(key)
  if (!entry || entry.saving !== start) return
  update(key, {
    base: { content: start.content, hash: saved.hash, mtimeMs: saved.mtimeMs },
    lineage: [...entry.lineage, saved.hash],
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
