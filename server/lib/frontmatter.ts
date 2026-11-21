export interface Frontmatter {
  data: Record<string, unknown>
  body: string
  hasFrontmatter: boolean
  /** set when the YAML did not parse; data then holds a best-effort result */
  error?: string
}

const BLOCK = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/** Split a Markdown file into YAML frontmatter data and body. */
export function parseFrontmatter(text: string): Frontmatter {
  const match = BLOCK.exec(text)
  if (!match) return { data: {}, body: text, hasFrontmatter: false }
  const yaml = match[1] ?? ""
  const body = text.slice(match[0].length)
  try {
    const parsed: unknown = Bun.YAML.parse(yaml)
    return {
      data: isPlainObject(parsed) ? parsed : {},
      body,
      hasFrontmatter: true,
    }
  } catch (err) {
    return {
      data: parseFlatYaml(yaml),
      body,
      hasFrontmatter: true,
      error: (err as Error).message,
    }
  }
}

/** A string field of the frontmatter, trimmed, or "" when missing or not text. */
export function stringField(
  data: Record<string, unknown>,
  key: string
): string {
  const value = data[key]
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  return ""
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Fallback for broken YAML: top-level `key: value` lines only.
function parseFlatYaml(yaml: string): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line)
    if (!m) continue
    data[m[1]] = unquote(m[2].trim())
  }
  return data
}

function unquote(value: string): string {
  const q = value[0]
  if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2)
    return value.slice(1, -1)
  return value
}
