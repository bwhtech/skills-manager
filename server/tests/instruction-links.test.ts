import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  link as hardLink,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type {
  InstructionFile,
  SaveResponse,
  LinkInstructionResponse,
  SyncPreview,
  UnlinkInstructionResponse,
} from "../../shared/api.ts"
import { encodeId } from "../../shared/api.ts"
import { InstructionService } from "../discovery/instructions.ts"
import { contentHash } from "../lib/files.ts"
import { handleError } from "../lib/errors.ts"
import { mutationGuard } from "../lib/security.ts"
import { instructionRoutes } from "../routes/instructions.ts"
import type { Services } from "../services.ts"

let home: string
let projects: string[]
let app: Hono

const claude = () => join(home, ".claude/CLAUDE.md")
const codex = () => join(home, ".codex/AGENTS.md")
const id = encodeId

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "sm-link-")))
  await mkdir(join(home, ".claude"), { recursive: true })
  await mkdir(join(home, ".codex"), { recursive: true })
  projects = []
  const instructions = new InstructionService(
    { paths: () => projects },
    {
      home,
      claudeHome: join(home, ".claude"),
      codexHome: join(home, ".codex"),
    }
  )
  const svc = {
    instructions,
    skills: { invalidate() {} },
    projects: { has: (p: string) => projects.includes(p), paths: () => projects },
  } as unknown as Services
  app = new Hono()
  app.use("*", mutationGuard)
  app.onError(handleError)
  app.route("/", instructionRoutes(svc))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(`http://localhost${path}`, { headers: { host: "localhost" } })
  return { status: res.status, body: (await res.json()) as T }
}

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "X-Skills-Manager": "1",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as T & { error?: string } }
}

const list = async (scope: string) =>
  (await get<InstructionFile[]>(`/instructions?scope=${encodeURIComponent(scope)}`)).body

const link = (source: string, target: string, baseHash?: string) =>
  post<LinkInstructionResponse>(`/instructions/${id(source)}/link`, {
    targetId: id(target),
    baseHash,
    backup: true,
  })

async function makeProject(name: string): Promise<string> {
  const dir = join(home, name)
  await mkdir(dir, { recursive: true })
  projects.push(dir)
  return dir
}

describe("POST /instructions/:id/link", () => {
  test("links with a backup and a relative link under HOME", async () => {
    await writeFile(claude(), "# shared\n")
    await writeFile(codex(), "# old codex\n")
    const res = await link(codex(), claude(), contentHash("# old codex\n"))
    expect(res.status).toBe(200)
    expect(res.body.backupPath).toBe(`${codex()}.bak`)
    expect(await readFile(`${codex()}.bak`, "utf8")).toBe("# old codex\n")
    expect((await lstat(codex())).isSymbolicLink()).toBe(true)
    expect(await readlink(codex())).toBe("../.claude/CLAUDE.md")
    expect(await readFile(codex(), "utf8")).toBe("# shared\n")
    expect(res.body.file.linkTargetId).toBe(id(claude()))
    // no temp files left behind
    expect((await readdir(join(home, ".codex"))).sort()).toEqual(["AGENTS.md", "AGENTS.md.bak"])
  })

  test("uses an absolute link outside HOME", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "sm-link-out-")))
    try {
      projects.push(outside)
      await writeFile(claude(), "# shared\n")
      const res = await link(join(outside, "AGENTS.md"), claude())
      expect(res.status).toBe(200)
      expect(await readlink(join(outside, "AGENTS.md"))).toBe(claude())
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("409 when the source changed since the preview", async () => {
    await writeFile(claude(), "# shared\n")
    await writeFile(codex(), "# edited meanwhile\n")
    const res = await link(codex(), claude(), contentHash("# what the dialog saw\n"))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("conflict")
    expect((await lstat(codex())).isFile()).toBe(true)
    expect(await lstat(`${codex()}.bak`).catch(() => null)).toBeNull()
    // the newer content is back in place, and nothing else is left behind
    expect(await readFile(codex(), "utf8")).toBe("# edited meanwhile\n")
    expect(await readdir(join(home, ".codex"))).toEqual(["AGENTS.md"])
  })

  test("the backup is the live file itself (same inode and mode)", async () => {
    await writeFile(claude(), "# shared\n")
    await writeFile(codex(), "# codex\n", { mode: 0o600 })
    const before = await lstat(codex())
    const res = await link(codex(), claude(), contentHash("# codex\n"))
    expect(res.status).toBe(200)
    const backup = await lstat(res.body.backupPath!)
    expect(backup.ino).toBe(before.ino)
    expect(backup.mode & 0o777).toBe(0o600)
    expect(backup.nlink).toBe(1)
  })

  test("400 without baseHash for an existing file", async () => {
    await writeFile(claude(), "a\n")
    await writeFile(codex(), "b\n")
    expect((await link(codex(), claude())).status).toBe(400)
  })

  test("refuses a self-link", async () => {
    await writeFile(claude(), "a\n")
    const res = await link(claude(), claude(), contentHash("a\n"))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("self_link")
  })

  test("refuses a target that is itself a symlink", async () => {
    const dir = await makeProject("proj")
    await writeFile(join(dir, "AGENTS.md"), "real\n")
    await symlink("AGENTS.md", join(dir, "CLAUDE.md"))
    const res = await link(join(dir, "CLAUDE.local.md"), join(dir, "CLAUDE.md"))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("target_is_link")
    expect(await lstat(join(dir, "CLAUDE.local.md")).catch(() => null)).toBeNull()
  })

  test("refuses a cycle: the target resolves to the source", async () => {
    // A project dir that is a symlink to ~/.codex: its AGENTS.md is the user one.
    await writeFile(codex(), "codex\n")
    const alias = join(home, "alias")
    await symlink(join(home, ".codex"), alias)
    projects.push(alias)
    const res = await link(codex(), join(alias, "AGENTS.md"), contentHash("codex\n"))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("cycle")
    expect((await lstat(codex())).isFile()).toBe(true)
  })

  test("refuses a source that is already a link", async () => {
    await writeFile(claude(), "a\n")
    await symlink("../.claude/CLAUDE.md", codex())
    const res = await link(codex(), claude())
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("already_linked")
  })

  test("never overwrites an existing .bak", async () => {
    await writeFile(claude(), "shared\n")
    await writeFile(codex(), "second\n")
    await writeFile(`${codex()}.bak`, "first backup\n")
    const res = await link(codex(), claude(), contentHash("second\n"))
    expect(res.status).toBe(200)
    expect(res.body.backupPath).toMatch(/AGENTS\.md\.bak-\d{8}-\d{6}$/)
    expect(await readFile(`${codex()}.bak`, "utf8")).toBe("first backup\n")
    expect(await readFile(res.body.backupPath!, "utf8")).toBe("second\n")
  })

  test("a missing source becomes a link without a backup", async () => {
    await rm(join(home, ".codex"), { recursive: true })
    await writeFile(claude(), "shared\n")
    const res = await link(codex(), claude())
    expect(res.status).toBe(200)
    expect(res.body.backupPath).toBeNull()
    expect(await readlink(codex())).toBe("../.claude/CLAUDE.md")
  })

  test("needs the mutation header and a same-origin Origin", async () => {
    await writeFile(claude(), "a\n")
    const body = { targetId: id(claude()), backup: true }
    const path = `/instructions/${id(codex())}/link`
    expect((await post(path, body, { "X-Skills-Manager": "0" })).status).toBe(403)
    expect((await post(path, body, { origin: "http://evil.example" })).status).toBe(403)
    expect(await lstat(codex()).catch(() => null)).toBeNull()
  })

  test("404 for paths the server did not discover", async () => {
    await writeFile(claude(), "a\n")
    const res = await link(join(home, "elsewhere/AGENTS.md"), claude())
    expect(res.status).toBe(404)
  })
})

describe("POST /instructions/:id/unlink", () => {
  test("copy keeps the target's content and leaves the target alone", async () => {
    await writeFile(claude(), "shared\n")
    await symlink("../.claude/CLAUDE.md", codex())
    const res = await post<UnlinkInstructionResponse>(`/instructions/${id(codex())}/unlink`, { mode: "copy" })
    expect(res.status).toBe(200)
    expect((await lstat(codex())).isFile()).toBe(true)
    expect(await readFile(codex(), "utf8")).toBe("shared\n")
    expect(await readFile(claude(), "utf8")).toBe("shared\n")
    expect(res.body.file.linkTarget).toBeUndefined()
  })

  test("empty starts a blank file", async () => {
    await writeFile(claude(), "shared\n")
    await symlink("../.claude/CLAUDE.md", codex())
    const res = await post(`/instructions/${id(codex())}/unlink`, { mode: "empty" })
    expect(res.status).toBe(200)
    expect(await readFile(codex(), "utf8")).toBe("")
    expect(await readFile(claude(), "utf8")).toBe("shared\n")
  })

  test("400 for a regular file, 409 copy of a broken link", async () => {
    await writeFile(claude(), "a\n")
    expect((await post(`/instructions/${id(claude())}/unlink`, { mode: "empty" })).status).toBe(400)
    await symlink("../.claude/GONE.md", codex())
    const res = await post(`/instructions/${id(codex())}/unlink`, { mode: "copy" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("link_broken")
    expect((await post(`/instructions/${id(codex())}/unlink`, { mode: "empty" })).status).toBe(200)
  })

  test("400 for a bad mode", async () => {
    await writeFile(claude(), "a\n")
    await symlink("../.claude/CLAUDE.md", codex())
    expect((await post(`/instructions/${id(codex())}/unlink`, { mode: "delete" })).status).toBe(400)
  })
})

describe("link fields on GET /instructions", () => {
  test("linkTargetId and linkedFrom across user and project scopes", async () => {
    await writeFile(claude(), "shared\n")
    await symlink("../.claude/CLAUDE.md", codex())
    const dir = await makeProject("proj")
    await writeFile(join(dir, "AGENTS.md"), "project\n")
    await symlink("AGENTS.md", join(dir, "CLAUDE.md"))
    await symlink(claude(), join(dir, "CLAUDE.local.md"))

    const user = await list("user")
    const userClaude = user.find((f) => f.fileName === "CLAUDE.md")!
    const userCodex = user.find((f) => f.fileName === "AGENTS.md")!
    expect(userCodex.linkTargetId).toBe(userClaude.id)
    expect(userCodex.linkTargetFile).toMatchObject({ scope: "user", agentLabel: "Claude Code" })
    expect(userClaude.linkedFrom?.map((r) => r.path).sort()).toEqual(
      [codex(), join(dir, "CLAUDE.local.md")].sort()
    )

    const project = await list(dir)
    const pAgents = project.find((f) => f.fileName === "AGENTS.md")!
    const pClaude = project.find((f) => f.fileName === "CLAUDE.md")!
    const pLocal = project.find((f) => f.fileName === "CLAUDE.local.md")!
    expect(pClaude.linkTargetId).toBe(pAgents.id)
    expect(pAgents.linkedFrom).toEqual([
      { id: pClaude.id, scope: dir, path: pClaude.path, fileName: "CLAUDE.md", agentLabel: "Claude Code" },
    ])
    expect(pLocal.linkTargetId).toBe(userClaude.id)
    expect(pLocal.linkTargetFile?.scope).toBe("user")
  })

  test("a link to an unknown file has linkTarget but no linkTargetId", async () => {
    await mkdir(join(home, "dotfiles"))
    await writeFile(join(home, "dotfiles/agents.md"), "x\n")
    await symlink("../dotfiles/agents.md", codex())
    const file = (await list("user")).find((f) => f.fileName === "AGENTS.md")!
    expect(file.linkTarget).toBe(join(home, "dotfiles/agents.md"))
    expect(file.linkTargetId).toBeUndefined()
    expect(file.exists).toBe(true)
  })

  test("a broken link is reported", async () => {
    await symlink("../.claude/CLAUDE.md", codex())
    const file = (await list("user")).find((f) => f.fileName === "AGENTS.md")!
    expect(file.linkBroken).toBe(true)
    expect(file.exists).toBe(false)
    expect(file.linkTarget).toBe(claude())
    // the missing target is still a known file: Edit can open it to create it
    expect(file.linkTargetId).toBe(id(claude()))
  })
})

describe("GET /instructions/:id/sync-preview", () => {
  test("lists candidates with diffs, backups and blocks", async () => {
    await writeFile(claude(), "one\ntwo\n")
    await writeFile(codex(), "one\nthree\nfour\n")
    await writeFile(`${codex()}.bak`, "old\n")
    const dir = await makeProject("proj")
    await writeFile(join(dir, "AGENTS.md"), "one\ntwo\n")
    await symlink("AGENTS.md", join(dir, "CLAUDE.md"))

    const user = await get<SyncPreview>(`/instructions/${id(claude())}/sync-preview`)
    expect(user.status).toBe(200)
    expect(user.body.candidates.map((c) => c.file.path)).toEqual([codex()])
    const c = user.body.candidates[0]
    expect(c).toMatchObject({ identical: false, linesAdded: 1, linesRemoved: 2, hash: contentHash("one\nthree\nfour\n") })
    expect(c.backupPath).toMatch(/AGENTS\.md\.bak-/)

    const project = await get<SyncPreview>(`/instructions/${id(join(dir, "AGENTS.md"))}/sync-preview`)
    const byName = Object.fromEntries(project.body.candidates.map((x) => [x.file.path, x]))
    expect(Object.keys(byName).sort()).toEqual(
      [claude(), codex(), join(dir, "CLAUDE.local.md"), join(dir, "CLAUDE.md")].sort()
    )
    expect(byName[join(dir, "CLAUDE.md")].blocked).toBe("Already synced to this file")
    expect(byName[join(dir, "CLAUDE.local.md")]).toMatchObject({ backupPath: null, linesAdded: 2 })
    expect(byName[claude()]).toMatchObject({ identical: true, linesAdded: 0, linesRemoved: 0 })
  })

  test("400 when the target is a symlink", async () => {
    await writeFile(claude(), "a\n")
    await symlink("../.claude/CLAUDE.md", codex())
    const res = await get<{ error: string }>(`/instructions/${id(codex())}/sync-preview`)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("target_is_link")
  })
})

async function put<T>(fileId: string, body: unknown) {
  const res = await app.request(`http://localhost/instructions/${fileId}`, {
    method: "PUT",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "X-Skills-Manager": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as T & { error?: string; linkTargetId?: string } }
}

describe("concurrency", () => {
  test("reciprocal syncs started together never make a cycle", async () => {
    const dir = await makeProject("proj")
    const a = join(dir, "AGENTS.md")
    const b = join(dir, "CLAUDE.md")
    await writeFile(a, "same\n")
    await writeFile(b, "same\n")
    const hash = contentHash("same\n")
    const results = await Promise.all([link(a, b, hash), link(b, a, hash)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 400])
    expect(results.find((r) => r.status === 400)!.body.error).toBe("target_is_link")
    // exactly one link, and both names resolve (no ELOOP)
    const kinds = await Promise.all([a, b].map(async (p) => (await lstat(p)).isSymbolicLink()))
    expect(kinds.filter(Boolean)).toHaveLength(1)
    expect(await readFile(a, "utf8")).toBe("same\n")
    expect(await readFile(b, "utf8")).toBe("same\n")
  })

  test("a save racing a sync never lands in the target", async () => {
    await writeFile(claude(), "same\n")
    await writeFile(codex(), "same\n")
    const hash = contentHash("same\n")
    const [saved, linked] = await Promise.all([
      put<SaveResponse>(id(codex()), { content: "codex edit\n", baseHash: hash }),
      link(codex(), claude(), hash),
    ])
    expect(await readFile(claude(), "utf8")).toBe("same\n")
    if (saved.status === 200) {
      // the save went first: the sync saw a changed file and kept it
      expect(linked.status).toBe(409)
      expect(await readFile(codex(), "utf8")).toBe("codex edit\n")
    } else {
      expect(saved.body.error).toBe("now_linked")
      expect(linked.status).toBe(200)
    }
  })
})

describe("saves after a sync (stale editor)", () => {
  test("409 now_linked for a save addressed to a file that became a link", async () => {
    await writeFile(claude(), "same\n")
    await writeFile(codex(), "same\n")
    const hash = contentHash("same\n")
    expect((await link(codex(), claude(), hash)).status).toBe(200)
    // tab 1 still edits ~/.codex/AGENTS.md with the hash it loaded
    const res = await put(id(codex()), { content: "from a stale tab\n", baseHash: hash })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("now_linked")
    expect(res.body.linkTargetId).toBe(id(claude()))
    expect(await readFile(claude(), "utf8")).toBe("same\n")
    // force does not get around it either
    expect((await put(id(codex()), { content: "x\n", force: true })).status).toBe(409)
  })

  test("expectTarget names the link target: then the save writes through", async () => {
    await writeFile(claude(), "same\n")
    await symlink("../.claude/CLAUDE.md", codex())
    const ok = await put(id(codex()), { content: "new\n", baseHash: contentHash("same\n"), expectTarget: claude() })
    expect(ok.status).toBe(200)
    expect(await readFile(claude(), "utf8")).toBe("new\n")
    const wrong = await put(id(codex()), { content: "x\n", baseHash: contentHash("new\n"), expectTarget: join(home, "other.md") })
    expect(wrong.status).toBe(409)
    expect(wrong.body.error).toBe("now_linked")
  })

  test("saving the real file is unaffected", async () => {
    await writeFile(claude(), "same\n")
    await symlink("../.claude/CLAUDE.md", codex())
    const res = await put(id(claude()), { content: "v2\n", baseHash: contentHash("same\n") })
    expect(res.status).toBe(200)
    expect(await readFile(codex(), "utf8")).toBe("v2\n")
  })
})

describe("file types", () => {
  test("a directory is never a target, in preview or link", async () => {
    const dir = await makeProject("proj")
    await mkdir(join(dir, "CLAUDE.md"))
    await writeFile(join(dir, "AGENTS.md"), "a\n")
    const res = await link(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"), contentHash("a\n"))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("target_not_file")
    const preview = await get<{ error: string }>(`/instructions/${id(join(dir, "CLAUDE.md"))}/sync-preview`)
    expect(preview.status).toBe(400)
    expect(preview.body.error).toBe("target_not_file")
    expect((await lstat(join(dir, "AGENTS.md"))).isFile()).toBe(true)
  })

  test("a directory is never a source", async () => {
    const dir = await makeProject("proj")
    await mkdir(join(dir, "CLAUDE.md"))
    await writeFile(join(dir, "AGENTS.md"), "a\n")
    const res = await link(join(dir, "CLAUDE.md"), join(dir, "AGENTS.md"))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("source_not_file")
    expect((await lstat(join(dir, "CLAUDE.md"))).isDirectory()).toBe(true)
  })

  test("a hard-linked source is refused with the reason, also in the preview", async () => {
    await writeFile(claude(), "a\n")
    await writeFile(codex(), "b\n")
    await hardLink(codex(), join(home, "elsewhere-copy.md"))
    const res = await link(codex(), claude(), contentHash("b\n"))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("hard_linked")
    const preview = await get<SyncPreview>(`/instructions/${id(claude())}/sync-preview`)
    expect(preview.body.candidates[0].blocked).toMatch(/2 hard links/)
    expect((await lstat(codex())).isFile()).toBe(true)
  })

  test("unlink copy refuses a link to a directory; empty still works", async () => {
    await mkdir(join(home, "somedir"))
    await symlink("../somedir", codex())
    const copy = await post(`/instructions/${id(codex())}/unlink`, { mode: "copy" })
    expect(copy.status).toBe(400)
    expect(copy.body.error).toBe("target_not_file")
    expect((await post(`/instructions/${id(codex())}/unlink`, { mode: "empty" })).status).toBe(200)
    expect((await lstat(codex())).isFile()).toBe(true)
    expect((await lstat(join(home, "somedir"))).isDirectory()).toBe(true)
  })
})

describe("link failures after the file is moved (review: recovery)", () => {
  test("an unreadable source is put back under its name, with no backup or scratch left", async () => {
    await writeFile(claude(), "# shared\n")
    await writeFile(codex(), "# codex\n")
    const before = await lstat(codex())
    const { chmod } = await import("node:fs/promises")
    await chmod(codex(), 0o000)
    try {
      const res = await link(codex(), claude(), contentHash("# codex\n"))
      expect(res.status).toBe(500)
      expect(res.body.error).toBe("unreadable")
      const after = await lstat(codex())
      expect(after.isFile()).toBe(true)
      expect(after.ino).toBe(before.ino)
      expect((await readdir(join(home, ".codex"))).sort()).toEqual(["AGENTS.md"])
    } finally {
      await chmod(codex(), 0o644).catch(() => {})
    }
    expect(await readFile(codex(), "utf8")).toBe("# codex\n")
  })

  test("putBack never replaces a file that appeared, and reports where the original is", async () => {
    const { putBack } = await import("../discovery/instruction-links.ts")
    const from = join(home, ".codex/.AGENTS.md.x.moving")
    await writeFile(from, "mine\n")
    await writeFile(codex(), "appeared\n")
    const res = await putBack(from, codex())
    expect(res.restored).toBe(false)
    if (!res.restored) expect(res.keptAt).toBe(from)
    expect(await readFile(codex(), "utf8")).toBe("appeared\n")
    expect(await readFile(from, "utf8")).toBe("mine\n")
  })

  test("putBack restores a file when the name is free", async () => {
    const { putBack } = await import("../discovery/instruction-links.ts")
    const file = join(home, ".codex/.f.moving")
    await writeFile(file, "f\n")
    expect((await putBack(file, codex())).restored).toBe(true)
    expect(await readFile(codex(), "utf8")).toBe("f\n")
    expect(await lstat(file).catch(() => null)).toBeNull()
  })

  test("putBack never moves a directory back: it is kept where it is and reported", async () => {
    const { putBack } = await import("../discovery/instruction-links.ts")
    const dir = join(home, ".codex/.d.moving")
    await mkdir(dir)
    await writeFile(join(dir, "x"), "x")
    const dest = join(home, ".codex/restored-dir")
    const res = await putBack(dir, dest)
    expect(res.restored).toBe(false)
    if (!res.restored) expect(res.keptAt).toBe(dir)
    expect(await lstat(dest).catch(() => null)).toBeNull()
    expect(await readFile(join(dir, "x"), "utf8")).toBe("x")
  })
})
