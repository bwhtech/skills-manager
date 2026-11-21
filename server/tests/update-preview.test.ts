import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { SkillActions } from "../actions.ts"
import type { SkillsCli } from "../cli/skills-cli.ts"
import type { LockEntry } from "../discovery/locks.ts"
import type { IndexedSkill } from "../discovery/skill-index.ts"
import { JobManager } from "../jobs.ts"
import { HttpError } from "../lib/errors.ts"
import { MAX_DIFF_BYTES, diffFolders } from "../preview/folder-diff.ts"
import { countLineChanges } from "../preview/line-diff.ts"
import { planUpdate, type SourceSpec } from "../preview/plan.ts"
import {
  UpdatePreviewService,
  locateSkill,
  setFrontmatterName,
} from "../preview/service.ts"
import {
  SourceCache,
  type Checkout,
  type Fetcher,
} from "../preview/source-cache.ts"

const tmp = await mkdtemp(join(tmpdir(), "skills-manager-preview-test-"))
afterAll(() => rm(tmp, { recursive: true, force: true }))

async function tree(root: string, files: Record<string, string | Uint8Array>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

describe("countLineChanges", () => {
  test("counts a shortest edit", () => {
    expect(countLineChanges("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({
      linesAdded: 2,
      linesRemoved: 1,
    })
    expect(countLineChanges("", "x\ny")).toEqual({
      linesAdded: 2,
      linesRemoved: 0,
    })
    expect(countLineChanges("x\n", "")).toEqual({
      linesAdded: 0,
      linesRemoved: 1,
    })
    expect(countLineChanges("same\n", "same\n")).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
    })
  })

  test("moved block counts as remove plus add", () => {
    expect(countLineChanges("1\n2\n3\n4\n", "3\n4\n1\n2\n")).toEqual({
      linesAdded: 2,
      linesRemoved: 2,
    })
  })
})

describe("diffFolders", () => {
  test("added, removed, modified, binary, tooLarge; SKILL.md first", async () => {
    const big = "x\n".repeat(MAX_DIFF_BYTES / 2 + 10)
    const local = await tree(join(tmp, "local"), {
      "SKILL.md": "---\nname: s\n---\nold\n",
      "a.md": "same\n",
      "gone.md": "bye\n",
      "img.png": new Uint8Array([1, 0, 2]),
      "big.txt": big,
      "node_modules/x.js": "ignored",
      "local-only/metadata.json": "{}",
    })
    const upstream = await tree(join(tmp, "upstream"), {
      "SKILL.md": "---\nname: s\n---\nnew\nmore\n",
      "a.md": "same\n",
      "new/b.md": "hello\n",
      "img.png": new Uint8Array([1, 0, 3]),
      "big.txt": big + "y\n",
      "metadata.json": "{}",
      "__pycache__/c.pyc": "x",
      ".git/HEAD": "ref",
    })
    const diff = await diffFolders(local, upstream)
    expect(diff.upToDate).toBe(false)
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([
      ["SKILL.md", "modified"],
      ["big.txt", "modified"],
      ["gone.md", "removed"],
      ["img.png", "modified"],
      // the CLI drops metadata.json when it copies, so update deletes it
      ["local-only/metadata.json", "removed"],
      ["new/b.md", "added"],
    ])
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]))
    expect(byPath["SKILL.md"]).toMatchObject({
      oldContent: "---\nname: s\n---\nold\n",
      newContent: "---\nname: s\n---\nnew\nmore\n",
      linesAdded: 2,
      linesRemoved: 1,
      binary: false,
    })
    expect(byPath["gone.md"].newContent).toBeUndefined()
    expect(byPath["gone.md"]).toMatchObject({
      oldContent: "bye\n",
      linesRemoved: 1,
    })
    expect(byPath["new/b.md"].oldContent).toBeUndefined()
    expect(byPath["img.png"]).toMatchObject({ binary: true, linesAdded: 0 })
    expect(byPath["img.png"].oldContent).toBeUndefined()
    expect(byPath["big.txt"]).toMatchObject({ tooLarge: true, linesAdded: 1 })
    expect(byPath["big.txt"].oldContent).toBeUndefined()
    expect(byPath["big.txt"].newContent).toBeUndefined()
    expect(diff.summary).toEqual({
      added: 1,
      removed: 2,
      modified: 3,
      linesAdded: 4,
      linesRemoved: 3,
    })
  })

  test("identical folders are up to date", async () => {
    const files = { "SKILL.md": "a\n", "ref/x.md": "b\n" }
    const a = await tree(join(tmp, "same-a"), files)
    const b = await tree(join(tmp, "same-b"), files)
    expect(await diffFolders(a, b)).toEqual({
      upToDate: true,
      files: [],
      summary: {
        added: 0,
        removed: 0,
        modified: 0,
        linesAdded: 0,
        linesRemoved: 0,
      },
    })
  })

  test("follows symlinks inside the folder, skips ones that leave it", async () => {
    const outside = await tree(join(tmp, "outside"), { "secret.txt": "s\n" })
    const local = await tree(join(tmp, "link-local"), { "SKILL.md": "a\n" })
    const upstream = await tree(join(tmp, "link-upstream"), {
      "SKILL.md": "a\n",
      "real/doc.md": "d\n",
    })
    await symlink(join(outside, "secret.txt"), join(upstream, "leak.txt"))
    await symlink("real", join(upstream, "alias"))
    await symlink("missing", join(upstream, "broken"))
    const diff = await diffFolders(local, upstream)
    expect(diff.files.map((f) => f.path)).toEqual([
      "alias/doc.md",
      "real/doc.md",
    ])
  })

  test("overrides replace upstream bytes", async () => {
    const local = await tree(join(tmp, "ov-local"), { "SKILL.md": "x\n" })
    const upstream = await tree(join(tmp, "ov-up"), { "SKILL.md": "y\n" })
    const overrides = new Map([["SKILL.md", new TextEncoder().encode("x\n")]])
    expect((await diffFolders(local, upstream, overrides)).upToDate).toBe(true)
  })
})

describe("SourceCache", () => {
  const spec = (url: string): SourceSpec => ({ kind: "git", url, ref: null })
  const stubCheckout: Checkout = {
    ref: "abc",
    listSkillMds: async () => [],
    folder: async (p) => p,
  }

  function stubFetcher(delayMs = 20) {
    let calls = 0
    let active = 0
    let peak = 0
    const fetcher: Fetcher = async (_spec, dir) => {
      calls++
      active++
      peak = Math.max(peak, active)
      await writeFile(join(dir, "marker"), "x")
      await Bun.sleep(delayMs)
      active--
      return stubCheckout
    }
    return { fetcher, stats: () => ({ calls, peak }) }
  }

  async function newCache(fetcher: Fetcher, ttlMs = 60_000) {
    const root = await mkdtemp(join(tmp, "cache-"))
    await writeFile(join(root, "leftover"), "old run")
    const cache = new SourceCache(fetcher, {
      root,
      ttlMs,
      maxConcurrent: 3,
      timeoutMs: 1000,
    })
    await cache.init()
    return { cache, root }
  }

  test("init wipes what an earlier run left", async () => {
    const { root } = await newCache(stubFetcher().fetcher)
    expect(await readdir(root)).toEqual([])
  })

  test("concurrent requests for one source share one fetch", async () => {
    const { fetcher, stats } = stubFetcher()
    const { cache } = await newCache(fetcher)
    const leases = await Promise.all(
      Array.from({ length: 10 }, () => cache.acquire(spec("https://x/a.git")))
    )
    expect(stats().calls).toBe(1)
    expect(new Set(leases.map((l) => l.fetchedAt)).size).toBe(1)
    await cache.acquire(spec("https://x/a.git"))
    expect(stats().calls).toBe(1)
  })

  test("at most 3 fetches run at once", async () => {
    const { fetcher, stats } = stubFetcher()
    const { cache } = await newCache(fetcher)
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        cache.acquire(spec(`https://x/${i}.git`))
      )
    )
    expect(stats()).toEqual({ calls: 7, peak: 3 })
  })

  test("a failed fetch is not cached and its dir is removed", async () => {
    let calls = 0
    const fetcher: Fetcher = async () => {
      calls++
      throw new HttpError(502, "fetch_failed", "boom")
    }
    const { cache, root } = await newCache(fetcher)
    await expect(cache.acquire(spec("https://x/f.git"))).rejects.toThrow(
      "fetch_failed"
    )
    await expect(cache.acquire(spec("https://x/f.git"))).rejects.toThrow(
      "fetch_failed"
    )
    expect(calls).toBe(2)
    expect(await readdir(root)).toEqual([])
  })

  test("expiry deletes the dir, but only after the last lease is released", async () => {
    const { fetcher, stats } = stubFetcher(0)
    const { cache, root } = await newCache(fetcher, 30)
    const lease = await cache.acquire(spec("https://x/t.git"))
    await Bun.sleep(60)
    expect(cache.size).toBe(0)
    expect(await readdir(root)).toHaveLength(1)
    lease.release()
    await Bun.sleep(20)
    expect(await readdir(root)).toEqual([])
    await cache.acquire(spec("https://x/t.git"))
    expect(stats().calls).toBe(2)
  })

  test("invalidate forces a refetch", async () => {
    const { fetcher, stats } = stubFetcher(0)
    const { cache } = await newCache(fetcher)
    ;(await cache.acquire(spec("https://x/i.git"))).release()
    cache.invalidateAll()
    await cache.acquire(spec("https://x/i.git"))
    expect(stats().calls).toBe(2)
  })
})

describe("planUpdate", () => {
  const github: LockEntry = {
    source: "owner/repo",
    sourceType: "github",
    sourceUrl: "https://github.com/owner/repo.git",
    skillPath: "skills/foo/SKILL.md",
    skillFolderHash: "abc",
  }

  test("global GitHub entry clones the repo at the locked ref", () => {
    expect(planUpdate({ ...github, ref: "v1" }, "foo", true)).toEqual({
      spec: {
        kind: "git",
        url: "https://github.com/owner/repo.git",
        ref: "v1",
      },
      skillPath: "skills/foo/SKILL.md",
      sourceName: "foo",
      renameTo: null,
    })
  })

  test("project shorthand without sourceUrl becomes a GitHub URL", () => {
    const entry: LockEntry = {
      source: "o/r",
      sourceType: "github",
      skillPath: "SKILL.md",
    }
    expect(planUpdate(entry, "r", false).spec).toEqual({
      kind: "git",
      url: "https://github.com/o/r.git",
      ref: null,
    })
  })

  test("renamed installs keep the source name and rename on install", () => {
    const plan = planUpdate({ ...github, skillName: "foo" }, "my-foo", true)
    expect(plan).toMatchObject({ sourceName: "foo", renameTo: "my-foo" })
  })

  test("entries the CLI skips are 400", () => {
    const status = (fn: () => unknown) => {
      try {
        fn()
      } catch (err) {
        return (err as HttpError).status
      }
      return 200
    }
    expect(
      status(() =>
        planUpdate({ ...github, skillFolderHash: undefined }, "f", true)
      )
    ).toBe(400)
    expect(
      status(() =>
        planUpdate({ source: "/x", sourceType: "local" }, "f", false)
      )
    ).toBe(400)
    expect(
      status(() =>
        planUpdate({ source: "o/r", sourceType: "github" }, "f", false)
      )
    ).toBe(400)
    expect(
      status(() =>
        planUpdate(
          { source: "o/r", sourceType: "git", skillPath: "SKILL.md" },
          "f",
          false
        )
      )
    ).toBe(400)
    expect(
      status(() => planUpdate({ ...github, ref: "--upload-pack=x" }, "f", true))
    ).toBe(400)
    expect(
      status(() =>
        planUpdate(
          { ...github, sourceType: "git", sourceUrl: "ext::sh -c x" },
          "f",
          true
        )
      )
    ).toBe(400)
  })

  test("well-known and download sources", () => {
    const wk = planUpdate(
      {
        source: "example.com",
        sourceType: "well-known",
        sourceBaseUrl: "https://example.com",
        wellKnownDigest: "sha256:x",
      },
      "w",
      true
    )
    expect(wk.spec).toEqual({ kind: "well-known", url: "https://example.com" })
    const dl = planUpdate(
      {
        source: "x",
        sourceType: "download",
        sourceUrl: "https://example.com/s.zip",
      },
      "d",
      false
    )
    expect(dl.spec).toEqual({
      kind: "download",
      url: "https://example.com/s.zip",
    })
  })
})

describe("locateSkill", () => {
  async function checkout(files: Record<string, string>): Promise<Checkout> {
    const root = await tree(await mkdtemp(join(tmp, "co-")), files)
    return {
      ref: null,
      listSkillMds: async () =>
        Object.keys(files)
          .filter((p) => p.endsWith("SKILL.md"))
          .map((path) => ({ path })),
      folder: async (p) => (p ? join(root, p) : root),
    }
  }
  const plan = (skillPath: string | null, sourceName = "foo") => ({
    spec: { kind: "git" as const, url: "https://x/r.git", ref: null },
    skillPath,
    sourceName,
    renameTo: null,
  })

  test("uses the locked path, else the folder with the skill's name", async () => {
    const co = await checkout({
      "skills/foo/SKILL.md": "---\nname: foo\n---\n",
      "moved/foo/SKILL.md": "---\nname: foo\n---\n",
    })
    expect(await locateSkill(co, plan("skills/foo/SKILL.md"))).toEndWith(
      "/skills/foo"
    )
    const moved = await checkout({
      "moved/foo/SKILL.md": "---\nname: foo\n---\n",
    })
    expect(await locateSkill(moved, plan("skills/foo/SKILL.md"))).toEndWith(
      "/moved/foo"
    )
  })

  test("deleted, ambiguous or renamed upstream is 409", async () => {
    const statusOf = (p: Promise<unknown>) =>
      p.then(
        () => 200,
        (err) => (err as HttpError).status
      )
    const gone = await checkout({
      "skills/bar/SKILL.md": "---\nname: bar\n---\n",
    })
    expect(await statusOf(locateSkill(gone, plan("skills/foo/SKILL.md")))).toBe(
      409
    )
    const twice = await checkout({
      "a/foo/SKILL.md": "---\nname: foo\n---\n",
      "b/foo/SKILL.md": "---\nname: foo\n---\n",
    })
    expect(await statusOf(locateSkill(twice, plan(null)))).toBe(409)
    const renamed = await checkout({
      "skills/foo/SKILL.md": "---\nname: other\n---\n",
    })
    expect(
      await statusOf(locateSkill(renamed, plan("skills/foo/SKILL.md")))
    ).toBe(409)
  })
})

test("setFrontmatterName matches the CLI's rewrite", () => {
  expect(
    setFrontmatterName("---\nname: a\ndescription: d\n---\nbody", "b")
  ).toBe("---\nname: b\ndescription: d\n---\nbody")
  expect(setFrontmatterName("---\ndescription: d\n---\n", "b")).toBe(
    "---\nname: b\ndescription: d\n---\n"
  )
  expect(setFrontmatterName("no frontmatter", "b")).toBe("no frontmatter")
})

describe("UpdatePreviewService", () => {
  async function setup() {
    const project = await mkdtemp(join(tmp, "project-"))
    const lock = {
      version: 1,
      skills: {
        foo: {
          source: "o/r",
          sourceType: "github",
          skillPath: "skills/foo/SKILL.md",
        },
      },
    }
    await writeFile(join(project, "skills-lock.json"), JSON.stringify(lock))
    const realPath = await tree(join(project, ".agents/skills/foo"), {
      "SKILL.md": "---\nname: foo\n---\nlocal edit\n",
    })
    let calls = 0
    const specs: SourceSpec[] = []
    const fetcher: Fetcher = async (spec, dir) => {
      calls++
      specs.push(spec)
      await tree(dir, {
        "skills/foo/SKILL.md": "---\nname: foo\n---\nupstream\n",
      })
      return {
        ref: "f".repeat(40),
        listSkillMds: async () => [{ path: "skills/foo/SKILL.md" }],
        folder: async (p) => join(dir, p),
      }
    }
    const service = new UpdatePreviewService(
      {
        root: join(project, "cache"),
        ttlMs: 60_000,
        maxConcurrent: 3,
        timeoutMs: 1000,
      },
      fetcher
    )
    await service.init()
    const skill = {
      id: "id",
      name: "foo",
      cliName: "foo",
      origin: "npx",
      scope: project,
      realPath,
    } as unknown as IndexedSkill
    return { service, skill, project, calls: () => calls, specs }
  }

  test("previews a project skill and refetches after its update", async () => {
    const { service, skill, project, calls, specs } = await setup()
    const preview = await service.preview(skill)
    expect(specs[0]).toEqual({
      kind: "git",
      url: "https://github.com/o/r.git",
      ref: null,
    })
    expect(preview).toMatchObject({
      skillId: "id",
      scope: project,
      source: "o/r",
      remoteRef: "f".repeat(40),
      upToDate: false,
      summary: { modified: 1, linesAdded: 1, linesRemoved: 1 },
    })
    expect(preview.files[0]).toMatchObject({
      path: "SKILL.md",
      oldContent: "---\nname: foo\n---\nlocal edit\n",
      newContent: "---\nname: foo\n---\nupstream\n",
    })
    await service.preview(skill)
    expect(calls()).toBe(1)
    service.invalidate("user", [])
    service.invalidate(project, ["other"])
    await service.preview(skill)
    expect(calls()).toBe(1)
    service.invalidate(project, ["FOO"])
    await service.preview(skill)
    expect(calls()).toBe(2)
    service.invalidate(project, [])
    await service.preview(skill)
    expect(calls()).toBe(3)
  })

  test("non-npx skills are 400", async () => {
    const { service, skill } = await setup()
    const manual = { ...skill, origin: "manual" } as IndexedSkill
    await expect(service.preview(manual)).rejects.toMatchObject({ status: 400 })
  })
})

test("an update job calls afterUpdate with its scope and names", async () => {
  const cli = {
    display: () => "skills update a -g -y",
    stream: async () => ({ exitCode: 1, timedOut: false }),
  } as unknown as SkillsCli
  const calls: [string, string[]][] = []
  const jobs = new JobManager()
  const actions = new SkillActions(cli, jobs, {
    afterUpdate: (scope, names) => calls.push([scope, names]),
  })
  const job = actions.update({ scope: "user", names: ["a"] })
  await new Promise<void>((resolve) =>
    jobs.subscribe(job.id, (e) => e.type === "done" && resolve())
  )
  expect(calls).toEqual([["user", ["a"]]])
})
