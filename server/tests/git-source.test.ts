import { afterAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { HttpError } from "../lib/errors.ts"
import {
  GitSource,
  folderPattern,
  type Limiter,
} from "../preview/git-source.ts"
import type { PreviewPlan } from "../preview/plan.ts"
import { locateSkill } from "../preview/service.ts"

const tmp = await mkdtemp(join(tmpdir(), "skills-manager-git-test-"))
afterAll(() => rm(tmp, { recursive: true, force: true }))

const md = (name: string) => `---\nname: ${name}\ndescription: d\n---\n`
const limiter: Limiter = (fn) => fn(AbortSignal.timeout(20_000))

function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
  if (res.exitCode !== 0) throw new Error(res.stderr.toString())
  return res.stdout.toString().trim()
}

/** A bare repo with these files; `filter` lets the server honor blob:none. */
async function bareRepo(
  name: string,
  files: Record<string, string | Uint8Array>,
  filter = true
): Promise<{ url: string; sha: string }> {
  const work = join(tmp, `${name}-work`)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true })
    await writeFile(join(work, path), content)
  }
  git(work, "init", "-q", "-b", "main")
  git(work, "add", "-A")
  git(work, "commit", "-qm", "init")
  const bare = join(tmp, `${name}.git`)
  git(tmp, "clone", "-q", "--bare", work, bare)
  git(bare, "config", "uploadpack.allowFilter", String(filter))
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  return { url: `file://${bare}`, sha: git(work, "rev-parse", "HEAD") }
}

/** Files under dir, relative, without .git. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .filter((p) => !p.startsWith(".git/"))
    .sort()
}

const files = {
  "README.md": "root file\n",
  "package.json": "{}\n",
  "skills/foo/SKILL.md": md("foo"),
  "skills/foo/ref/a.md": "a\n",
  "skills/bar/SKILL.md": md("bar"),
  "skills/bar/extra.md": "not needed\n",
  "odd dir/a*b[1]/SKILL.md": md("odd"),
  "odd dir/a*bX/SKILL.md": md("not-odd"),
  "moved/deep/foo2/SKILL.md": md("moved-skill"),
  "moved/deep/foo2/notes.md": "n\n",
}

describe("GitSource", async () => {
  const repo = await bareRepo("main", files)
  const source = new GitSource(null, { protocols: "file" })

  async function fetch(ref: string | null = null) {
    const dir = await mkdtemp(join(tmp, "dir-"))
    const checkout = await source.fetch(
      repo.url,
      ref,
      dir,
      AbortSignal.timeout(20_000),
      limiter
    )
    return { dir, checkout }
  }

  test("clones without a checkout: no root files on disk", async () => {
    const { checkout } = await fetch()
    expect(checkout.ref).toBe(repo.sha)
    expect(await listFiles(checkout.root)).toEqual([])
    expect((await checkout.listSkillMds()).map((m) => m.path).sort()).toEqual(
      Object.keys(files)
        .filter((p) => p.endsWith("SKILL.md"))
        .sort()
    )
  })

  test("a folder checks out only that folder, names matched literally", async () => {
    const { checkout } = await fetch()
    expect(await checkout.folder("skills/foo")).toBe(
      join(checkout.root, "skills/foo")
    )
    expect(await listFiles(checkout.root)).toEqual([
      "skills/foo/SKILL.md",
      "skills/foo/ref/a.md",
    ])
    await checkout.folder("odd dir/a*b[1]")
    expect(await listFiles(checkout.root)).toEqual([
      "odd dir/a*b[1]/SKILL.md",
      "skills/foo/SKILL.md",
      "skills/foo/ref/a.md",
    ])
  })

  test("a commit sha that is not a branch is fetched directly", async () => {
    const { checkout } = await fetch(repo.sha)
    expect(checkout.ref).toBe(repo.sha)
    await checkout.folder("skills/bar")
    expect(await listFiles(checkout.root)).toEqual([
      "skills/bar/SKILL.md",
      "skills/bar/extra.md",
    ])
  })

  test("a moved skill is found by the CLI's discovery; only SKILL.md files come down for it", async () => {
    const { checkout } = await fetch()
    const plan: PreviewPlan = {
      spec: { kind: "git", url: repo.url, ref: null },
      skillPath: "skills/gone/SKILL.md",
      sourceName: "moved-skill",
      renameTo: null,
      fullDepth: false,
    }
    const discovered = await checkout.discover()
    expect(discovered.map((s) => s.name).sort()).toEqual([
      "bar",
      "foo",
      "moved-skill",
      "not-odd",
      "odd",
    ])
    expect(await listFiles(checkout.root)).toEqual(
      Object.keys(files)
        .filter((p) => p.endsWith("SKILL.md"))
        .sort()
    )
    const found = await locateSkill(checkout, plan)
    expect(found.dir).toBe(join(checkout.root, "moved/deep/foo2"))
    expect(await listFiles(found.dir)).toEqual(["SKILL.md", "notes.md"])
    expect(await listFiles(checkout.root)).not.toContain("README.md")
  })

  test("a server that ignores the blob filter hits the quota: 413", async () => {
    const big = await bareRepo(
      "nofilter",
      { "skills/foo/SKILL.md": md("foo"), "blob.bin": randomBytes(2 << 20) },
      false
    )
    const small = new GitSource(null, {
      protocols: "file",
      maxSourceBytes: 512 * 1024,
    })
    const dir = await mkdtemp(join(tmp, "quota-"))
    const err = await small
      .fetch(big.url, null, dir, AbortSignal.timeout(20_000), limiter)
      .catch((e) => e as HttpError)
    expect(err).toMatchObject({ status: 413, message: "preview_too_large" })
  })

  test("a checkout past the quota is a 413 and frees the clone", async () => {
    const big = await bareRepo("bigfolder", {
      "skills/foo/SKILL.md": md("foo"),
      "skills/big/SKILL.md": md("big"),
      "skills/big/blob.bin": randomBytes(2 << 20),
    })
    const small = new GitSource(null, {
      protocols: "file",
      maxSourceBytes: 512 * 1024,
    })
    const dir = await mkdtemp(join(tmp, "quota2-"))
    const checkout = await small.fetch(
      big.url,
      null,
      dir,
      AbortSignal.timeout(20_000),
      limiter
    )
    await checkout.folder("skills/foo")
    const err = await checkout.folder("skills/big").catch((e) => e)
    expect(err).toMatchObject({ status: 413, message: "preview_too_large" })
    expect(await readdir(dir)).toEqual([])
    await expect(checkout.folder("skills/foo")).rejects.toMatchObject({
      status: 413,
    })
  })
})

test("folderPattern escapes glob characters and refuses control characters", () => {
  expect(folderPattern("")).toBe("/*")
  expect(folderPattern("skills/foo")).toBe("/skills/foo/")
  expect(folderPattern("odd dir/a*b[1]?")).toBe("/odd\\ dir/a\\*b\\[1\\]\\?/")
  expect(() => folderPattern("a\n/*")).toThrow()
})
