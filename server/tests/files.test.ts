import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpError } from "../lib/errors.ts"
import { resolveLink, saveTextFile } from "../lib/files.ts"

const dir = await mkdtemp(join(tmpdir(), "skills-manager-test-"))
afterAll(() => rm(dir, { recursive: true, force: true }))

describe("saveTextFile", () => {
  test("saves when baseMtimeMs matches, leaves no temp files", async () => {
    const file = join(dir, "SKILL.md")
    await writeFile(file, "old")
    const base = (await stat(file)).mtimeMs
    const mtime = await saveTextFile(file, {
      content: "new",
      baseMtimeMs: base,
    })
    expect(await readFile(file, "utf8")).toBe("new")
    expect(mtime).toBe((await stat(file)).mtimeMs)
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([])
  })

  test("409 with currentMtimeMs when the file changed", async () => {
    const file = join(dir, "conflict.md")
    await writeFile(file, "a")
    const base = (await stat(file)).mtimeMs - 5000
    const err = await saveTextFile(file, {
      content: "b",
      baseMtimeMs: base,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(409)
    expect(err.extra.currentMtimeMs).toBe((await stat(file)).mtimeMs)
    expect(await readFile(file, "utf8")).toBe("a")
  })

  test("concurrent saves with the same base: one wins, one conflicts", async () => {
    const file = join(dir, "race.md")
    await writeFile(file, "a")
    // An old mtime, so the first write surely moves it past the tolerance.
    await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const base = (await stat(file)).mtimeMs
    const results = await Promise.allSettled([
      saveTextFile(file, { content: "one", baseMtimeMs: base }),
      saveTextFile(file, { content: "two", baseMtimeMs: base }),
    ])
    const ok = results.filter((r) => r.status === "fulfilled")
    const failed = results.filter((r) => r.status === "rejected")
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect((failed[0] as PromiseRejectedResult).reason.status).toBe(409)
    expect(await readFile(file, "utf8")).toBe("one")
  })

  test("force overwrites without a base", async () => {
    const file = join(dir, "force.md")
    await writeFile(file, "a")
    await saveTextFile(file, { content: "b", force: true })
    expect(await readFile(file, "utf8")).toBe("b")
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
