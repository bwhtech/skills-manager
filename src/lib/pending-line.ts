// A line to show in a document's editor, after a link with :line led there.
// Keyed by the document's address (docAddress in features/open). A mounted
// editor for that key takes the request at once; otherwise the editor that
// mounts next for it does. Set a request only once the move is accepted, so a
// cancelled move never leaves one behind.

let pending: { key: string; line: number } | null = null
const editors = new Map<string, Set<() => void>>()

/** Ask the editor for `key` to show `line`. Replaces any older request; no line clears it. */
export function requestLine(key: string, line: number | undefined) {
  pending = line ? { key, line } : null
  if (pending) for (const onRequest of editors.get(key) ?? []) onRequest()
}

/** The requested line for this editor, once. */
export function takePendingLine(key: string): number | undefined {
  if (!pending || pending.key !== key) return undefined
  const { line } = pending
  pending = null
  return line
}

/** A mounted editor hears each request for its key (then takes it). Returns the unsubscribe function. */
export function subscribeLineRequests(key: string, onRequest: () => void): () => void {
  const set = editors.get(key) ?? new Set()
  editors.set(key, set.add(onRequest))
  return () => {
    set.delete(onRequest)
    if (!set.size && editors.get(key) === set) editors.delete(key)
  }
}

/** Whether an editor for this key is mounted, so a line request needs no navigation. */
export function hasLineEditor(key: string): boolean {
  return editors.has(key)
}
