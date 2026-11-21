import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { encodeId, type OpenResult } from "../../shared/api.ts"
import { InstructionService } from "../discovery/instructions.ts"
import { PathOpener, parseRawPath } from "../discovery/open-path.ts"
import { HttpError } from "../lib/errors.ts"
import { SECRET_REFUSAL, looksSecret } from "../lib/secret-paths.ts"

let home: string
let skillDir: string
let skillId: string
let opener: PathOpener

async function put(rel: string, content: string | Uint8Array = "text\n") {
  const path = join(home, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

async function status(promise: Promise<unknown>): Promise<number | string> {
  return promise.then(
    () => "ok",
    (err) => (err instanceof HttpError ? err.status : String(err))
  )
}

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "sm-open-")))
  await put("setup.md")
  await put(".agents/skills/demo/SKILL.md")
  await put(".agents/skills/demo/references/api.md")
  await put(".agents/skills/demo/node_modules/x/index.js")
  skillDir = join(home, ".agents/skills/demo")
  skillId = encodeId(skillDir)
  await mkdir(join(home, ".claude/skills"), { recursive: true })
  await symlink(skillDir, join(home, ".claude/skills/demo"))
  await put(".claude/CLAUDE.md")
  await mkdir(join(home, ".codex"), { recursive: true })
  await symlink(join(home, ".claude/CLAUDE.md"), join(home, ".codex/AGENTS.md"))
  await symlink(join(home, ".claude"), join(home, "claude-link"))
  await put("proj/notes/todo.md")
  await put(".ssh/config")
  await put(".env.local")
  await put(".config/wiki/admin-password")
  await put(".aws/credentials")
  await put("certs/server.pem")
  await symlink(join(home, ".ssh/config"), join(home, "innocent.md"))
  await put("blob.dat", new Uint8Array([104, 105, 0, 1]))
  await mkdir(join(home, "a-dir.md"))

  opener = new PathOpener({
    home,
    roots: [home],
    skills: async () => [{ id: skillId, realPath: skillDir, scope: "user", scopes: ["user"] }],
    instructions: new InstructionService(
      { paths: () => [] },
      { home, claudeHome: join(home, ".claude"), codexHome: join(home, ".codex") }
    ),
  })
})

afterAll(() => rm(home, { recursive: true, force: true }))

describe("parseRawPath", () => {
  test("strips :line, :line:col and #anchors", () => {
    expect(parseRawPath("src/app.ts:42")).toEqual({ path: "src/app.ts", line: 42 })
    expect(parseRawPath("src/app.ts:42:7")).toEqual({ path: "src/app.ts", line: 42 })
    expect(parseRawPath(" docs/a.md#setup ")).toEqual({ path: "docs/a.md" })
    expect(parseRawPath("~/setup.md")).toEqual({ path: "~/setup.md" })
  })
})

describe("PathOpener.open", () => {
  test("~ is HOME", async () => {
    expect(await opener.open("~/setup.md", undefined)).toEqual({ kind: "file", path: join(home, "setup.md") })
  })

  test("keeps the line number", async () => {
    expect(await opener.open("~/setup.md:42", undefined)).toEqual({
      kind: "file",
      path: join(home, "setup.md"),
      line: 42,
    })
  })

  test("relative from a skill file: the skill folder plus that file's dir", async () => {
    const want = { kind: "skill-file" as const, skillId, scope: "user", scopes: ["user"] }
    expect(await opener.open("references/api.md", `${skillId}:SKILL.md`)).toEqual({
      ...want,
      file: "references/api.md",
    })
    expect(await opener.open("../SKILL.md:3", `${skillId}:references/api.md`)).toEqual({
      ...want,
      file: "SKILL.md",
      line: 3,
    })
  })

  test("a skill file through a symlinked skill folder", async () => {
    const result = await opener.open("~/.claude/skills/demo/references/api.md", undefined)
    expect(result).toMatchObject({ kind: "skill-file", skillId, file: "references/api.md" })
  })

  test("files in skipped dirs of a skill are plain files", async () => {
    const result = await opener.open("node_modules/x/index.js", `${skillId}:SKILL.md`)
    expect(result).toEqual({ kind: "file", path: join(skillDir, "node_modules/x/index.js") })
  })

  test("relative from an instruction file: its folder", async () => {
    const from = encodeId(join(home, ".claude/CLAUDE.md"))
    expect(await opener.open("../setup.md", from)).toEqual({ kind: "file", path: join(home, "setup.md") })
    const doc: OpenResult = { kind: "instruction", id: from, scope: "user" }
    expect(await opener.open("./CLAUDE.md", from)).toEqual(doc)
  })

  test("relative from a viewed file: its folder", async () => {
    const from = join(home, "proj/notes/readme.md")
    expect(await opener.open("todo.md", from)).toEqual({ kind: "file", path: join(home, "proj/notes/todo.md") })
  })

  test("instruction files, also through a symlinked file or dir", async () => {
    const claude: OpenResult = { kind: "instruction", id: encodeId(join(home, ".claude/CLAUDE.md")), scope: "user" }
    expect(await opener.open("~/.claude/CLAUDE.md", undefined)).toEqual(claude)
    // ~/.codex/AGENTS.md is a link to CLAUDE.md: the regular file wins.
    expect(await opener.open("~/.codex/AGENTS.md", undefined)).toEqual(claude)
    expect(await opener.open(join(home, "claude-link/CLAUDE.md"), undefined)).toEqual(claude)
  })

  test("refuses what it cannot open", async () => {
    expect(await status(opener.open("setup.md", undefined))).toBe(400) // relative, no from
    expect(await status(opener.open("https://example.com/a.md", undefined))).toBe(400)
    expect(await status(opener.open("~/missing.md", undefined))).toBe(404)
    expect(await status(opener.open("~/a-dir.md", undefined))).toBe(404)
    expect(await status(opener.open("/etc/hostname", undefined))).toBe(404) // outside the roots
    expect(await status(opener.open("/proc/self/status", undefined))).toBe(404)
    expect(await status(opener.open("~/blob.dat", undefined))).toBe(415)
  })
})

describe("secret files", () => {
  test("are refused with a clear 403, also behind an innocent link", async () => {
    for (const path of [
      "~/.ssh/config",
      "~/.env.local",
      "~/.config/wiki/admin-password",
      "~/.aws/credentials",
      "~/certs/server.pem",
      "~/innocent.md",
    ]) {
      const err = await opener.open(path, undefined).catch((e) => e)
      expect(err).toBeInstanceOf(HttpError)
      expect([path, err.status, err.detail]).toEqual([path, 403, SECRET_REFUSAL])
    }
    expect(await status(opener.read(join(home, "innocent.md")))).toBe(403)
    // A missing secret file is refused the same way: no hint that it does not exist.
    expect(await status(opener.open("~/.ssh/id_ed25519", undefined))).toBe(403)
  })

  test("the deny list", () => {
    const h = "/home/u"
    const secret = [
      "/home/u/.ssh/id_ed25519",
      "/home/u/.gnupg/pubring.kbx",
      "/home/u/.config/gh/hosts.yml",
      "/home/u/.config/light-demo/admin-password",
      "/home/u/.claude/.credentials.json",
      "/mnt/data/app/.env",
      "/mnt/data/app/.env.production",
      "/mnt/data/certs/tls.key",
      "/home/u/keys/id_rsa.pub",
      "/home/u/.netrc",
    ]
    const shown = [
      "/home/u/setup.md",
      "/home/u/docs/password-reset.md",
      "/home/u/.config/skills-manager/state.json",
      "/mnt/data/app/environment.md",
      "/home/u/src/keyboard.ts",
    ]
    expect(secret.filter((p) => !looksSecret(p, h))).toEqual([])
    expect(shown.filter((p) => looksSecret(p, h))).toEqual([])
  })
})

describe("PathOpener.read", () => {
  test("reads a text file by absolute path", async () => {
    const file = await opener.read(join(home, "setup.md"))
    expect(file.content).toBe("text\n")
  })

  test("needs an absolute path and the same checks as open", async () => {
    expect(await status(opener.read("setup.md"))).toBe(400)
    expect(await status(opener.read(join(home, ".ssh/config")))).toBe(403)
    expect(await status(opener.read(join(home, "blob.dat")))).toBe(415)
    expect(await status(opener.read("/etc/hostname"))).toBe(404)
  })
})
