import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RemovalPlan } from "../../shared/api.ts"
import { readLock, readLockStrict } from "../discovery/locks.ts"
import type { IndexedSkill } from "../discovery/skill-index.ts"
import type { HttpError } from "../lib/errors.ts"
import { planRemovals } from "../removal/plan.ts"
import { deletedCheck, makeFixture, settle, shownPlans, wire, type Fixture } from "./removal-harness.ts"

const exists = async (path: string) => !!(await lstat(path).catch(() => null))
const lockKeys = async (fx: Fixture) => [...(await readLock(fx.lockPath)).skills.keys()]

/**
 * Lock: gone (deleted upstream) and keep. gone has a canonical folder, a Claude Code copy
 * (identical: claude-code is detected, so it blocks), an Augment link to the canonical
 * folder, and an Antigravity copy that differs (Antigravity is not detected: left behind).
 */
async function withCopies() {
  const fx = await makeFixture()
  await fx.writeLock({ gone: {}, keep: {} })
  const canonical = await fx.skill(".agents/skills", "gone")
  await fx.skill(".agents/skills", "keep")
  const claude = await fx.skill(".claude/skills", "gone")
  const link = join(fx.home, ".augment/skills/gone")
  await fx.link(link, canonical)
  const other = await fx.skill(".gemini/config/skills", "gone")
  await writeFile(join(other, "notes.md"), "local notes\n")
  return { fx, canonical, claude, link, other }
}

async function jobOf(w: Awaited<ReturnType<typeof wire>>, res: Response) {
  expect(res.status).toBe(202)
  const { jobId } = (await res.json()) as { jobId: string }
  await settle(w.jobs)
  return w.jobs.get(jobId)!
}

async function errorOf(res: Response) {
  return { status: res.status, ...((await res.json()) as { error: string; detail?: string }) }
}

const planOf = async (w: Awaited<ReturnType<typeof wire>>, name = "gone") =>
  (await w.status()).removalPlans?.find((p) => p.name === name) as RemovalPlan

describe("separate copies of deleted-upstream skills (real skills CLI, fixture HOME)", () => {
  test("identical and differing copies are told apart; only the Claude Code copy blocks", async () => {
    const { fx, canonical, claude, link, other } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const plan = await planOf(w)
    expect(plan.blockedUnlessCopies).toBe(true)
    expect(plan.willDelete).toEqual([link, canonical].sort())
    expect(plan.kept).toEqual([])
    expect(plan.copies).toEqual([
      { path: claude, agent: "Claude Code", identical: true, files: 1, blocking: true },
      {
        path: other,
        agent: "Antigravity, Antigravity CLI",
        identical: false,
        files: 2,
        differences: 1,
        reason: "1 file differs",
        blocking: false,
      },
    ])
    // Same file names, other bytes: differs too.
    await writeFile(join(claude, "SKILL.md"), "---\nname: gone\ndescription: edited\n---\n")
    const edited = await planOf(w)
    expect(edited.copies?.[0]).toMatchObject({ identical: false, differences: 1, reason: "1 file differs" })
  })

  test("a copy over the preview limits is too large to compare, so not identical", async () => {
    const { fx, claude } = await withCopies()
    const cli = await fx.loadCli()
    const [plan] = await planRemovals(
      {
        scope: "user",
        home: fx.home,
        agents: cli.agents,
        cli,
        lock: await fx.readLock("user"),
        diffLimits: { maxFilesPerSide: 10, maxReadBytes: 10, readConcurrency: 1 },
      },
      ["gone"]
    )
    const copy = plan.copies.find((c) => c.path === claude)
    expect(copy).toMatchObject({ identical: false, tooLarge: true, reason: "too large to compare" })
  })

  test("an unticked blocking copy: refused with removal_blocked, nothing touched", async () => {
    const { fx, canonical, claude, link } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const res = await w.run({ scope: "user", remove: ["gone"], removePlans: await shownPlans(w, ["gone"]) })
    const err = await errorOf(res)
    expect(err.status).toBe(409)
    expect(err.error).toBe("removal_blocked")
    expect(err.detail).toContain(`not ticked: ${claude}`)
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    for (const path of [canonical, claude, link]) expect(await exists(path)).toBe(true)
  })

  test("a ticked copy is deleted first; then the canonical folder, links and lock entry go; others stay", async () => {
    const { fx, canonical, claude, link, other } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"], { gone: [claude] })
    const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans }))
    expect(job.status).toBe("success")
    expect(await exists(claude)).toBe(false)
    expect(await exists(canonical)).toBe(false)
    expect(await exists(link)).toBe(false)
    expect(await exists(other)).toBe(true) // not ticked
    expect(await lockKeys(fx)).toEqual(["keep"])
    expect(await exists(join(fx.home, ".agents/skills/keep"))).toBe(true)
    expect(job.log).toContain(`Deleted ${claude}`)
    expect(job.log).toContain(`Deleted separate copies: ${claude}`)
    expect(job.log).toContain(`  kept: separate copy (not ticked) at ${other}`)
    const cliCall = w.calls.findIndex((c) => c[0] === "remove")
    expect(cliCall).toBeGreaterThanOrEqual(0)
    // The first "$ skills remove" line is the job's command; the last is the CLI step.
    expect(job.log.findIndex((l) => l === `Deleted ${claude}`)).toBeLessThan(
      job.log.findLastIndex((l) => l.startsWith("$ skills remove"))
    )
    expect(w.updates.isDeleted("user", "gone")).toBe(false)
  })

  test("a copy that changed after the dialog: 409 removal_plan_changed; in the job: skipped", async () => {
    const { fx, canonical, claude } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"], { gone: [claude] })
    await writeFile(join(claude, "extra.md"), "added after the dialog\n")
    const err = await errorOf(await w.run({ scope: "user", remove: ["gone"], removePlans }))
    expect(err.status).toBe(409)
    expect(err.error).toBe("removal_plan_changed")
    expect(err.detail).toContain(`${claude} is now different (1 file differs)`)
    await rm(join(claude, "extra.md"))

    // Accepted, then the copy changes during the fresh upstream recheck in the job.
    w.upstream.onAsk = () => writeFile(join(claude, "extra.md"), "added in the job\n")
    const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans }))
    expect(job.status).toBe("error")
    expect(job.log.some((l) => l.startsWith("Kept gone: gone: its separate copies changed since the dialog"))).toBe(true)
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    expect(await exists(claude)).toBe(true)
    expect(await exists(canonical)).toBe(true)
  })

  test("a copy delete that fails stops before skills remove and logs what was deleted", async () => {
    const { fx, canonical, claude, other } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"], { gone: [claude, other] })
    const dir = join(fx.home, ".gemini/config/skills")
    await chmod(dir, 0o555) // no trash dir can be made there
    try {
      const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans }))
      expect(job.status).toBe("error")
      expect(job.log).toContain(`Deleted ${claude}`)
      expect(job.log).toContain(
        `Stopped before skills remove: the separate copy ${other} could not be deleted. Nothing else was removed.`
      )
      expect(job.log).toContain(`  deleted: ${claude}`)
      expect(job.log).toContain(`  not deleted: ${other}`)
      expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
      expect(await exists(other)).toBe(true)
      expect(await exists(canonical)).toBe(true)
      expect(await lockKeys(fx)).toEqual(["gone", "keep"])
      expect(w.updates.isDeleted("user", "gone")).toBe(true)
    } finally {
      await chmod(dir, 0o755)
    }
  })

  test("a ticked path that is not a copy in the plan is rejected (400)", async () => {
    const { fx, canonical, claude } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const [shown] = await shownPlans(w, ["gone"], { gone: [claude] })
    const keepDir = join(fx.home, ".agents/skills/keep")
    for (const bogus of [canonical, keepDir, "/etc", join(fx.home, ".claude/skills/other")]) {
      // Not shown as a copy: 400.
      const a = await w.run({ scope: "user", remove: ["gone"], removePlans: [{ ...shown, copies: [claude, bogus] }] })
      expect(a.status).toBe(400)
      // Forged into shownCopies too: the copies differ from the plan (409), never deleted.
      const forged = { ...shown, copies: [claude, bogus], shownCopies: [...shown.shownCopies, { path: bogus, identical: true }] }
      expect([400, 409]).toContain((await w.run({ scope: "user", remove: ["gone"], removePlans: [forged] })).status)
      // Without shownCopies: 400 "not a separate copy".
      const bare = await w.run({ scope: "user", remove: ["gone"], removePlans: [{ name: "gone", willDelete: shown.willDelete, copies: [bogus] }] })
      expect(await errorOf(bare)).toMatchObject({ status: 400, error: "bad_request" })
    }
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    for (const path of [canonical, claude, keepDir]) expect(await exists(path)).toBe(true)
  })
})

describe("re-check before each skills remove call (review round 7, item 2)", () => {
  test("(a) a folder that appears after the job confirmed the plan: the group is skipped", async () => {
    const { fx, canonical, claude } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"], { gone: [claude] })
    const fresh = join(fx.home, ".bob/skills/gone") // an agent path the CLI could look at
    const recheck = w.guard.recheck.bind(w.guard)
    w.guard.recheck = async (scope, plans) => {
      await fx.skill(".bob/skills", "gone")
      return recheck(scope, plans)
    }
    const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans }))
    expect(job.status).toBe("error")
    const line = job.log.find((l) => l.startsWith("Skipped gone (removal_plan_changed)"))
    expect(line).toContain(`+${fresh} (copy)`)
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    expect(await exists(fresh)).toBe(true)
    expect(await exists(canonical)).toBe(true)
    expect(await lockKeys(fx)).toEqual(["gone", "keep"])
  })

  test("(a) a lock entry that changes after the job confirmed the plan: the group is skipped", async () => {
    const { fx, canonical, claude } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const removePlans = await shownPlans(w, ["gone"], { gone: [claude] })
    const recheck = w.guard.recheck.bind(w.guard)
    w.guard.recheck = async (scope, plans) => {
      await fx.writeLock({ gone: { skillFolderHash: "reinstalled" }, keep: {} })
      return recheck(scope, plans)
    }
    const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans }))
    expect(job.log).toContain(
      "Skipped gone (removal_plan_changed): the lock entry of gone changed. Open the dialog again."
    )
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
    expect(await exists(canonical)).toBe(true)
  })

  test("(b) a snapshotted path that is gone after skills remove fails the job", async () => {
    const { fx, claude, other } = await withCopies()
    // Stand-in for the CLI touching a path it was not given: delete the unticked copy as
    // the real CLI starts.
    const w = await wire(
      fx,
      { check: deletedCheck("owner/repo", ["gone"]) },
      { remove: () => rm(other, { recursive: true }) }
    )
    const removePlans = await shownPlans(w, ["gone"], { gone: [claude] })
    const job = await jobOf(w, await w.run({ scope: "user", remove: ["gone"], removePlans }))
    expect(job.status).toBe("error")
    const line = job.log.find((l) => l.startsWith("Incomplete removal of gone:"))
    expect(line).toContain(`deleted although it was not to be: ${other}`)
    expect(w.updates.isDeleted("user", "gone")).toBe(true)
  })
})

describe("explicit Remove of a copy-mode install (review round 7, item 3)", () => {
  const skillStub = (name: string) =>
    ({ origin: "npx", scope: "user", cliName: name, name, placements: [] }) as unknown as IndexedSkill

  test("a copy that matches the canonical folder is part of the install: Remove deletes both and the lock entry", async () => {
    const fx = await makeFixture()
    await fx.writeLock({ foo: {}, keep: {} })
    const canonical = await fx.skill(".agents/skills", "foo")
    await writeFile(join(canonical, "ref.md"), "reference\n")
    const copy = await fx.skill(".claude/skills", "foo") // `skills add --copy`: a real folder
    await writeFile(join(copy, "ref.md"), "reference\n")
    const w = await wire(fx, {})
    const [plan] = await w.guard.plans("user", ["foo"], { intent: "remove" })
    expect(plan.blocked).toBeUndefined()
    expect(plan.willDelete).toEqual([copy, canonical].sort())
    expect(plan.copies).toEqual([])
    // A deleted-upstream cleanup still treats it as an opt-in copy.
    const [cleanup] = await w.guard.plans("user", ["foo"])
    expect(cleanup.blockedUnlessCopies).toBe(true)

    const job = w.actions.remove(skillStub("foo"), plan)
    await settle(w.jobs)
    expect(w.jobs.get(job.id)?.status).toBe("success")
    expect(await exists(canonical)).toBe(false)
    expect(await exists(copy)).toBe(false)
    expect(await lockKeys(fx)).toEqual(["keep"])
    expect(w.calls.find((c) => c[0] === "remove")).toContain("claude-code")
  })

  test("a copy that differs stays opt-in: refused until ticked, then deleted", async () => {
    const fx = await makeFixture()
    await fx.writeLock({ foo: {} })
    const canonical = await fx.skill(".agents/skills", "foo")
    const copy = await fx.skill(".claude/skills", "foo")
    await writeFile(join(copy, "mine.md"), "a local edit\n")
    const w = await wire(fx, {})
    const [plan] = await w.guard.plans("user", ["foo"], { intent: "remove" })
    expect(plan.blockedUnlessCopies).toBe(true)
    expect(plan.copies.map((c) => [c.path, c.identical, c.blocking])).toEqual([[copy, false, true]])
    let refused: HttpError | null = null
    try {
      w.actions.remove(skillStub("foo"), plan)
    } catch (err) {
      refused = err as HttpError
    }
    expect(refused?.message).toBe("removal_blocked")

    const [ticked] = await w.guard.plans("user", ["foo"], { intent: "remove", gone: new Map([["foo", [copy]]]) })
    const job = w.actions.remove(skillStub("foo"), ticked, {
      willDelete: ticked.willDelete,
      copies: [copy],
      shownCopies: [{ path: copy, identical: false }],
    })
    await settle(w.jobs)
    expect(w.jobs.get(job.id)?.status).toBe("success")
    expect(await exists(copy)).toBe(false)
    expect(await exists(canonical)).toBe(false)
    expect(await lockKeys(fx)).toEqual([])
  })

  test("installMode symlink: a real-folder copy is never part of the install, even when identical", async () => {
    const fx = await makeFixture()
    await fx.writeLock({ foo: { installMode: "symlink" } })
    await fx.skill(".agents/skills", "foo")
    const copy = await fx.skill(".claude/skills", "foo")
    const w = await wire(fx, {})
    const [plan] = await w.guard.plans("user", ["foo"], { intent: "remove" })
    expect(plan.blockedUnlessCopies).toBe(true)
    expect(plan.copies.map((c) => [c.path, c.identical])).toEqual([[copy, true]])
  })

  test("global copy-only install: a copy whose CLI hash equals skillFolderHash is part of the install", async () => {
    const fx = await makeFixture()
    const copy = await fx.skill(".claude/skills", "foo")
    const cli = await fx.loadCli()
    await fx.writeLock({ foo: { installMode: "copy", skillFolderHash: await cli.computeSkillFolderHash!(copy) } })
    const w = await wire(fx, {})
    const [plan] = await w.guard.plans("user", ["foo"], { intent: "remove" })
    expect(plan.blocked).toBeUndefined()
    expect(plan.willDelete).toEqual([copy])
  })

  test("in a project, a copy whose CLI hash equals the lock's computedHash is part of the install", async () => {
    const fx = await makeFixture()
    const project = join(fx.home, "proj")
    const copy = join(project, ".claude/skills/foo")
    await mkdir(copy, { recursive: true })
    await writeFile(join(copy, "SKILL.md"), "---\nname: foo\ndescription: test\n---\n")
    const cli = await fx.loadCli()
    const computedHash = await cli.computeSkillFolderHash!(copy)
    const lock = { lastSelectedAgents: [], skills: new Map([["foo", { source: "owner/repo", computedHash }]]) }
    const env = { scope: project, home: fx.home, agents: cli.agents, cli, lock }
    const [match] = await planRemovals({ ...env, intent: "remove" }, ["foo"])
    expect(match.willDelete).toEqual([copy])
    await writeFile(join(copy, "SKILL.md"), "---\nname: foo\ndescription: edited\n---\n")
    const [edited] = await planRemovals({ ...env, intent: "remove" }, ["foo"])
    expect(edited.willDelete).toEqual([])
    expect(edited.copies.map((c) => c.path)).toEqual([copy])
  })
})

describe("strict lock reads after removal (review round 7, item 4)", () => {
  test("readLockStrict tells an empty lock from a missing or broken one", async () => {
    const fx = await makeFixture()
    await expect(readLockStrict(fx.lockPath)).rejects.toThrow("could not read the lock file")
    await writeFile(fx.lockPath, "{ not json")
    await expect(readLockStrict(fx.lockPath)).rejects.toThrow("is not valid JSON")
    await writeFile(fx.lockPath, JSON.stringify({ version: 3 }))
    await expect(readLockStrict(fx.lockPath)).rejects.toThrow("has no skills object")
    await writeFile(fx.lockPath, JSON.stringify({ version: 3, skills: {} }))
    expect((await readLockStrict(fx.lockPath)).skills.size).toBe(0)
    expect((await readLock(join(fx.home, "missing.json"))).skills.size).toBe(0) // lenient reader
  })

  test("verify fails a removal when the lock file is broken afterwards", async () => {
    const fx = await makeFixture()
    await fx.writeLock({ gone: {} })
    await fx.skill(".agents/skills", "gone")
    const w = await wire(fx, {})
    const [plan] = await w.guard.plans("user", ["gone"])
    await rm(join(fx.home, ".agents/skills/gone"), { recursive: true })
    await writeFile(fx.lockPath, "")
    const broken = await w.guard.verify("user", [plan], "", 0)
    expect(broken.removed).toEqual([])
    expect(broken.incomplete[0].problems.join("; ")).toContain("is not valid JSON")
    await writeFile(fx.lockPath, JSON.stringify({ version: 3, skills: {} }))
    expect((await w.guard.verify("user", [plan], "", 0)).removed).toEqual(["gone"])
    expect(await readFile(fx.lockPath, "utf8")).toContain("skills")
  })
})
