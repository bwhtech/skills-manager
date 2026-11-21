import { describe, expect, test } from "bun:test"
import type { SkillSummary } from "@shared/api"
import { cliNameOf, groupBySource, sameSource, skillForCliName } from "./upstream"

function skill(partial: Partial<SkillSummary>): SkillSummary {
  return {
    id: partial.realPath ?? "id",
    name: "x",
    description: "",
    realPath: "/home/u/.claude/skills/x",
    locations: [],
    agents: [],
    scope: "user",
    scopes: ["user"],
    origin: "npx",
    editable: true,
    removable: true,
    updateAvailable: false,
    ...partial,
  }
}

describe("CLI names", () => {
  // Folder and lock key foo-bar, frontmatter name "Foo Bar": they differ by more than case.
  const alias = skill({ name: "Foo Bar", cliName: "foo-bar", realPath: "/home/u/.claude/skills/foo-bar" })

  test("cliNameOf uses the lock key, else the display name", () => {
    expect(cliNameOf(alias)).toBe("foo-bar")
    expect(cliNameOf(skill({ name: "plain" }))).toBe("plain")
  })

  test("a CLI-reported name finds its skill even when the display name differs", () => {
    expect(skillForCliName([alias], "user", "foo-bar")).toBe(alias)
    expect(skillForCliName([alias], "user", "Foo Bar")).toBeNull()
    expect(skillForCliName([alias], "/p", "foo-bar")).toBeNull()
  })

  test("prefers the .agents/skills copy, where the CLI installs", () => {
    const agents = skill({ ...alias, realPath: "/home/u/.agents/skills/foo-bar" })
    expect(skillForCliName([alias, agents], "user", "foo-bar")).toBe(agents)
  })
})

describe("sources", () => {
  test("project skills match on the sourceUrl the CLI prints", () => {
    const s = skill({ scope: "/p", source: { source: "owner/repo", sourceUrl: "https://github.com/owner/repo.git" } })
    expect(sameSource({ scope: "/p", name: "a", source: "https://github.com/owner/repo.git" }, s)).toBe(true)
    expect(sameSource({ scope: "/p", name: "a", source: "other/repo" }, s)).toBe(false)
    expect(sameSource({ scope: "user", name: "a", source: "owner/repo" }, s)).toBe(false)
  })

  test("groupBySource keeps first-seen order", () => {
    const groups = groupBySource([
      { source: "a", name: "1" },
      { source: "b", name: "2" },
      { source: "a", name: "3" },
    ])
    expect(groups.map((g) => [g.source, g.items.map((i) => i.name)])).toEqual([
      ["a", ["1", "3"]],
      ["b", ["2"]],
    ])
  })
})
