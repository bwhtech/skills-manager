import type { RepoSkill } from "../../shared/api.ts"
import { cleanLine } from "../lib/ansi.ts"

const UPDATE_LINE = /^↑\s+(.+?)\s+has an update$/
const FAIL_COUNT = /^Failed to update (\d+) skill\(s\)$/
// Summary lines that come with exit code 1 when nothing failed.
const EXIT_ONE = [
  /^\d+ skill\(s\) can be updated/,
  /^\d+ skill\(s\) differ from skills-lock\.json/,
]
// "✗ ..." lines that `skills check` (skills 1.9.0) prints when a check fails.
const FAILURES: [RegExp, (m: RegExpExecArray) => CheckFailure][] = [
  [
    /^✗ Failed to check skills from (\S+): (.+)$/,
    (m) => ({ name: m[1], reason: m[2] }),
  ],
  [
    /^✗ Failed to check skills from (\S+)$/,
    (m) => ({ name: m[1], reason: "could not fetch or read the source" }),
  ],
  [
    /^✗ Failed to check for deleted skills from (\S+)$/,
    (m) => ({ name: m[1], reason: "could not fetch or read the source" }),
  ],
  [/^✗ Cannot update (\S+): (.+)$/, (m) => ({ name: m[1], reason: m[2] })],
  [
    /^✗ (.+?) is no longer in this download$/,
    (m) => ({ name: m[1], reason: "no longer in its download source" }),
  ],
  [/^✗ (.+)$/, (m) => ({ name: m[1], reason: "check failed" })],
  [/^Error: (.+)$/, (m) => ({ name: "skills check", reason: m[1] })],
]

export interface CheckFailure {
  /** a skill source (owner/repo, URL) or a skill name, as the CLI prints it */
  name: string
  reason: string
}

export interface CheckReport {
  /** skill names with an update */
  updates: string[]
  failures: CheckFailure[]
  /** from "Failed to update N skill(s)"; 0 when the line is missing */
  failCount: number
  /** a summary line explains exit code 1 (updates, local changes, failures) */
  explainsExit: boolean
}

/**
 * Reads `skills check` output. The CLI exits 1 both when updates are
 * available and when checks fail (it prints "Failed to update N skill(s)"
 * for failed checks), so callers must look at `failures`, not the exit code.
 * Some failures (an unreachable GitHub source in user scope) print a "✗"
 * line but keep exit code 0.
 */
export function parseCheckOutput(output: string): CheckReport {
  const report: CheckReport = {
    updates: [],
    failures: [],
    failCount: 0,
    explainsExit: false,
  }
  for (const raw of output.split("\n")) {
    const line = cleanLine(raw).trim()
    if (!line) continue
    const update = UPDATE_LINE.exec(line)
    if (update) {
      if (!report.updates.includes(update[1])) report.updates.push(update[1])
      continue
    }
    const count = FAIL_COUNT.exec(line)
    if (count) {
      report.failCount = Number(count[1])
      report.explainsExit = true
      continue
    }
    if (EXIT_ONE.some((re) => re.test(line))) {
      report.explainsExit = true
      continue
    }
    const failure = parseFailure(line)
    if (failure) report.failures.push(failure)
  }
  if (report.failures.length > 0) report.explainsExit = true
  return report
}

function parseFailure(line: string): CheckFailure | null {
  for (const [re, build] of FAILURES) {
    const m = re.exec(line)
    if (m) return build(m)
  }
  return null
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
