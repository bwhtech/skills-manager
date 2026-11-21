import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { MUTATION_HEADER, type SaveResponse, type ViewedFileContent } from "../../shared/api.ts"
import { createApi } from "../app.ts"
import { READ_ONLY_REFUSAL } from "../discovery/open-path.ts"
import { contentHash } from "../lib/files.ts"
import { SECRET_REFUSAL } from "../lib/secret-paths.ts"
import type { Services } from "../services.ts"

// PUT /api/file through the real /api app: host guard, mutation guard, then the route.

let base: string
let home: string
let outside: string
let api: ReturnType<typeof createApi>

const HOST = "localhost:3530"

async function put(rel: string, content = "text\n") {
  const path = join(home, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

function get(path: string) {
  return api.request(`/file?path=${encodeURIComponent(path)}`, { headers: { host: HOST } })
}

function save(path: string, body: object, headers: Record<string, string> = { [MUTATION_HEADER]: "1" }) {
  return api.request(`/file?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { host: HOST, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

/** A save of `content` over the file's current version. */
async function saveOver(path: string, content: string, headers?: Record<string, string>) {
  const baseHash = contentHash(await readFile(path).catch(() => ""))
  return save(path, { content, baseHash }, headers)
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "sm-file-save-")))
  home = join(base, "home")
  outside = join(base, "outside")
  await mkdir(home)
  await mkdir(outside)
  const fakeServices = {
    skills: { all: async () => [] },
    instructions: { find: async () => null, findByRealPath: async () => null },
  } as unknown as Services
  api = createApi(fakeServices, { fileRoots: { home, roots: [home] } })
})

afterAll(() => rm(base, { recursive: true, force: true }))

describe("GET /api/file", () => {
  test("says whether the file is editable, with its hash", async () => {
    const md = await put("docs/setup.md", "# Setup\n")
    const ts = await put("src/app.ts", "export {}\n")
    const upper = await put("docs/README.MD", "x\n")
    const mdBody = (await (await get(md)).json()) as ViewedFileContent
    expect(mdBody).toMatchObject({ content: "# Setup\n", editable: true, hash: contentHash("# Setup\n") })
    expect(((await (await get(ts)).json()) as ViewedFileContent).editable).toBe(false)
    expect(((await (await get(upper)).json()) as ViewedFileContent).editable).toBe(true)
  })

  test("a Markdown file this process cannot write is not editable", async () => {
    const md = await put("locked/notes.md")
    await chmod(md, 0o444)
    try {
      // Root can write anything: only meaningful as a normal user.
      if (process.getuid?.() !== 0) expect(((await (await get(md)).json()) as ViewedFileContent).editable).toBe(false)
    } finally {
      await chmod(md, 0o644)
    }
  })
})

describe("PUT /api/file", () => {
  test("saves a Markdown file and keeps its mode; a stale baseHash is 409", async () => {
    const md = await put("notes/todo.md", "one\n")
    await chmod(md, 0o600)
    const staleHash = contentHash("one\n")
    const res = await save(md, { content: "two\n", baseHash: staleHash })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SaveResponse
    expect(body.hash).toBe(contentHash("two\n"))
    expect(await readFile(md, "utf8")).toBe("two\n")
    expect((await stat(md)).mode & 0o777).toBe(0o600)

    const conflict = await save(md, { content: "three\n", baseHash: staleHash })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: "conflict", currentHash: contentHash("two\n") })
    expect(await readFile(md, "utf8")).toBe("two\n")

    // force overwrites without a baseHash.
    expect((await save(md, { content: "forced\n", force: true })).status).toBe(200)
    expect(await readFile(md, "utf8")).toBe("forced\n")
  })

  test("other files are read-only: 403 read_only", async () => {
    for (const rel of ["plain.txt", "src/main.ts", "README", "notes.md.bak"]) {
      const path = await put(rel, "keep\n")
      const res = await saveOver(path, "changed\n")
      expect([rel, res.status]).toEqual([rel, 403])
      expect(await res.json()).toEqual({ error: "read_only", detail: READ_ONLY_REFUSAL })
      expect(await readFile(path, "utf8")).toBe("keep\n")
    }
  })

  test("a .md link to a file of another type is read-only", async () => {
    const script = await put("bin/run.sh", "echo hi\n")
    await symlink(script, join(home, "run.md"))
    expect((await saveOver(join(home, "run.md"), "rm -rf /\n")).status).toBe(403)
    expect(await readFile(script, "utf8")).toBe("echo hi\n")
  })

  test("never creates a file: a missing one is 404", async () => {
    const missing = join(home, "nope/new.md")
    const res = await save(missing, { content: "x\n", force: true })
    expect(res.status).toBe(404)
    expect(await lstat(missing).catch(() => null)).toBeNull()
  })

  test("a directory named .md is not a file", async () => {
    await mkdir(join(home, "folder.md"))
    expect((await save(join(home, "folder.md"), { content: "x", force: true })).status).toBe(404)
  })

  test("secret-looking Markdown files are refused, also behind a link", async () => {
    const secrets = [
      await put(".ssh/notes.md", "keys\n"),
      await put(".config/app/secret-notes.md", "s\n"),
      await put(".config/app/api-token.md", "t\n"),
      await put("credentials.md", "c\n"),
    ]
    await symlink(secrets[0], join(home, "innocent.md"))
    for (const path of [...secrets, join(home, "innocent.md")]) {
      const res = await save(path, { content: "pwned\n", force: true })
      expect([path, res.status]).toEqual([path, 403])
      expect(((await res.json()) as { detail: string }).detail).toBe(SECRET_REFUSAL)
    }
    expect(await readFile(secrets[0], "utf8")).toBe("keys\n")
  })

  test("a .md link that leads outside the roots is 403", async () => {
    const target = join(outside, "elsewhere.md")
    await writeFile(target, "outside\n")
    await symlink(target, join(home, "elsewhere.md"))
    const res = await saveOver(join(home, "elsewhere.md"), "pwned\n")
    expect(res.status).toBe(403)
    expect(await readFile(target, "utf8")).toBe("outside\n")
    // Not shown either (as before: 404).
    expect((await get(join(home, "elsewhere.md"))).status).toBe(404)
  })

  test("a .md link inside the roots writes its target and stays a link", async () => {
    const target = await put("real/doc.md", "real\n")
    const link = join(home, "linked.md")
    await symlink(target, link)
    const res = await saveOver(link, "via link\n")
    expect(res.status).toBe(200)
    expect(await readFile(target, "utf8")).toBe("via link\n")
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(target)
  })

  test("needs the mutation header and a same-origin Origin", async () => {
    const md = await put("guarded.md", "keep\n")
    expect((await saveOver(md, "x\n", {})).status).toBe(403)
    expect((await saveOver(md, "x\n", { [MUTATION_HEADER]: "1", origin: "http://evil.example" })).status).toBe(403)
    expect(await readFile(md, "utf8")).toBe("keep\n")
    const badHost = await api.request(`/file?path=${encodeURIComponent(md)}`, {
      method: "PUT",
      headers: { host: "evil.example", [MUTATION_HEADER]: "1", "content-type": "application/json" },
      body: JSON.stringify({ content: "x\n", force: true }),
    })
    expect(badHost.status).toBe(403)
    expect(await badHost.json()).toMatchObject({ error: "bad_host" })
    expect(await readFile(md, "utf8")).toBe("keep\n")
  })

  test("a relative path is 400; a body without baseHash or force is 400", async () => {
    expect((await save("notes/todo.md", { content: "x", force: true })).status).toBe(400)
    const md = await put("body.md")
    expect((await save(md, { content: "x" })).status).toBe(400)
    expect((await save(md, { baseHash: "h" })).status).toBe(400)
  })
})
