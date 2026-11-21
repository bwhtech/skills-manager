// A small reader for SKILL.md frontmatter. It handles the flat key/value
// YAML that skills use (plain, quoted and block scalars). Nested values are
// kept as raw text.

export interface Frontmatter {
  /** raw YAML between the --- lines */
  yaml: string
  entries: [key: string, value: string][]
}

export interface SplitDocument {
  frontmatter: Frontmatter | null
  /** text after the frontmatter */
  body: string
}

const OPEN = /^\uFEFF?---[ \t]*\r?\n/
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/m

export function splitFrontmatter(text: string): SplitDocument {
  const open = OPEN.exec(text)
  if (!open) return { frontmatter: null, body: text }
  const rest = text.slice(open[0].length)
  const close = CLOSE.exec(rest)
  if (!close) return { frontmatter: null, body: text }
  const yaml = rest.slice(0, close.index)
  const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, "")
  return { frontmatter: { yaml, entries: parseEntries(yaml) }, body }
}

const KEY = /^([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]+(.*))?$/

function parseEntries(yaml: string): [string, string][] {
  const lines = yaml.split(/\r?\n/)
  const entries: [string, string][] = []
  for (let i = 0; i < lines.length; i++) {
    const match = KEY.exec(lines[i])
    if (!match) continue
    const [, key, inline = ""] = match
    const block: string[] = []
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) {
      block.push(lines[++i])
    }
    entries.push([key, scalar(inline.trim(), dedent(block))])
  }
  return entries
}

function dedent(lines: string[]) {
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length)
  )
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
}

function scalar(inline: string, block: string[]) {
  const value = stripComment(inline)
  if (/^[|>][+-]?\d*$/.test(value)) {
    return value.startsWith(">") ? foldLines(block) : block.join("\n")
  }
  if (value === "") return block.join("\n")
  const continued = block.length ? `${value} ${block.map((l) => l.trim()).join(" ")}` : value
  return unquote(continued)
}

function foldLines(lines: string[]) {
  return lines
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, " "))
    .join("\n")
}

function stripComment(value: string) {
  if (/^["']/.test(value)) return value
  return value.replace(/\s+#.*$/, "")
}

function unquote(value: string) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** Problems with a SKILL.md, in the order a reader should fix them. */
export function validateSkillMd(text: string, folderName: string): string[] {
  const { frontmatter } = splitFrontmatter(text)
  if (!frontmatter) return ["No frontmatter. Start the file with a --- block."]
  const data = new Map(frontmatter.entries)
  const problems: string[] = []
  const name = data.get("name")?.trim()
  if (!name) problems.push("Frontmatter needs a name.")
  else if (name !== folderName) {
    problems.push(`name "${name}" does not match the folder name "${folderName}".`)
  }
  if (!data.get("description")?.trim()) problems.push("Frontmatter needs a description.")
  return problems
}
