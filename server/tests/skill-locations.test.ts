import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentRegistry } from "../discovery/agents.ts"
import { isRemovable } from "../discovery/skill-index.ts"
import {
  SkillLocator,
  isDotProjectDir,
} from "../discovery/skill-locations.ts"

const base = await realpath(await mkdtemp(join(tmpdir(), "skills-loc-")))
afterAll(() => rm(base, { recursive: true, force: true }))

async function skillDir(path: string) {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, "SKILL.md"), "---\nname: x\n---\n")
}

const agents = {
  projectDirs: () =>
    new Map([
      [".claude/skills", ["claude-code"]],
      [".agents/skills", ["codex"]],
      ["skills", ["openclaw"]],
      ["data/skills", ["astrbot"]],
      ["agent/skills", ["eve"]],
    ]),
  isDetected: () => true,
  pickVisible: (ids: string[]) => ids,
} as unknown as AgentRegistry

describe("deletable skills dirs", () => {
  test("isDotProjectDir looks at the first path segment", () => {
    expect(isDotProjectDir(".claude/skills")).toBe(true)
    expect(isDotProjectDir(".agents/skills")).toBe(true)
    expect(isDotProjectDir("skills")).toBe(false)
    expect(isDotProjectDir("data/skills")).toBe(false)
    expect(isDotProjectDir("agent/.skills")).toBe(false)
    expect(isDotProjectDir("./skills")).toBe(false)
    expect(isDotProjectDir("../skills")).toBe(false)
  })

  test("source folders in generic project dirs are visible but not removable", async () => {
    const project = join(base, "crm")
    for (const rel of [
      ".claude/skills/mine",
      ".agents/skills/shared",
      "skills/frappe-crm",
      "data/skills/astr",
      "agent/skills/eve",
    ])
      await skillDir(join(project, rel))

    const locations = await new SkillLocator(agents).project(project)
    const byPath = Object.fromEntries(
      locations.map((l) => [l.path.slice(project.length + 1), l.deletable])
    )
    expect(byPath).toEqual({
      ".claude/skills/mine": true,
      ".agents/skills/shared": true,
      "skills/frappe-crm": false,
      "data/skills/astr": false,
      "agent/skills/eve": false,
    })

    const placement = (deletable: boolean) => ({
      path: "/p/x",
      root: "/p",
      scope: project,
      deletable,
    })
    expect(isRemovable({ origin: "manual", placements: [placement(false)] })).toBe(false)
    expect(
      isRemovable({
        origin: "manual",
        placements: [placement(false), placement(true)],
      })
    ).toBe(true)
    expect(isRemovable({ origin: "npx", placements: [placement(false)] })).toBe(true)
    expect(isRemovable({ origin: "plugin", placements: [placement(true)] })).toBe(false)
  })
})
