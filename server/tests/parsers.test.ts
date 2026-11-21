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

// Real `skills check -g` output (skills 1.9.0, this server, NO_COLOR=1), trimmed.
const USER_DELETED = [
  "Checking for skill updates…",
  "",
  "Fetching 11 sources…",
  "Checking skills from source: heygen-com/hyperframes",
  "  Skill paths changed; resolving via Git clone",
  "[SKILLS_SKILL_SKIPPED] ⚠ Skipped /tmp/skills-f1I5bz/scripts/fixtures/registry-pinned-command/SKILL.md — missing required frontmatter field(s): name, description",
  "",
  `${DIM}Warning:${RESET} The following skills from ${DIM}heygen-com/hyperframes${RESET} appear to have been deleted upstream:`,
  `  ${DIM}•${RESET} hyperframes-animation`,
  `  ${DIM}•${RESET} hyperframes-core`,
  `${DIM}Skipping deletion in non-interactive mode.${RESET}`,
  "Checking skills from source: emilkowalski/skill",
  "Checking skills from source: vercel-labs/skills",
  "✓ All global skills are up to date",
  "",
].join("\n")

// Real `skills check -p` output for a file:// git source with one skill deleted upstream.
const PROJECT_DELETED = [
  "Checking for skill updates…",
  "",
  "Updating for: Claude Code",
  "Checking 3 skill(s)…",
  "",
  "Fetching 1 source…",
  "",
  "Warning: The following skills from file:///mnt/data/tmp/sm-del/upstream.git appear to have been deleted upstream:",
  "  • gamma-skill",
  "Skipping deletion in non-interactive mode.",
  "↑ alpha-skill has an update",
  "1 project skill(s) already up to date",
  "",
  "1 skill(s) can be updated; run npx skills update to install",
  "",
].join("\n")

// checkAndPromptForDeletions prints this block before the deleted one.
const AMBIGUOUS = [
  "Checking skills from source: owner/repo",
  "",
  "Warning: Multiple current paths match these skills from owner/repo; skipping them rather than deleting or migrating the wrong skill:",
  "  • twin-skill",
  "",
  "Warning: The following skills from owner/repo appear to have been deleted upstream:",
  "  • gone-skill",
  "Skipping deletion in non-interactive mode.",
  "✓ All global skills are up to date",
].join("\n")

describe("deleted upstream", () => {
  test("user scope: the warning block lists the deleted skills with their source", () => {
    const report = parseCheckOutput(USER_DELETED)
    expect(report.deleted).toEqual([
      { name: "hyperframes-animation", source: "heygen-com/hyperframes" },
      { name: "hyperframes-core", source: "heygen-com/hyperframes" },
    ])
    expect(report.updates).toEqual([])
    expect(report.failures).toEqual([])
    expect(report.ambiguous).toEqual([])
    expect(interpretCheck("user scope", 0, USER_DELETED).error).toBeNull()
  })

  test("project scope: the source is the lock's sourceUrl; updates stay apart", () => {
    const res = interpretCheck("/p", 1, PROJECT_DELETED)
    expect(res.error).toBeNull()
    expect(res.updates).toEqual(["alpha-skill"])
    expect(res.deleted).toEqual([
      { name: "gamma-skill", source: "file:///mnt/data/tmp/sm-del/upstream.git" },
    ])
  })

  test("ambiguous skills are a separate list and never deleted ones", () => {
    const report = parseCheckOutput(AMBIGUOUS)
    expect(report.ambiguous).toEqual([{ name: "twin-skill", source: "owner/repo" }])
    expect(report.deleted).toEqual([{ name: "gone-skill", source: "owner/repo" }])
  })

  test("the list ends at the first line that is not a bullet", () => {
    const report = parseCheckOutput(
      [
        "Warning: The following skills from a/b appear to have been deleted upstream:",
        "  • one",
        "Checking skills from source: c/d",
        "• not-a-deleted-skill",
      ].join("\n")
    )
    expect(report.deleted).toEqual([{ name: "one", source: "a/b" }])
  })

  test("a skill gone from its download is not counted as a failed check", () => {
    const out = [
      "Checking skills from source: https://example.com/skills.zip",
      "  ✗ old-thing is no longer in this download",
      "",
      "Failed to update 1 skill(s)",
    ].join("\n")
    const res = interpretCheck("user scope", 1, out)
    expect(res.error).toBeNull()
    expect(res.failures).toEqual([])
    expect(res.deleted).toEqual([
      { name: "old-thing", source: "https://example.com/skills.zip" },
    ])
  })
})

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
    ).toEqual({
      updates: [],
      failures: [],
      failCount: 0,
      deleted: [],
      ambiguous: [],
      goneFromDownload: 0,
      explainsExit: false,
    })
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
    ])
    // Gone from its download: deleted upstream, not a failed check.
    expect(report.deleted).toEqual([
      { name: "old-thing", source: "https://example.com/skills.zip" },
    ])
    expect(report.goneFromDownload).toBe(1)
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
    // 3 failed in the CLI's count, one of them gone from its download (deleted upstream).
    expect(res.error).toBe("user scope: 2 skills could not be checked")
    expect(res.updates).toEqual(["animate"])
    expect(res.failures).toHaveLength(2)
    expect(res.deleted).toHaveLength(1)
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
