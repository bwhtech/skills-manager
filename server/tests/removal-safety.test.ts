import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { assessUpdate } from "../actions.ts"
import { readLock } from "../discovery/locks.ts"
import { deletedCheck, makeFixture, settle, shownPlans, wire, type Fixture } from "./removal-harness.ts"

const exists = async (path: string) => !!(await lstat(path).catch(() => null))
const lockKeys = async (fx: Fixture) => [...(await readLock(fx.lockPath)).skills.keys()]

/** Lock: gone (deleted upstream) and keep. Canonical folders plus a ~/.claude link for gone. */
async function standard(extra: Record<string, object> = {}) {
  const fx = await makeFixture()
  await fx.writeLock({ gone: {}, keep: {}, ...extra })
  const canonical = await fx.skill(".agents/skills", "gone")
  await fx.skill(".agents/skills", "keep")
  const link = join(fx.home, ".claude/skills/gone")
  await fx.link(link, "../../.agents/skills/gone")
  return { fx, canonical, link }
}

async function jobOf(w: Awaited<ReturnType<typeof wire>>, res: Response) {
  expect(res.status).toBe(202)
  const { jobId } = (await res.json()) as { jobId: string }
  await settle(w.jobs)
  return w.jobs.get(jobId)!
}

describe("removal of deleted-upstream skills (real skills CLI, fixture HOME)", () => {
  test("removes the canonical folder and its link, with -a limited to them, and verifies", async () => {
    const { fx, canonical, link } = await standard()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const plan = (await w.status()).removalPlans?.find((p) => p.name === "gone")
    expect(plan?.blocked).toBeUndefined()
    expect(plan?.willDelete).toEqual([canonical, link].sort())
    expect(plan?.kept).toEqual([])
    const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans: await shownPlans(w, ["gone"]) }))
    expect(job.status).toBe("success")
    const removeCall = w.calls.find((c) => c[0] === "remove")!
    expect(removeCall.slice(0, 3)).toEqual(["remove", "-s", "gone"])
    expect(removeCall).toContain("-a")
    expect(removeCall).toContain("claude-code")
    expect(await exists(canonical)).toBe(false)
    expect(await exists(link)).toBe(false)
    expect(await lockKeys(fx)).toEqual(["keep"])
    expect(w.updates.isDeleted("user", "gone")).toBe(false)
    expect(w.upstream.asked).toEqual(["gone"])
  })

  test("reappeared upstream: the fresh fetch finds it, nothing is removed", async () => {
    const { fx, canonical, link } = await standard()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"])
    w.upstream.state = "present"
    const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans }))
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    expect(job.log).toContain("Kept gone: it is back in its source upstream.")
    expect(await exists(canonical)).toBe(true)
    expect(await exists(link)).toBe(true)
    expect(await lockKeys(fx)).toEqual(["gone", "keep"])
    expect(w.updates.isDeleted("user", "gone")).toBe(false) // the record is cleared
  })

  test("a fetch error during revalidation skips the name and fails the job", async () => {
    const { fx, canonical } = await standard()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"])
    w.upstream.state = new Error("network down")
    const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans }))
    expect(job.status).toBe("error")
    expect(job.log.some((l) => l.includes("could not check its source again (network down)"))).toBe(true)
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    expect(await exists(canonical)).toBe(true)
    expect(w.updates.isDeleted("user", "gone")).toBe(true)
  })

  test("reinstalled from another source: refused at request time and skipped in the job", async () => {
    const { fx, canonical } = await standard()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"])
    // After the check, before the request: the lock entry now points elsewhere.
    await fx.writeLock({ gone: { source: "other/repo", sourceUrl: "https://github.com/other/repo.git" }, keep: {} })
    const res = await w.run({ scope: "user", remove: ["gone"], removePlans })
    expect(res.status).toBe(400)
    expect(w.updates.isDeleted("user", "gone")).toBe(false)

    // In the job: the update step reinstalls it after the request was accepted.
    await fx.writeLock({ gone: {}, keep: {} })
    const w2 = await wire(
      fx,
      { check: deletedCheck("owner/repo", ["gone"]), update: { exitCode: 0, lines: ["✓ Updated keep"] } },
      { update: () => fx.writeLock({ gone: { source: "other/repo" }, keep: {} }) }
    )
    const job = await jobOf(
      w2,
      await w2.run({ scope: "user", names: ["keep"], remove: ["gone"], removePlans: await shownPlans(w2, ["gone"]) })
    )
    expect(job.log).toContain(
      "Kept gone: its lock entry changed since it was found deleted (reinstalled or updated)."
    )
    expect(w2.calls.some((c) => c[0] === "remove")).toBe(false)
    expect(await exists(canonical)).toBe(true)
  })

  test("ambiguous after a deleted record: the record is cleared and nothing is removed", async () => {
    const { fx, canonical } = await standard()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"])
    await w.updates.noteUpstream("user", { ambiguous: [{ name: "gone", source: "owner/repo" }] })
    expect(w.updates.get().deletedUpstream).toEqual([])
    expect(w.updates.get().ambiguousUpstream?.map((a) => a.name)).toEqual(["gone"])
    expect((await w.run({ scope: "user", remove: ["gone"], removePlans })).status).toBe(400)

    // Ambiguous only at revalidation time: skipped in the job, and noted as ambiguous.
    const w2 = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    w2.upstream.state = "ambiguous"
    const job = await jobOf(w2, await w2.run({ scope: "user", remove: ["gone"], removePlans: await shownPlans(w2, ["gone"]) }))
    expect(job.log.some((l) => l.startsWith("Kept gone: several upstream skills"))).toBe(true)
    expect(w2.calls.some((c) => c[0] === "remove")).toBe(false)
    expect(w2.updates.get().ambiguousUpstream?.map((a) => a.name)).toEqual(["gone"])
    expect(await exists(canonical)).toBe(true)
  })

  test("an independent copy in a non-installed agent's dir is kept; canonical and link go", async () => {
    const { fx, canonical, link } = await standard()
    // antigravity reads ~/.gemini/config/skills but is detected by ~/.gemini/antigravity.
    const copy = await fx.skill(".gemini/config/skills", "gone")
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const plan = (await w.status()).removalPlans?.find((p) => p.name === "gone")
    expect(plan?.willDelete).toEqual([canonical, link].sort())
    expect(plan?.kept).toEqual([{ path: copy, reason: "independent copy" }])
    const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans: await shownPlans(w, ["gone"]) }))
    expect(job.status).toBe("success")
    expect(w.calls.find((c) => c[0] === "remove")).not.toContain("antigravity")
    expect(await exists(copy)).toBe(true)
    expect(await exists(canonical)).toBe(false)
    expect(await exists(link)).toBe(false)
    expect(await lockKeys(fx)).toEqual(["keep"])
  })

  test("an independent ~/.claude copy is kept; the CLI would then keep the canonical folder too, so the name is blocked", async () => {
    const fx = await makeFixture()
    await fx.writeLock({ gone: {}, keep: {} })
    const canonical = await fx.skill(".agents/skills", "gone")
    const copy = await fx.skill(".claude/skills", "gone") // a real dir, not a link
    const link = join(fx.home, ".augment/skills/gone")
    await fx.link(link, canonical)
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const plan = (await w.status()).removalPlans?.find((p) => p.name === "gone")
    expect(plan?.willDelete).toEqual([])
    expect(plan?.blocked).toContain(`independent folder at ${copy}`)
    expect(plan?.kept.map((k) => k.path)).toEqual([copy, canonical])
    const res = await w.run({ scope: "user", remove: ["gone"], removePlans: [{ name: "gone", willDelete: [canonical, link] }] })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("removal_blocked")
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    for (const path of [canonical, copy, link]) expect(await exists(path)).toBe(true)
  })

  test("a path the dialog did not show is never deleted (409 removal_plan_changed)", async () => {
    const { fx, canonical } = await standard()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const res = await w.run({ scope: "user", remove: ["gone"], removePlans: [{ name: "gone", willDelete: [canonical] }] })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("removal_plan_changed")
    expect((await w.run({ scope: "user", remove: ["gone"] })).status).toBe(400) // removePlans required
  })

  test("partial update failure that exits 0: no step 2, and that source's updates are not pruned", async () => {
    const { fx, canonical } = await standard({ fresh: {}, other: { source: "else/where" } })
    const w = await wire(fx, {
      check: {
        exitCode: 1,
        lines: [
          ...deletedCheck("owner/repo", ["gone"]).lines,
          "↑ fresh has an update",
          "↑ other has an update",
          "2 skill(s) can be updated",
        ],
      },
      update: {
        exitCode: 0,
        lines: ["Checking skills from source: owner/repo", "  ✗ Failed to check skills from owner/repo", "✓ Updated other"],
      },
    })
    const job = await jobOf(
      w,
      await w.run({ scope: "user", names: ["fresh", "other"], remove: ["gone"], removePlans: await shownPlans(w, ["gone"]) })
    )
    expect(job.status).toBe("error")
    expect(job.log).toContain("Step 2 of 2 skipped: the update could not check owner/repo, so nothing was removed.")
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    expect(await exists(canonical)).toBe(true)
    // `fresh` is from owner/repo, whose check failed: still available. `other` is pruned.
    expect(w.updates.get().available.map((a) => a.name)).toEqual(["fresh"])
    expect(w.updates.isDeleted("user", "gone")).toBe(true)
  })

  test("foo-bar and Foo Bar both in the lock: 409 removal_conflict, nothing removed", async () => {
    const fx = await makeFixture()
    await fx.writeLock({ "foo-bar": {}, "Foo Bar": {} })
    const canonical = await fx.skill(".agents/skills", "foo-bar")
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["foo-bar"]) })
    const plan = (await w.status()).removalPlans?.find((p) => p.name === "foo-bar")
    expect(plan?.blocked).toContain('the lock key "Foo Bar"')
    const res = await w.run({ scope: "user", remove: ["foo-bar"], removePlans: [{ name: "foo-bar", willDelete: [canonical] }] })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("removal_conflict")
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    expect(await lockKeys(fx)).toEqual(["foo-bar", "Foo Bar"])
  })

  test('a "Could not remove" warning is a job error, and the deleted flag stays', async () => {
    const fx = await makeFixture()
    await fx.writeLock({ gone: {} })
    const canonical = await fx.skill(".agents/skills", "gone")
    const dir = join(fx.home, ".augment/skills")
    const link = join(dir, "gone")
    await fx.link(link, canonical)
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"])
    expect(removePlans[0].willDelete).toEqual([link, canonical].sort())
    await chmod(dir, 0o555) // the link cannot be unlinked
    try {
      const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans }))
      expect(job.log.some((l) => l.includes("Could not remove skill from Augment"))).toBe(true)
      expect(job.status).toBe("error")
      const incomplete = job.log.find((l) => l.startsWith("Incomplete removal of gone:"))
      expect(incomplete).toContain(`still on disk: ${link}`)
      expect(w.updates.isDeleted("user", "gone")).toBe(true)
    } finally {
      await chmod(dir, 0o755)
    }
  })

  test("names with spaces or Unicode are fine as exact lock keys; -x and newlines are refused", async () => {
    const fx = await makeFixture()
    const names = ["My Skill", "café-ünïcode"]
    await fx.writeLock({ "My Skill": {}, "café-ünïcode": {}, "-x": {} })
    await fx.skill(".agents/skills", "my-skill")
    await fx.skill(".agents/skills", "caf-n-code")
    const w = await wire(fx, { check: deletedCheck("owner/repo", [...names, "-x"]) })
    const status = await w.status()
    expect(status.removalPlans?.find((p) => p.name === "-x")?.blocked).toBe("name starts with -")
    const job = await jobOf(w, await w.run({ scope: "user", remove: names, removePlans: await shownPlans(w, names) }))
    expect(job.status).toBe("success")
    expect(await lockKeys(fx)).toEqual(["-x"])
    for (const bad of [["-x"], ["a\nb"], ["tab\there"], ["not-in-lock"], [42]]) {
      const res = await w.run({ scope: "user", remove: bad, removePlans: [] })
      expect(res.status).toBe(400)
    }
    expect((await w.run({ scope: "user", names: ["-g"] })).status).toBe(400)
  })

  test("names in a project scope resolve in the project, not in HOME", async () => {
    const fx = await makeFixture()
    const project = join(fx.home, "proj")
    await mkdir(join(project, ".agents/skills/gone"), { recursive: true })
    const w = await wire(fx, {})
    const [plan] = await w.guard.plans(project, ["gone"])
    expect(plan.blocked).toBe("gone is not in the lock file of this scope")
  })
})

describe("assessUpdate", () => {
  const lock = {
    lastSelectedAgents: [],
    skills: new Map([
      ["fresh", { source: "owner/repo", sourceUrl: "https://github.com/owner/repo.git" }],
      ["other", { source: "else/where" }],
    ]),
  }

  test("an exit-0 fetch error blocks step 2 and keeps that source's skills", () => {
    const o = assessUpdate({ code: 0, output: "  ✗ Failed to check skills from owner/repo" }, lock)
    expect(o).toEqual({ ok: true, failed: ["fresh"], blocksRemoval: "the update could not check owner/repo" })
  })

  test("a failure that names nothing known prunes nothing", () => {
    const o = assessUpdate({ code: 0, output: "✗ claude-code: EACCES" }, lock)
    expect(o.ok).toBe(false)
    expect(o.blocksRemoval).toBe("the update reported a failure")
  })

  test("only skills gone from their download: fine", () => {
    const gone = "  ✗ old is no longer in this download\nFailed to update 1 skill(s)"
    expect(assessUpdate({ code: 1, output: gone }, lock)).toEqual({ ok: true, failed: [], blocksRemoval: null })
    expect(assessUpdate({ code: 1, output: "TypeError: boom" }, lock).ok).toBe(false)
    expect(assessUpdate({ code: 0, output: "" }, lock).blocksRemoval).toBeNull()
  })
})
