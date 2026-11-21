import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  encodeId,
  MUTATION_HEADER,
  type SaveResponse,
  type SkillFileContent,
  type SkillOrigin,
} from "../../shared/api.ts"
import { createApi } from "../app.ts"
import { MARKDOWN_ONLY } from "../discovery/skill-files.ts"
import type { IndexedSkill } from "../discovery/skill-index.ts"
import { contentHash } from "../lib/files.ts"
import type { Services } from "../services.ts"

// PUT /api/skills/:id/file through the real /api app: host guard, mutation guard, then the route.

const HOST = "localhost:3530"
let base: string
let outside: string
let invalidations = 0
const skills: IndexedSkill[] = []
let api: ReturnType<typeof createApi>

function indexed(realPath: string, origin: SkillOrigin): IndexedSkill {
  return {
    id: encodeId(realPath),
    name: "x",
    description: "",
    realPath,
    locations: [realPath],
    agents: [],
    scope: "user",
    scopes: ["user"],
    origin,
    editable: origin === "npx" || origin === "manual",
    cliName: "x",
    folderName: "x",
    placements: [],
    ...(origin === "plugin" ? { pluginName: "demo-plugin" } : {}),
  }
}

/** A skill folder with SKILL.md and `files`, indexed with `origin`. */
async function skill(name: string, origin: SkillOrigin, files: Record<string, string> = {}) {
  const root = join(base, "skills", name)
  for (const [rel, content] of Object.entries({ "SKILL.md": `---\nname: ${name}\n---\n`, ...files })) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  skills.push(indexed(root, origin))
  return root
}

const url = (root: string, rel: string) => `/skills/${encodeId(root)}/file?path=${encodeURIComponent(rel)}`

function get(root: string, rel: string) {
  return api.request(url(root, rel), { headers: { host: HOST } })
}

function save(root: string, rel: string, body: object, headers: Record<string, string> = { [MUTATION_HEADER]: "1" }) {
  return api.request(url(root, rel), {
    method: "PUT",
    headers: { host: HOST, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

/** A save of `content` over the file's current version. */
async function saveOver(root: string, rel: string, content: string, headers?: Record<string, string>) {
  const baseHash = contentHash(await readFile(join(root, rel)).catch(() => ""))
  return save(root, rel, { content, baseHash }, headers)
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "sm-skill-file-save-")))
  outside = join(base, "outside")
  await mkdir(outside)
  const fakeServices = {
    skills: {
      all: async () => skills,
      invalidate: () => {
        invalidations++
      },
    },
    updates: { has: () => false, isDeleted: () => false },
    projects: { has: () => false },
  } as unknown as Services
  api = createApi(fakeServices)
})

afterAll(() => rm(base, { recursive: true, force: true }))

describe("GET /api/skills/:id/file", () => {
  test("says whether the file is editable, with its hash", async () => {
    const root = await skill("get-demo", "manual", { "references/x.md": "# X\n", "scripts/run.ts": "export {}\n" })
    const plugin = await skill("get-plugin", "plugin", { "references/x.md": "# P\n" })
    const md = (await (await get(root, "references/x.md")).json()) as SkillFileContent
    expect(md).toMatchObject({ content: "# X\n", editable: true, hash: contentHash("# X\n") })
    expect(((await (await get(root, "scripts/run.ts")).json()) as SkillFileContent).editable).toBe(false)
    expect(((await (await get(plugin, "references/x.md")).json()) as SkillFileContent).editable).toBe(false)
  })
})

describe("PUT /api/skills/:id/file", () => {
  test("saves references/x.md and keeps its mode; a stale baseHash is 409", async () => {
    const root = await skill("demo", "npx", { "references/x.md": "one\n" })
    const path = join(root, "references/x.md")
    await chmod(path, 0o600)
    const staleHash = contentHash("one\n")
    const before = invalidations
    const res = await save(root, "references/x.md", { content: "two\n", baseHash: staleHash })
    expect(res.status).toBe(200)
    expect(((await res.json()) as SaveResponse).hash).toBe(contentHash("two\n"))
    expect(await readFile(path, "utf8")).toBe("two\n")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    // Not SKILL.md: the index stays.
    expect(invalidations).toBe(before)

    const conflict = await save(root, "references/x.md", { content: "three\n", baseHash: staleHash })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: "conflict", currentHash: contentHash("two\n") })
    expect(await readFile(path, "utf8")).toBe("two\n")
  })

  test("SKILL.md through this route invalidates the skill index", async () => {
    const root = await skill("via-file", "manual")
    const before = invalidations
    const res = await saveOver(root, "SKILL.md", "---\nname: via-file\ndescription: d\n---\n")
    expect(res.status).toBe(200)
    expect(invalidations).toBe(before + 1)
  })

  test("other file types are 403 read_only", async () => {
    const root = await skill("types", "manual", { "scripts/run.ts": "keep\n", "notes.txt": "keep\n", "x.md.bak": "keep\n" })
    for (const rel of ["scripts/run.ts", "notes.txt", "x.md.bak"]) {
      const res = await saveOver(root, rel, "changed\n")
      expect([rel, res.status]).toEqual([rel, 403])
      expect(await res.json()).toEqual({ error: "read_only", detail: MARKDOWN_ONLY })
      expect(await readFile(join(root, rel), "utf8")).toBe("keep\n")
    }
  })

  test("plugin, synced and system skills are 403 read_only", async () => {
    for (const origin of ["plugin", "synced", "system"] as const) {
      const root = await skill(`ro-${origin}`, origin, { "references/x.md": "keep\n" })
      const res = await saveOver(root, "references/x.md", "changed\n")
      expect([origin, res.status]).toEqual([origin, 403])
      const body = (await res.json()) as { error: string; detail: string }
      expect(body.error).toBe("read_only")
      expect(body.detail).toStartWith("This skill is read-only: ")
      expect(await readFile(join(root, "references/x.md"), "utf8")).toBe("keep\n")
    }
  })

  test("a .md link out of the skill folder is 403", async () => {
    const target = join(outside, "elsewhere.md")
    await writeFile(target, "outside\n")
    const root = await skill("leaky", "manual")
    await symlink(target, join(root, "elsewhere.md"))
    const res = await saveOver(root, "elsewhere.md", "pwned\n")
    expect(res.status).toBe(403)
    expect(await readFile(target, "utf8")).toBe("outside\n")
  })

  test("a .md link to a .sh file in the folder is 403", async () => {
    const root = await skill("script-link", "manual", { "run.sh": "echo hi\n" })
    await symlink(join(root, "run.sh"), join(root, "run.md"))
    const res = await saveOver(root, "run.md", "rm -rf /\n")
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "read_only", detail: MARKDOWN_ONLY })
    expect(await readFile(join(root, "run.sh"), "utf8")).toBe("echo hi\n")
  })

  test("a .md under a symlinked dir (not in the file list) is 403", async () => {
    await mkdir(join(outside, "docs"), { recursive: true })
    await writeFile(join(outside, "docs/a.md"), "outside\n")
    const root = await skill("linked-dir", "manual")
    await symlink(join(outside, "docs"), join(root, "docs"))
    expect((await saveOver(root, "docs/a.md", "pwned\n")).status).toBe(403)
    expect(await readFile(join(outside, "docs/a.md"), "utf8")).toBe("outside\n")
  })

  test("never creates a file: a missing one is 404", async () => {
    const root = await skill("missing", "manual")
    const res = await save(root, "references/new.md", { content: "x\n", force: true })
    expect(res.status).toBe(404)
    expect(await lstat(join(root, "references/new.md")).catch(() => null)).toBeNull()
  })

  test("a binary .md is 403", async () => {
    const root = await skill("binary", "manual")
    await writeFile(join(root, "blob.md"), Buffer.from([0x23, 0x00, 0x01]))
    expect((await save(root, "blob.md", { content: "x", force: true })).status).toBe(403)
  })

  test("needs the mutation header and a same-origin Origin", async () => {
    const root = await skill("guarded", "manual", { "references/x.md": "keep\n" })
    expect((await saveOver(root, "references/x.md", "x\n", {})).status).toBe(403)
    expect(
      (await saveOver(root, "references/x.md", "x\n", { [MUTATION_HEADER]: "1", origin: "http://evil.example" })).status
    ).toBe(403)
    expect(await readFile(join(root, "references/x.md"), "utf8")).toBe("keep\n")
  })

  test("a path with .. is 400", async () => {
    const root = await skill("dots", "manual")
    expect((await save(root, "../dots/SKILL.md", { content: "x", force: true })).status).toBe(400)
  })
})
