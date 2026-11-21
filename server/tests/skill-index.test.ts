import { describe, expect, test } from "bun:test"
import { dedupe, type IndexedSkill } from "../discovery/skill-index.ts"

function skill(scope: string, location: string): IndexedSkill {
  return {
    id: "id",
    name: "shared",
    description: "",
    realPath: "/home/u/.agents/skills/shared",
    locations: [location],
    agents: [scope === "user" ? "claude-code" : "codex"],
    scope,
    scopes: [scope],
    origin: "npx",
    editable: true,
    cliName: "shared",
    folderName: "shared",
    placements: [{ path: location, root: location, scope, deletable: true }],
  }
}

describe("dedupe", () => {
  test("keeps the first scope as owner and merges scope membership", () => {
    const [merged, ...rest] = dedupe([
      skill("user", "/home/u/.agents/skills/shared"),
      skill("/home/u/proj", "/home/u/proj/.claude/skills/shared"),
    ])
    expect(rest).toEqual([])
    expect(merged.scope).toBe("user")
    expect(merged.scopes).toEqual(["user", "/home/u/proj"])
    expect(merged.locations).toHaveLength(2)
    expect(merged.placements.map((p) => p.scope)).toEqual([
      "user",
      "/home/u/proj",
    ])
    expect(merged.agents).toEqual(["claude-code", "codex"])
  })
})
