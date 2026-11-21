// A line to jump to when an editor for a document mounts next, after a link
// with :line navigated there. Keyed by the document's address (docAddress in features/open).

let pending: { key: string; line: number; at: number } | null = null

/** Remember the line for the editor that mounts with this key soon. */
export function setPendingLine(key: string, line: number | undefined) {
  pending = line ? { key, line, at: Date.now() } : null
}

/** The line for this editor, once. Stale after a few seconds (the move was cancelled). */
export function takePendingLine(key: string): number | undefined {
  if (!pending || pending.key !== key) return undefined
  const { line, at } = pending
  pending = null
  return Date.now() - at < 5000 ? line : undefined
}
