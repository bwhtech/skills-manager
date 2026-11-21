import { describe, expect, test } from "bun:test"
import { cleanLine, LineSplitter } from "../lib/ansi.ts"
import { parseCheckOutput, parseRepoListOutput } from "../cli/parsers.ts"

describe("parseCheckOutput", () => {
  test("collects names from update lines and ignores the rest", () => {
    const out = [
      "Checking for skill updates…",
      "Checking skills from source: emilkowalski/skill",
      "\x1b[38;5;145m↑ animate has an update\x1b[0m",
      "↑ hyperframes-cli has an update",
      "✎ local-thing has local changes",
      "↑ animate has an update",
      "2 skill(s) can be updated; run npx skills update to install",
    ].join("\n")
    expect(parseCheckOutput(out)).toEqual(["animate", "hyperframes-cli"])
  })

  test("nothing to update", () => {
    expect(
      parseCheckOutput(
        "Checking for skill updates…\n✓ All skills are up to date\n"
      )
    ).toEqual([])
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
