import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpError } from "../lib/errors.ts"
import {
  canonicalPath,
  readTextFile,
  resolveLink,
  saveTextFile,
} from "../lib/files.ts"

const dir = await mkdtemp(join(tmpdir(), "skills-manager-test-"))
afterAll(() => rm(dir, { recursive: true, force: true }))

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

describe("saveTextFile", () => {
  test("saves when baseHash matches, leaves no temp files", async () => {
    const file = join(dir, "SKILL.md")
    await writeFile(file, "old")
    const loaded = await readTextFile(file)
    expect(loaded.hash).toBe(sha("old"))
    const saved = await saveTextFile(file, {
      content: "new",
      baseHash: loaded.hash,
    })
    expect(await readFile(file, "utf8")).toBe("new")
    expect(saved.hash).toBe(sha("new"))
    expect(saved.mtimeMs).toBe((await stat(file)).mtimeMs)
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([])
  })

  test("409 with currentHash when the content changed", async () => {
    const file = join(dir, "conflict.md")
    await writeFile(file, "a")
    const err = await saveTextFile(file, {
      content: "b",
      baseHash: sha("something else"),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(409)
    expect(err.extra.currentHash).toBe(sha("a"))
    expect(err.extra.currentMtimeMs).toBe((await stat(file)).mtimeMs)
    expect(await readFile(file, "utf8")).toBe("a")
  })

  test("a save without baseHash or force is rejected", async () => {
    const file = join(dir, "nobase.md")
    await writeFile(file, "a")
    const err = await saveTextFile(file, { content: "b" }).catch((e) => e)
    expect(err.status).toBe(400)
    expect(await readFile(file, "utf8")).toBe("a")
  })

  test("concurrent saves with the same base: exactly one 409, 100 times", async () => {
    const file = join(dir, "race.md")
    for (let i = 0; i < 100; i++) {
      await writeFile(file, `base ${i}`)
      const baseHash = (await readTextFile(file)).hash
      const results = await Promise.allSettled([
        saveTextFile(file, { content: `one ${i}`, baseHash }),
        saveTextFile(file, { content: `two ${i}`, baseHash }),
      ])
      const failed = results.filter((r) => r.status === "rejected")
      expect(failed).toHaveLength(1)
      expect((failed[0] as PromiseRejectedResult).reason.status).toBe(409)
      // Either may win; the file holds the winner's content.
      const winner = results[0].status === "fulfilled" ? "one" : "two"
      expect(await readFile(file, "utf8")).toBe(`${winner} ${i}`)
    }
  })

  test("aliases of one file share a lock: exactly one 409", async () => {
    const realDir = join(dir, "real-dir")
    await mkdir(realDir)
    const file = join(realDir, "AGENTS.md")
    const viaParent = join(dir, "dir-alias", "AGENTS.md")
    const viaLink = join(dir, "file-alias.md")
    await writeFile(file, "start")
    await symlink(realDir, join(dir, "dir-alias"))
    await symlink(file, viaLink)
    expect(await canonicalPath(viaParent)).toBe(await realpath(file))
    expect(await canonicalPath(viaLink)).toBe(await realpath(file))
    for (let i = 0; i < 100; i++) {
      await writeFile(file, `base ${i}`)
      const baseHash = sha(`base ${i}`)
      const contents = [`real ${i}`, `parent ${i}`, `link ${i}`]
      const results = await Promise.allSettled(
        [file, viaParent, viaLink].map((path, n) =>
          saveTextFile(path, { content: contents[n], baseHash })
        )
      )
      const won = results.findIndex((r) => r.status === "fulfilled")
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      for (const r of results)
        if (r.status === "rejected") expect(r.reason.status).toBe(409)
      expect(await readFile(file, "utf8")).toBe(contents[won])
    }
    // The link stays a link: writes go to the real file.
    expect((await lstat(viaLink)).isSymbolicLink()).toBe(true)
  })

  test("canonicalPath of a missing file resolves its parent dir", async () => {
    expect(await canonicalPath(join(dir, "dir-alias", "new.md"))).toBe(
      join(await realpath(join(dir, "real-dir")), "new.md")
    )
  })

  test("force overwrites without a base", async () => {
    const file = join(dir, "force.md")
    await writeFile(file, "a")
    await saveTextFile(file, { content: "b", force: true })
    expect(await readFile(file, "utf8")).toBe("b")
  })

  test("resolved: writes the target as given and reports a redirect after the rename", async () => {
    const real = await realpath(dir)
    const parent = join(real, "resolved-parent")
    const elsewhere = join(real, "resolved-elsewhere")
    await mkdir(parent)
    await mkdir(elsewhere)
    await writeFile(join(parent, "a.md"), "a")
    await writeFile(join(elsewhere, "a.md"), "other")
    const target = join(parent, "a.md")
    const ok = await saveTextFile(target, { content: "a2", baseHash: sha("a") }, { resolved: true })
    expect(ok.hash).toBe(sha("a2"))

    // A parent dir swapped for a symlink during the save: the write goes through it, and the
    // check after the rename sees that the path no longer resolves to itself.
    const errors: unknown[] = []
    const log = console.error
    console.error = (...args: unknown[]) => void errors.push(args)
    try {
      const swap = async () => {
        await rename(parent, `${parent}.moved`)
        await symlink(elsewhere, parent)
      }
      const err = await saveTextFile(target, { content: "x", force: true }, { resolved: true, guard: swap }).catch(
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).message).toBe("redirected")
      expect(errors.length).toBe(1)
    } finally {
      console.error = log
    }
  })
})

describe("resolveLink", () => {
  test("follows symlinks, also dangling ones", async () => {
    await writeFile(join(dir, "AGENTS.md"), "x")
    await symlink("AGENTS.md", join(dir, "CLAUDE.md"))
    await symlink("missing.md", join(dir, "dangling.md"))
    const linked = await resolveLink(join(dir, "CLAUDE.md"))
    expect(linked).toMatchObject({ isLink: true, exists: true })
    expect(linked.target.endsWith("/AGENTS.md")).toBe(true)
    expect(await resolveLink(join(dir, "dangling.md"))).toEqual({
      isLink: true,
      exists: false,
      target: join(dir, "missing.md"),
    })
    expect(await resolveLink(join(dir, "nope.md"))).toEqual({
      isLink: false,
      exists: false,
      target: join(dir, "nope.md"),
    })
  })
})
