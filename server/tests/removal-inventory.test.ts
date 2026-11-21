import { describe, expect, test } from "bun:test"
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RemovalCopy } from "../../shared/api.ts"
import { gitTreeHash, takeInventory } from "../removal/inventory.ts"
import { planRemovals } from "../removal/plan.ts"
import { makeFixture, wire, type Fixture } from "./removal-harness.ts"

const LIMITS = { maxEntries: 2000, maxReadBytes: 50 * 1024 * 1024 }

/**
 * foo: a canonical folder and a Claude Code copy with the same visible files (SKILL.md and
 * ref.md). `change` alters the copy afterwards. The lock entry has no installMode and the
 * CLI folder hash of the clean copy, so without the change the copy is provably the install.
 */
async function sameVisibleBytes(change: (copy: string, fx: Fixture) => Promise<void>) {
  const fx = await makeFixture()
  const canonical = await fx.skill(".agents/skills", "foo")
  await writeFile(join(canonical, "ref.md"), "reference\n")
  const copy = await fx.skill(".claude/skills", "foo")
  await writeFile(join(copy, "ref.md"), "reference\n")
  const cli = await fx.loadCli()
  await fx.writeLock({ foo: { skillFolderHash: await cli.computeSkillFolderHash!(copy) } })
  await change(copy, fx)
  const w = await wire(fx, {})
  const [remove] = await w.guard.plans("user", ["foo"], { intent: "remove" })
  const [cleanup] = await w.guard.plans("user", ["foo"])
  return { fx, canonical, copy, remove, cleanup }
}

/** The copy differs with these reasons, in both intents, and explicit Remove keeps it opt-in. */
function expectDiffers(
  r: Awaited<ReturnType<typeof sameVisibleBytes>>,
  reasons: (string | RegExp)[]
) {
  for (const plan of [r.remove, r.cleanup]) {
    const copy = plan.copies.find((c) => c.path === r.copy) as RemovalCopy
    expect(copy).toBeDefined()
    expect(copy.identical).toBe(false)
    for (const reason of reasons)
      expect({ reason: String(reason), found: copy.reasons?.some((x) => (typeof reason === "string" ? x === reason : reason.test(x))), reasons: copy.reasons }).toMatchObject({ found: true })
  }
  expect(r.remove.willDelete).not.toContain(r.copy)
  expect(r.remove.promoted).toBeUndefined()
  expect(r.remove.blockedUnlessCopies).toBe(true) // claude-code is detected: the copy blocks
}

describe("deletion inventory: identical means every entry matches (review round 8, item 1)", () => {
  test("baseline: the clean copy is identical, and explicit Remove promotes it on the lock hash", async () => {
    const r = await sameVisibleBytes(async () => {})
    expect(r.cleanup.copies.map((c) => [c.path, c.identical])).toEqual([[r.copy, true]])
    expect(r.remove.willDelete).toEqual([r.copy, r.canonical].sort())
    expect(r.remove.promoted?.map((p) => p.path)).toEqual([r.copy])
  })

  test("the reviewer's case: an extra .git/local-history and a link outside the folder", async () => {
    const r = await sameVisibleBytes(async (copy, fx) => {
      await mkdir(join(copy, ".git"))
      await writeFile(join(copy, ".git/local-history"), "my notes, not in any commit\n")
      await writeFile(join(fx.home, "outside.md"), "elsewhere\n")
      await symlink(join(fx.home, "outside.md"), join(copy, "docs.md"))
    })
    expectDiffers(r, ["has .git history (.git)", /^has a link outside the folder \(docs\.md -> .*outside\.md\)$/])
  })

  test("a dangling link", async () => {
    const r = await sameVisibleBytes((copy) => symlink("missing.md", join(copy, "gone.md")))
    expectDiffers(r, ["has a dangling link (gone.md -> missing.md)"])
  })

  test("a permission change, on a file and on the folder itself", async () => {
    const file = await sameVisibleBytes((copy) => chmod(join(copy, "ref.md"), 0o755))
    expectDiffers(file, [/^permissions differ \(ref\.md \(6[46]4 -> 755\)\)$/])
    const dir = await sameVisibleBytes((copy) => chmod(copy, 0o700))
    expectDiffers(dir, [/^permissions differ \(\. \(7[57]5 -> 700\)\)$/])
  })

  test("a FIFO (never opened, so the walk does not block)", async () => {
    const r = await sameVisibleBytes(async (copy) => {
      expect(Bun.spawnSync(["mkfifo", join(copy, "pipe")]).exitCode).toBe(0)
    })
    expectDiffers(r, ["has a special file (fifo) (pipe)"])
  })

  test("caches, metadata.json and a link inside the folder that the canonical folder lacks", async () => {
    const r = await sameVisibleBytes(async (copy) => {
      await mkdir(join(copy, "__pycache__"))
      await writeFile(join(copy, "__pycache__/x.pyc"), "\0")
      await writeFile(join(copy, "metadata.json"), "{}")
      await symlink("ref.md", join(copy, "alias.md"))
    })
    expectDiffers(r, ["has a cache folder (__pycache__) (__pycache__)", "has metadata.json (metadata.json)", "1 link only in the copy (alias.md)"])
  })

  test("an internal link is compared by its text, not through its target", async () => {
    const r = await sameVisibleBytes(async (copy, fx) => {
      // Same link name on both sides, pointing at files with equal bytes: still differs.
      const canonical = join(fx.home, ".agents/skills/foo")
      await writeFile(join(canonical, "a.md"), "same\n")
      await writeFile(join(canonical, "b.md"), "same\n")
      await writeFile(join(copy, "a.md"), "same\n")
      await writeFile(join(copy, "b.md"), "same\n")
      await symlink("a.md", join(canonical, "link.md"))
      await symlink("b.md", join(copy, "link.md"))
    })
    expectDiffers(r, ["1 link points elsewhere (link.md -> b.md)"])
  })
})

describe("explicit Remove promotes a copy only with provenance (review round 8, item 1)", () => {
  test("no canonical folder: installMode \"copy\" and the lock hash are both needed; extra entries stop it", async () => {
    const fx = await makeFixture()
    const copy = await fx.skill(".claude/skills", "foo")
    const cli = await fx.loadCli()
    const hash = await cli.computeSkillFolderHash!(copy)
    const plan = async (entry: Record<string, string>) => {
      await fx.writeLock({ foo: entry })
      const [p] = await planRemovals(
        { scope: "user", home: fx.home, agents: cli.agents, cli, lock: await fx.readLock("user"), intent: "remove" },
        ["foo"]
      )
      return p
    }
    expect((await plan({ skillFolderHash: hash })).willDelete).toEqual([]) // no installMode
    expect((await plan({ installMode: "copy", skillFolderHash: "f".repeat(64) })).willDelete).toEqual([])
    const ok = await plan({ installMode: "copy", skillFolderHash: hash })
    expect(ok.willDelete).toEqual([copy])
    expect(ok.promoted?.[0].reason).toBe('copy the skills CLI installed (installMode "copy"): its CLI folder hash matches the lock')
    // The CLI hash skips these, so it cannot vouch for them.
    await writeFile(join(copy, "metadata.json"), "{}")
    expect(await cli.computeSkillFolderHash!(copy)).toBe(hash)
    const meta = await plan({ installMode: "copy", skillFolderHash: hash })
    expect(meta.willDelete).toEqual([])
    expect(meta.copies[0].reasons).toEqual(["no canonical folder to compare with", "has metadata.json (metadata.json)"])
  })

  test("a GitHub install: the lock's 40-hex skillFolderHash is checked as a Git tree id", async () => {
    const fx = await makeFixture()
    const canonical = await fx.skill(".agents/skills", "foo")
    const copy = await fx.skill(".claude/skills", "foo")
    for (const dir of [canonical, copy]) {
      await mkdir(join(dir, "scripts"))
      await writeFile(join(dir, "scripts/run.sh"), "#!/bin/sh\necho hi\n")
      await chmod(join(dir, "scripts/run.sh"), 0o755)
    }
    const tree = gitTreeHash(await takeInventory(copy, LIMITS)) as string
    await fx.writeLock({ foo: { skillFolderHash: tree } })
    const w = await wire(fx, {})
    const [plan] = await w.guard.plans("user", ["foo"], { intent: "remove" })
    expect(plan.willDelete).toEqual([copy, canonical].sort())
    expect(plan.promoted?.[0].reason).toContain("its Git tree id matches the lock's skillFolderHash")
    await fx.writeLock({ foo: { skillFolderHash: "0".repeat(40) } })
    const [other] = await w.guard.plans("user", ["foo"], { intent: "remove" })
    expect(other.blockedUnlessCopies).toBe(true)
    expect(other.willDelete).not.toContain(copy)
    expect(other.copies.map((c) => [c.path, c.identical])).toEqual([[copy, true]])
  })

  test("gitTreeHash equals what git itself computes", async () => {
    const fx = await makeFixture()
    const repo = join(fx.home, "repo")
    const skill = join(repo, "skills/foo")
    await mkdir(join(skill, "refs/deep"), { recursive: true })
    await writeFile(join(skill, "SKILL.md"), "---\nname: foo\n---\r\nCRLF body\r\n")
    await writeFile(join(skill, "refs/a.md"), "a\n")
    await writeFile(join(skill, "refs/deep/b.bin"), new Uint8Array([0, 1, 2, 255]))
    await writeFile(join(skill, "refs-x.md"), "sorts between refs/ and refs.md\n")
    await writeFile(join(skill, "refs.md"), "r\n")
    await writeFile(join(skill, "run"), "#!/bin/sh\n")
    await chmod(join(skill, "run"), 0o750)
    await symlink("refs/a.md", join(skill, "link"))
    const git = (...args: string[]) => {
      const out = Bun.spawnSync(["git", "-C", repo, "-c", "core.autocrlf=false", ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      })
      expect(out.exitCode).toBe(0)
      return out.stdout.toString().trim()
    }
    git("init", "-q")
    git("add", "-A")
    const root = git("write-tree")
    expect(gitTreeHash(await takeInventory(skill, LIMITS))).toBe(git("rev-parse", `${root}:skills/foo`))
  })
})
