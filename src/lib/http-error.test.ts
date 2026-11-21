import { describe, expect, test } from "bun:test"
import { HttpError, isConflict, relocation } from "./http-error"

const err = (status: number, body: Record<string, unknown>) => new HttpError(status, { error: "x", ...body })

describe("save error classification", () => {
  test("only a 409 conflict is a content conflict (it may lead to Overwrite)", () => {
    expect(isConflict(err(409, { error: "conflict", currentHash: "h" }))).toBe(true)
    for (const code of ["moved", "now_linked", "exists", "removal_blocked", "removal_plan_changed", "not_upstream"])
      expect([code, isConflict(err(409, { error: code }))]).toEqual([code, false])
    expect(isConflict(err(400, { error: "conflict" }))).toBe(false)
    expect(isConflict(new Error("conflict"))).toBe(false)
  })

  test("moved and now_linked are relocations, with the new path when known", () => {
    expect(relocation(err(409, { error: "moved", currentPath: "/x/b.md" }))).toEqual({ target: "/x/b.md" })
    expect(relocation(err(409, { error: "moved" }))).toEqual({})
    expect(relocation(err(409, { error: "now_linked", linkTarget: "/x/AGENTS.md" }))).toEqual({ target: "/x/AGENTS.md" })
    expect(relocation(err(409, { error: "now_linked", linkTarget: null }))).toEqual({})
    expect(relocation(err(409, { error: "conflict" }))).toBeNull()
    expect(relocation(err(403, { error: "moved" }))).toBeNull()
    expect(relocation(new Error("moved"))).toBeNull()
  })
})
