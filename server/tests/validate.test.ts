import { describe, expect, test } from "bun:test"
import { encodeId } from "../../shared/api.ts"
import { HttpError } from "../lib/errors.ts"
import { isInside } from "../lib/files.ts"
import {
  decodePathId,
  isSkillName,
  isSource,
  requireAgents,
  requireRelativePath,
  requireScope,
} from "../lib/validate.ts"

function status(fn: () => unknown): number | null {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof HttpError ? err.status : -1
  }
}

describe("IDs", () => {
  test("round trip of an absolute path", () => {
    const path = "/home/u/.claude/skills/démo skill"
    expect(decodePathId(encodeId(path))).toBe(path)
  })

  test("rejects relative, unnormalized and garbage ids", () => {
    expect(status(() => decodePathId(encodeId("relative/path")))).toBe(404)
    expect(
      status(() => decodePathId(encodeId("/home/u/../../etc/passwd")))
    ).toBe(404)
    expect(status(() => decodePathId(encodeId("/home/u/./x")))).toBe(404)
    expect(status(() => decodePathId(encodeId("/home/u\0/x")))).toBe(404)
    expect(status(() => decodePathId("!!!"))).toBe(404)
  })
})

describe("relative file paths", () => {
  test("accepts nested posix paths", () => {
    expect(requireRelativePath("scripts/run.sh")).toBe("scripts/run.sh")
  })

  test("rejects traversal and absolute paths", () => {
    for (const bad of [
      "../x",
      "a/../../x",
      "/etc/passwd",
      "a//b",
      "./a",
      "a\\b",
      "",
      42,
    ]) {
      expect(status(() => requireRelativePath(bad))).toBe(400)
    }
  })

  test("isInside does not match sibling prefixes", () => {
    expect(isInside("/a/skill", "/a/skill/SKILL.md")).toBe(true)
    expect(isInside("/a/skill", "/a/skill")).toBe(true)
    expect(isInside("/a/skill", "/a/skill-evil/SKILL.md")).toBe(false)
  })
})

describe("scope", () => {
  const known = (p: string) => p === "/home/u/proj"
  test("user and known projects", () => {
    expect(requireScope("user", known)).toBe("user")
    expect(requireScope("/home/u/proj", known)).toBe("/home/u/proj")
  })
  test("unknown or malformed scopes", () => {
    for (const bad of ["/etc", "proj", "", null, 1, "/home/u/proj/../x"]) {
      expect(status(() => requireScope(bad, known))).toBe(400)
    }
  })
})

describe("CLI arguments", () => {
  test("sources", () => {
    for (const ok of [
      "vercel-labs/agent-skills",
      "owner/repo@skill-name",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo/tree/main/skills/x",
      "https://github.com/owner/repo.git",
    ]) {
      expect(isSource(ok)).toBe(true)
    }
    for (const bad of [
      "-g",
      "--help",
      "owner",
      "owner/repo --global",
      "../repo/x",
      "http://x/y",
      "file:///etc",
      "owner/repo;rm",
    ]) {
      expect(isSource(bad)).toBe(false)
    }
  })

  test("skill names", () => {
    expect(isSkillName("web-design-guidelines")).toBe(true)
    expect(isSkillName("react:components")).toBe(true)
    for (const bad of ["-y", "--all", "a b", "", "a/b", "x".repeat(200)])
      expect(isSkillName(bad)).toBe(false)
  })

  test("agents must be known", () => {
    const known = (id: string) => id === "claude-code"
    expect(requireAgents(["claude-code", "claude-code"], known)).toEqual([
      "claude-code",
    ])
    expect(status(() => requireAgents(["codex"], known))).toBe(400)
    expect(status(() => requireAgents(["-g"], () => true))).toBe(400)
    expect(status(() => requireAgents([], known))).toBe(400)
  })
})
