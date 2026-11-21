import type { RepoSkill } from "../../shared/api.ts"
import { cleanLine } from "../lib/ansi.ts"

const UPDATE_LINE = /^\s*↑\s+(.+?)\s+has an update\s*$/

/** Skill names from `skills check` output ("↑ <name> has an update"). */
export function parseCheckOutput(output: string): string[] {
  const names: string[] = []
  for (const raw of output.split("\n")) {
    const m = UPDATE_LINE.exec(cleanLine(raw))
    if (m && !names.includes(m[1])) names.push(m[1])
  }
  return names
}

/**
 * Skills from `skills add <src> --list`. After "Available Skills", clack
 * prints "│    <name>" and then "│      <description>" lines. Group titles
 * (plugins) are printed without the "│" gutter and are skipped.
 */
export function parseRepoListOutput(output: string): RepoSkill[] {
  const lines = output.split("\n").map(cleanLine)
  const start = lines.findIndex((l) => /Available Skills/.test(l))
  if (start < 0) return []
  const skills: RepoSkill[] = []
  for (const line of lines.slice(start + 1)) {
    const m = /^│(\s+)(\S.*)$/.exec(line)
    if (!m) continue
    const indent = m[1].length
    const text = m[2].trimEnd()
    if (indent <= 4) skills.push({ name: text, description: "" })
    else if (skills.length > 0 && !/^Files: \d+$/.test(text)) {
      const last = skills[skills.length - 1]
      last.description = last.description ? `${last.description} ${text}` : text
    }
  }
  return skills
}
