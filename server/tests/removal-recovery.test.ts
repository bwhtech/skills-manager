import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { RecoveryResult, RecoveryStatus } from "../../shared/api.ts"
import { testCrashAllowed } from "../config.ts"
import { journalDir, readJournals } from "../removal/journal.ts"
import { RemovalRecovery } from "../removal/recovery.ts"
import { moveBack } from "../removal/staging.ts"
import { deletedCheck, makeFixture, settle, shownPlans, wire, type Fixture } from "./removal-harness.ts"

const exists = async (path: string) => !!(await lstat(path).catch(() => null))
const trashDirs = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(".skills-manager-trash-"))

/**
 * Lock: gone (deleted upstream) and keep. gone has a canonical folder, an identical Claude
 * Code copy (it blocks: claude-code is detected) and an Antigravity copy with local notes.
 */
async function withCopies() {
  const fx = await makeFixture()
  await fx.writeLock({ gone: {}, keep: {} })
  const canonical = await fx.skill(".agents/skills", "gone")
  await fx.skill(".agents/skills", "keep")
  const claude = await fx.skill(".claude/skills", "gone")
  const other = await fx.skill(".gemini/config/skills", "gone")
  await writeFile(join(other, "notes.md"), "local notes\n")
  return { fx, canonical, claude, other }
}

/** A recovery service as a restarted server sees it: no job of the old process is running. */
const restarted = (fx: Fixture, w: Awaited<ReturnType<typeof wire>>) =>
  new RemovalRecovery({ home: fx.home, running: () => [], skillsDirs: () => w.guard.skillsDirs([]) })

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * Starts a removal of `gone` with both copies ticked, and "crashes" right after they are
 * staged: the job stops there for good (it never resumes, like a killed process).
 */
async function crashAfterStage() {
  const env = await withCopies()
  const { fx, claude, other } = env
  const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
  let staged: string[] = []
  w.hooks.stage = {
    afterGroupStaged: (paths) => {
      staged = paths
      return new Promise<void>(() => {})
    },
  }
  const removePlans = await shownPlans(w, ["gone"], { gone: [claude, other] })
  const res = await w.run({ scope: "user", remove: ["gone"], removePlans })
  expect(res.status).toBe(202)
  const { jobId } = (await res.json()) as { jobId: string }
  await until(() => staged.length === 2, "the copies to be staged")
  return { ...env, w, jobId, after: restarted(fx, w) }
}

describe("removal journal (review round 9, item 1)", () => {
  test("written (mode 600) before anything moves, updated per step, deleted once the job settled", async () => {
    const { fx, claude } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const seen: { mode: number; statuses: string[]; full: boolean }[] = []
    const snapshot = async () => {
      const [journal] = await readJournals(journalDir(fx.home))
      const file = join(journalDir(fx.home), `${journal.jobId}.json`)
      seen.push({
        mode: (await stat(file)).mode & 0o777,
        statuses: journal.items.map((i) => i.status),
        full: journal.items.every((i) => /^[0-9a-f]{64}$/.test(i.full) && i.dev > 0 && i.ino > 0 && i.original === claude),
      })
    }
    // Between the checks and the move, the journal already records the copy as planned.
    w.hooks.stage = { afterCheck: snapshot, afterGroupStaged: snapshot }
    const removePlans = await shownPlans(w, ["gone"], { gone: [claude] })
    const res = await w.run({ scope: "user", remove: ["gone"], removePlans })
    await settle(w.jobs)
    const job = w.jobs.get(((await res.json()) as { jobId: string }).jobId)!
    expect(job.status).toBe("success")
    expect(seen).toEqual([
      { mode: 0o600, statuses: ["planned"], full: true },
      { mode: 0o600, statuses: ["staged"], full: true },
    ])
    expect(await exists(claude)).toBe(false)
    expect(await readdir(journalDir(fx.home))).toEqual([])
    expect(await w.recovery.status()).toEqual({ interruptedRemovals: [], unknownLeftovers: [] })
  })

  test("a crash after staging: listed after the restart, nothing is moved or deleted on its own", async () => {
    const { w, jobId, after, claude, other, canonical } = await crashAfterStage()
    // While the job still runs (same process), its journal is not offered.
    expect((await (await w.recover("")).json()) as RecoveryStatus).toEqual({ interruptedRemovals: [], unknownLeftovers: [] })
    const busy = await w.recover("/restore", { jobId, staged: ["x"] })
    expect(busy.status).toBe(409)

    const status = await after.status()
    expect(status.unknownLeftovers).toEqual([])
    expect(status.interruptedRemovals).toHaveLength(1)
    const [removal] = status.interruptedRemovals
    expect(removal.jobId).toBe(jobId)
    expect(removal.items.map((i) => [i.original, i.status, i.restorable, i.deletable])).toEqual([
      [claude, "staged", true, true],
      [other, "staged", true, true],
    ])
    for (const item of removal.items) {
      expect(dirname(dirname(item.staged))).toBe(dirname(item.original))
      expect(await exists(join(item.staged, "SKILL.md"))).toBe(true)
    }
    // Reading the status twice changes nothing on disk.
    expect(await after.status()).toEqual(status)
    expect(await exists(claude)).toBe(false)
    expect(await exists(canonical)).toBe(true) // skills remove never ran
    expect(w.calls.some((c) => c[0] === "remove")).toBe(false)
  })

  test("restore one copy and delete the other; then the journal and the trash dirs are gone", async () => {
    const { fx, jobId, after, claude, other } = await crashAfterStage()
    const [removal] = (await after.status()).interruptedRemovals
    const stagedOf = (path: string) => removal.items.find((i) => i.original === path)!.staged

    const restored = await after.restore(jobId, [stagedOf(claude)])
    expect(restored.results).toEqual([{ staged: stagedOf(claude), ok: true, message: `Moved back to ${claude}` }])
    expect(await readFile(join(claude, "SKILL.md"), "utf8")).toContain('name: "gone"')
    expect(restored.recovery.interruptedRemovals[0].items.map((i) => i.original)).toEqual([other])

    const deleted = await after.delete(jobId, [stagedOf(other)])
    expect(deleted.results).toEqual([{ staged: stagedOf(other), ok: true, message: `Deleted ${stagedOf(other)}` }])
    expect(await exists(other)).toBe(false)
    expect(await exists(stagedOf(other))).toBe(false)
    expect(deleted.recovery).toEqual({ interruptedRemovals: [], unknownLeftovers: [] })
    expect(await readdir(journalDir(fx.home))).toEqual([])
    for (const dir of [".claude/skills", ".gemini/config/skills"]) expect(await trashDirs(join(fx.home, dir))).toEqual([])
  })

  test("restore never replaces what is at the original path; delete refuses changed contents", async () => {
    const { jobId, after, claude, other } = await crashAfterStage()
    const [removal] = (await after.status()).interruptedRemovals
    const stagedOf = (path: string) => removal.items.find((i) => i.original === path)!.staged
    await mkdir(claude)
    await writeFile(join(claude, "new.md"), "made after the crash\n")
    const view = (await after.status()).interruptedRemovals[0].items.find((i) => i.original === claude)!
    expect(view).toMatchObject({ restorable: false, deletable: true, reason: `something else is at ${claude} now, so it cannot be moved back` })
    const refused = await after.restore(jobId, [stagedOf(claude)])
    expect(refused.results[0]).toMatchObject({ ok: false })
    expect(await readFile(join(claude, "new.md"), "utf8")).toBe("made after the crash\n")
    expect(await exists(join(stagedOf(claude), "SKILL.md"))).toBe(true)

    await writeFile(join(stagedOf(other), "notes.md"), "edited in the trash dir\n")
    const kept = await after.delete(jobId, [stagedOf(other)])
    expect(kept.results[0]).toEqual({ staged: stagedOf(other), ok: false, message: "Its contents changed since it was set aside; nothing was deleted." })
    expect(await readFile(join(stagedOf(other), "notes.md"), "utf8")).toBe("edited in the trash dir\n")
    expect(kept.recovery.interruptedRemovals[0].items).toHaveLength(2)
  })

  test("requests name a job and paths of its journal; unknown leftovers are only listed", async () => {
    const { fx, w, jobId, after } = await crashAfterStage()
    const stray = join(fx.home, ".claude/skills/.skills-manager-trash-0badc0de")
    await mkdir(join(stray, "mine"), { recursive: true })
    await writeFile(join(stray, "mine/SKILL.md"), "not in any journal\n")
    expect((await after.status()).unknownLeftovers).toEqual([{ path: stray }])
    await expect(after.restore("../../etc", [stray])).rejects.toMatchObject({ status: 400 })
    await expect(after.delete(jobId, [join(stray, "mine")])).rejects.toMatchObject({ status: 400 })
    await expect(after.delete(crypto.randomUUID(), [join(stray, "mine")])).rejects.toMatchObject({ status: 404 })
    await expect(after.delete(jobId, [])).rejects.toMatchObject({ status: 400 })
    expect(await readFile(join(stray, "mine/SKILL.md"), "utf8")).toBe("not in any journal\n")
    // Through the routes: the same refusals as HTTP errors.
    expect((await w.recover("/delete", { jobId: "nope", staged: [stray] })).status).toBe(400)
  })
})

describe("a delete that throws part way (review round 9, item 2)", () => {
  test("a read-only nested folder: not moved back, purge_failed in the journal, the log and the banner", async () => {
    const { fx, claude, canonical } = await withCopies()
    const ro = join(claude, "locked")
    await mkdir(ro)
    await writeFile(join(ro, "keep.md"), "cannot be unlinked\n")
    await chmod(ro, 0o555)
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    try {
      const removePlans = await shownPlans(w, ["gone"], { gone: [claude] })
      const res = await w.run({ scope: "user", remove: ["gone"], removePlans })
      await settle(w.jobs)
      const job = w.jobs.get(((await res.json()) as { jobId: string }).jobId)!
      expect(job.status).toBe("error")
      expect(await exists(canonical)).toBe(false) // skills remove ran and verified
      expect(await exists(claude)).toBe(false) // never moved back over a partial copy
      const [journal] = await readJournals(journalDir(fx.home))
      expect(journal.items).toHaveLength(1)
      const [item] = journal.items
      expect(item.status).toBe("purge_failed")
      expect(item.error).toMatch(/EACCES|permission denied/i)
      expect(job.log.some((l) => l.startsWith(`Could not delete the separate copy ${claude} completely (`))).toBe(true)
      expect(job.log).toContain(`Partially deleted, still in trash: ${item.staged} (was ${claude}). Delete it by hand.`)
      expect(job.log.some((l) => l.startsWith(`Restored the separate copy`))).toBe(false)
      expect(await exists(join(item.staged, "locked/keep.md"))).toBe(true)
      const status = await restarted(fx, w).status()
      expect(status.interruptedRemovals[0].items).toEqual([
        {
          original: claude,
          staged: item.staged,
          status: "purge_failed",
          restorable: false,
          deletable: false,
          reason: `partially deleted, still in trash: ${item.staged}. Delete it by hand.`,
        },
      ])
      const refused = (await restarted(fx, w).restore(journal.jobId, [item.staged])) as RecoveryResult
      expect(refused.results[0].ok).toBe(false)
      expect(await exists(claude)).toBe(false)
    } finally {
      for (const dir of await readdir(join(fx.home, ".claude/skills"), { recursive: true }))
        await chmod(join(fx.home, ".claude/skills", dir), 0o755).catch(() => {})
    }
  })
})

describe("restore is no-replace (review round 9, item 3)", () => {
  async function staged() {
    const fx = await makeFixture()
    const root = join(fx.home, ".claude/skills")
    const original = join(root, "foo")
    const trashed = join(root, ".skills-manager-trash-12345678", "foo")
    await mkdir(trashed, { recursive: true })
    await writeFile(join(trashed, "SKILL.md"), "the staged copy\n")
    return { original, trashed }
  }

  test("something appears before the mkdir: EEXIST, the copy stays staged", async () => {
    const { original, trashed } = await staged()
    const result = await moveBack(trashed, original, {
      beforeMkdir: async (path) => {
        await mkdir(path)
        await writeFile(join(path, "theirs.md"), "theirs\n")
      },
    })
    expect(result).toEqual({ ok: false, reason: `something else is at ${original} now` })
    expect(await readFile(join(original, "theirs.md"), "utf8")).toBe("theirs\n")
    expect(await readFile(join(trashed, "SKILL.md"), "utf8")).toBe("the staged copy\n")
  })

  test("something is put into our empty folder before the rename: ENOTEMPTY, both stay", async () => {
    const { original, trashed } = await staged()
    const result = await moveBack(trashed, original, {
      afterMkdir: (path) => writeFile(join(path, "theirs.md"), "theirs\n"),
    })
    expect(result).toEqual({ ok: false, reason: `something else appeared at ${original} while it was moved back` })
    expect(await readFile(join(original, "theirs.md"), "utf8")).toBe("theirs\n")
    expect(await readFile(join(trashed, "SKILL.md"), "utf8")).toBe("the staged copy\n")
  })

  test("our folder is swapped for a link before the rename: refused, the link and its target stay", async () => {
    const { original, trashed } = await staged()
    const target = join(dirname(dirname(original)), "elsewhere")
    await mkdir(target)
    await writeFile(join(target, "data.md"), "elsewhere\n")
    const result = await moveBack(trashed, original, {
      afterMkdir: async (path) => {
        await rm(path, { recursive: true })
        await symlink(target, path)
      },
    })
    expect(result.ok).toBe(false)
    expect((await lstat(original)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(target, "data.md"), "utf8")).toBe("elsewhere\n")
    expect(await readFile(join(trashed, "SKILL.md"), "utf8")).toBe("the staged copy\n")
  })

  test("the plain case: moved back, the empty trash dir removed, same inode", async () => {
    const { original, trashed } = await staged()
    const ino = (await lstat(trashed)).ino
    expect(await moveBack(trashed, original)).toEqual({ ok: true })
    expect((await lstat(original)).ino).toBe(ino)
    expect(await exists(dirname(trashed))).toBe(false)
  })

  test("in a job: a folder that appears while the copies are staged keeps the copy set aside, listed in the banner", async () => {
    const { fx, claude } = await withCopies()
    const w = await wire(fx, { check: deletedCheck("owner/repo", ["gone"]) })
    const recheck = w.guard.recheck.bind(w.guard)
    w.guard.recheck = async (scope, plans, options) => {
      if (options?.copies !== "present") {
        await mkdir(claude)
        await writeFile(join(claude, "theirs.md"), "made while staged\n")
        return { ok: false, reason: "test: the plan changed" }
      }
      return recheck(scope, plans, options)
    }
    const removePlans = await shownPlans(w, ["gone"], { gone: [claude] })
    const res = await w.run({ scope: "user", remove: ["gone"], removePlans })
    await settle(w.jobs)
    const job = w.jobs.get(((await res.json()) as { jobId: string }).jobId)!
    expect(job.status).toBe("error")
    expect(job.log.some((l) => l.startsWith(`Could not restore the separate copy ${claude}: something else is at ${claude} now.`))).toBe(true)
    expect(await readFile(join(claude, "theirs.md"), "utf8")).toBe("made while staged\n")
    const [item] = (await w.recovery.status()).interruptedRemovals[0].items
    expect(item).toMatchObject({ original: claude, status: "staged", restorable: false, deletable: true })
    expect(job.log).toContain(`Set aside in a trash dir: ${item.staged} (was ${claude}). Restore or delete it from the banner.`)
    expect(await exists(join(item.staged, "SKILL.md"))).toBe(true)
  })
})

describe("SKILLS_MANAGER_TEST_CRASH_AFTER_STAGE", () => {
  test("honored only with NODE_ENV=test or a fixture HOME", () => {
    const on = { SKILLS_MANAGER_TEST_CRASH_AFTER_STAGE: "1" }
    expect(testCrashAllowed({}, "/tmp/fixture", "/home/me")).toBe(false)
    expect(testCrashAllowed(on, "/home/me", "/home/me")).toBe(false)
    expect(testCrashAllowed(on, "/home/me/", "/home/me")).toBe(false)
    expect(testCrashAllowed({ ...on, NODE_ENV: "production" }, "/home/me", "/home/me")).toBe(false)
    expect(testCrashAllowed(on, "/mnt/data/tmp/sm-r9", "/home/me")).toBe(true)
    expect(testCrashAllowed({ ...on, NODE_ENV: "test" }, "/home/me", "/home/me")).toBe(true)
    expect(testCrashAllowed(on, "/mnt/data/tmp/sm-r9", null)).toBe(false) // passwd unknown: not a fixture
  })
})
