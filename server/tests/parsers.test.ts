import { describe, expect, test } from "bun:test"
import { cleanLine, LineSplitter } from "../lib/ansi.ts"
import { parseCheckOutput, parseRepoListOutput } from "../cli/parsers.ts"
import { interpretCheck } from "../updates.ts"

const DIM = "\x1b[38;5;102m"
const TEXT = "\x1b[38;5;145m"
const RESET = "\x1b[0m"

// Shapes taken from skills 1.9.0 dist/cli.mjs (runUpdate in "check" mode).
const UPDATES_ONLY = [
  `${TEXT}Checking for skill updates…${RESET}`,
  "",
  `${DIM}Fetching 1 source…${RESET}`,
  `\x1b[2K\r${DIM}Checking skills from source: emilkowalski/skill${RESET}`,
  `${TEXT}↑ animate has an update${RESET}`,
  "↑ hyperframes-cli has an update",
  "↑ animate has an update",
  "",
  `${TEXT}2 skill(s) can be updated; run \x1b[1mnpx skills update${RESET}${TEXT} to install${RESET}`,
].join("\n")

const WITH_FAILURES = [
  "Checking for skill updates…",
  "",
  "Fetching 3 sources…",
  "Checking skills from source: owner/private-repo",
  `  ${DIM}✗ Failed to check skills from owner/private-repo${RESET}`,
  "Checking skills from source: https://example.com/skills.zip",
  `  ${DIM}✗ Failed to check skills from https://example.com/skills.zip: HTTP 404${RESET}`,
  `  ${DIM}✗ old-thing is no longer in this download${RESET}`,
  "↑ animate has an update",
  "",
  `${DIM}Failed to update 3 skill(s)${RESET}`,
  "1 skill(s) can be updated; run npx skills update to install",
].join("\n")

const PROJECT_FAILURES = [
  "Checking for skill updates…",
  "Checking 2 skill(s)…",
  `${DIM}✗ Failed to check for deleted skills from vercel-labs/agent-skills${RESET}`,
  `${DIM}✗ Cannot update gitlab.example.com/team/skills: skills-lock.json is missing sourceUrl for this generic Git source${RESET}`,
  "✎ local-thing has local changes",
  "",
  "Failed to update 2 skill(s)",
  "1 skill(s) differ from skills-lock.json; run npx skills install --force to restore them",
].join("\n")

describe("parseCheckOutput", () => {
  test("collects names from update lines and ignores the rest", () => {
    const report = parseCheckOutput(UPDATES_ONLY)
    expect(report.updates).toEqual(["animate", "hyperframes-cli"])
    expect(report.failures).toEqual([])
    expect(report.explainsExit).toBe(true)
  })

  test("nothing to update", () => {
    expect(
      parseCheckOutput(
        "Checking for skill updates…\n✓ All global skills are up to date\n"
      )
    ).toEqual({ updates: [], failures: [], failCount: 0, explainsExit: false })
  })

  test("reads failed checks apart from updates", () => {
    const report = parseCheckOutput(WITH_FAILURES)
    expect(report.updates).toEqual(["animate"])
    expect(report.failCount).toBe(3)
    expect(report.failures).toEqual([
      {
        name: "owner/private-repo",
        reason: "could not fetch or read the source",
      },
      { name: "https://example.com/skills.zip", reason: "HTTP 404" },
      { name: "old-thing", reason: "no longer in its download source" },
    ])
  })

  test("project failures and the Error: line", () => {
    expect(parseCheckOutput(PROJECT_FAILURES).failures).toEqual([
      {
        name: "vercel-labs/agent-skills",
        reason: "could not fetch or read the source",
      },
      {
        name: "gitlab.example.com/team/skills",
        reason:
          "skills-lock.json is missing sourceUrl for this generic Git source",
      },
    ])
    expect(
      parseCheckOutput("Error: Invalid skills-lock.json").failures
    ).toEqual([{ name: "skills check", reason: "Invalid skills-lock.json" }])
  })
})

describe("interpretCheck", () => {
  test("exit 1 with updates only is not an error", () => {
    const res = interpretCheck("user scope", 1, UPDATES_ONLY)
    expect(res.error).toBeNull()
    expect(res.updates).toEqual(["animate", "hyperframes-cli"])
  })

  test("exit 1 with failed checks sets an error and keeps the updates", () => {
    const res = interpretCheck("user scope", 1, WITH_FAILURES)
    expect(res.error).toBe("user scope: 3 skills could not be checked")
    expect(res.updates).toEqual(["animate"])
    expect(res.failures).toHaveLength(3)
  })

  test("exit 0 with a failed source still reports it", () => {
    const out = [
      "Checking skills from source: owner/gone",
      "  ✗ Failed to check skills from owner/gone",
      "✓ All global skills are up to date",
    ].join("\n")
    const res = interpretCheck("user scope", 0, out)
    expect(res.error).toBe("user scope: 1 source could not be checked")
    expect(res.failures).toEqual([
      { name: "owner/gone", reason: "could not fetch or read the source" },
    ])
  })

  test("exit 1 that no summary line explains is an error", () => {
    const res = interpretCheck("/p", 1, "Checking…\nTypeError: boom\n")
    expect(res.error).toBe("/p: skills check exited with 1: TypeError: boom")
  })

  test("other exit codes are errors", () => {
    expect(interpretCheck("/p", 2, "").error).toBe(
      "/p: skills check exited with 2"
    )
  })
})

describe("parseRepoListOutput", () => {
  test("reads names and descriptions after Available Skills", () => {
    const out = [
      "◇  Found 2 skills",
      "│",
      "◇  Available Skills",
      "│",
      "│    deploy-to-vercel",
      "│",
      "│      Deploy apps to Vercel.",
      "│",
      "Core Skills",
      "│    web-design-guidelines",
      "│",
      "│      Review UI code.",
      "│      Second line.",
      "│      Files: 3",
      "",
      "└  Use --skill <name> to install specific skills",
    ].join("\n")
    expect(parseRepoListOutput(out)).toEqual([
      { name: "deploy-to-vercel", description: "Deploy apps to Vercel." },
      {
        name: "web-design-guidelines",
        description: "Review UI code. Second line.",
      },
    ])
  })

  test("no list header gives no skills", () => {
    expect(parseRepoListOutput("Error: repo not found")).toEqual([])
  })
})

describe("line cleaning", () => {
  test("keeps only the last spinner frame", () => {
    expect(
      cleanLine(
        "◒  Fetching…\x1b[1G\x1b[J◐  Fetching…\x1b[1G\x1b[J◇  Found 9 skills"
      )
    ).toBe("◇  Found 9 skills")
    expect(cleanLine("50%\r100%")).toBe("100%")
    expect(cleanLine("\x1b[?25l│\x1b[?25h")).toBe("│")
  })

  test("splitter joins chunks and splits on newlines", () => {
    const lines: string[] = []
    const s = new LineSplitter((l) => lines.push(l))
    const enc = new TextEncoder()
    s.push(enc.encode("one\ntw"))
    s.push(enc.encode("o\n✓ thr"))
    s.push(enc.encode("ee"))
    s.flush()
    expect(lines).toEqual(["one", "two", "✓ three"])
  })
})
