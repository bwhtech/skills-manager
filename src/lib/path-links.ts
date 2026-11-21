// Finds file paths and URLs in Markdown text, so the editor and the preview can open them.
// The server resolves a path (GET /api/open); this only decides what looks like one.

export interface LinkTarget {
  kind: "path" | "url"
  /** as written; a path may end in :line */
  target: string
}

export interface LinkMatch extends LinkTarget {
  /** offsets in the scanned text, `to` exclusive */
  from: number
  to: number
}

const EXTENSION =
  /\.(md|mdx|markdown|txt|rst|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|sh|bash|zsh|fish|rb|go|rs|css|scss|html?|xml|svg|csv|tsv|sql|vue|svelte|lua|php|java|kt|swift|c|h|cc|cpp|hpp|graphql|gql|lock|service|nix|tf|env)$/i
/** File names without an extension that are still files. */
const NAMES = new Set([
  "Makefile",
  "Dockerfile",
  "Caddyfile",
  "Justfile",
  "Procfile",
  "Gemfile",
  "Rakefile",
  "LICENSE",
  "README",
  "CODEOWNERS",
  ".gitignore",
  ".bashrc",
  ".zshrc",
  ".profile",
  ".npmrc",
  ".editorconfig",
])
/** http:, mailto: and the like; not "file.ts:42". */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i
const WEB_URL = /^https?:\/\//i

const INLINE_CODE = /(`+)([^`\n]+?)\1/g
const LINK_TARGET = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const BARE_URL = /https?:\/\/[^\s`'"()<>[\]{}]+/g
// ~/x, /x, ./x, ../x at the start of a word.
const BARE_PATH = /(?<=^|[\s([{"'<])(?:~|\.\.?)?\/[^\s`'"()<>[\]{}]+/g
const TRAILING = /[.,;:!?]+$/

/** A path as the server takes it: ends in a known extension or file name, no spaces, no URL. */
export function isPathLike(text: string): boolean {
  if (!text || text.length > 1024 || /\s/.test(text) || URL_SCHEME.test(text)) return false
  const path = text.replace(/#.*$/, "").replace(/(?::\d+){1,2}$/, "")
  const name = path.split("/").pop() ?? ""
  return EXTENSION.test(name) || NAMES.has(name)
}

/** What a Markdown link href leads to: a path, a web URL, or null (leave it alone). */
export function classifyHref(href: string): LinkTarget | null {
  if (WEB_URL.test(href)) return { kind: "url", target: href }
  // Check the href as written (a space is %20 there), open the decoded path.
  return isPathLike(href) ? { kind: "path", target: safeDecode(href) } : null
}

/** Paths and URLs in one line of Markdown, sorted, not overlapping. */
export function findLinks(line: string): LinkMatch[] {
  const found: LinkMatch[] = []
  const add = (from: number, text: string, target: LinkTarget | null) => {
    const to = from + text.length
    if (!target || found.some((m) => from < m.to && to > m.from)) return
    found.push({ ...target, from, to })
  }
  for (const m of line.matchAll(INLINE_CODE)) {
    const text = m[2]
    add(m.index + m[1].length, text, isPathLike(text) ? { kind: "path", target: text } : null)
  }
  for (const m of line.matchAll(LINK_TARGET)) add(m.index + 2, m[1], classifyHref(m[1]))
  for (const m of line.matchAll(BARE_URL)) {
    const text = m[0].replace(TRAILING, "")
    add(m.index, text, { kind: "url", target: text })
  }
  for (const m of line.matchAll(BARE_PATH)) {
    const text = m[0].replace(TRAILING, "")
    add(m.index, text, isPathLike(text) ? { kind: "path", target: text } : null)
  }
  return found.sort((a, b) => a.from - b.from)
}

function safeDecode(text: string) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
