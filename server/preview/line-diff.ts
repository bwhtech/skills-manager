export interface LineCounts {
  linesAdded: number
  linesRemoved: number
}

/** Above this edit distance, fall back to a cheaper count (see multisetCounts). */
const MAX_EDIT_DISTANCE = 4000

/**
 * Lines added and removed between two texts, from the shortest edit script
 * (Myers). The UI renders the real diff; this only feeds the counts.
 */
export function countLineChanges(before: string, after: string): LineCounts {
  const [a, b] = toLineIds(splitLines(before), splitLines(after))
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  if (x.length === 0 || y.length === 0)
    return { linesAdded: y.length, linesRemoved: x.length }
  const d = editDistance(x, y, MAX_EDIT_DISTANCE)
  if (d === null) return multisetCounts(x, y)
  // In a shortest script, inserts - deletes = |y| - |x| and inserts + deletes = d.
  const delta = y.length - x.length
  return { linesAdded: (d + delta) / 2, linesRemoved: (d - delta) / 2 }
}

/** Lines of a text; a trailing newline does not start an extra line. */
export function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** Myers' O((N+M)D) search for D, the number of inserts plus deletes. */
function editDistance(a: number[], b: number[], max: number): number | null {
  const n = a.length
  const m = b.length
  const limit = Math.min(max, n + m)
  const offset = limit + 1
  const v = new Int32Array(2 * limit + 3)
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
      let x = down ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return d
    }
  }
  return null
}

/** Lines with no partner on the other side, ignoring order. A lower bound. */
function multisetCounts(a: number[], b: number[]): LineCounts {
  const counts = new Map<number, number>()
  for (const id of a) counts.set(id, (counts.get(id) ?? 0) + 1)
  let common = 0
  for (const id of b) {
    const left = counts.get(id) ?? 0
    if (left > 0) {
      counts.set(id, left - 1)
      common++
    }
  }
  return { linesAdded: b.length - common, linesRemoved: a.length - common }
}

function toLineIds(a: string[], b: string[]): [number[], number[]] {
  const ids = new Map<string, number>()
  const id = (line: string) => {
    let value = ids.get(line)
    if (value === undefined) {
      value = ids.size
      ids.set(line, value)
    }
    return value
  }
  return [a.map(id), b.map(id)]
}
