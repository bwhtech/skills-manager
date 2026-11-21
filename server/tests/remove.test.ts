import { afterAll, describe, expect, test } from "bun:test"
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeManualSkill } from "../actions.ts"
import type { SkillPlacement } from "../discovery/skill-index.ts"
import { pathExists } from "../lib/files.ts"

const base = await realpath(await mkdtemp(join(tmpdir(), "skills-remove-")))
const home = join(base, "home")
const ext = join(base, "ext")
afterAll(() => rm(base, { recursive: true, force: true }))

async function skillDir(path: string) {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, "SKILL.md"), "---\nname: x\n---\n")
}

async function remove(realPath: string, placements: SkillPlacement[]) {
  const log: string[] = []
  const code = await removeManualSkill(
    { realPath, placements },
    (line) => log.push(line),
    home
  )
  return { code, log }
}

const userRoot = join(home, ".claude/skills")

describe("removeManualSkill", () => {
  test("deletes a plain folder in an approved skills dir", async () => {
    const path = join(userRoot, "plain")
    await skillDir(path)
    const { code } = await remove(path, [
      { path, root: userRoot, scope: "user" },
    ])
    expect(code).toBe(0)
    expect(await pathExists(path)).toBe(false)
  })

  test("a symlinked skill folder: only the link goes, the target stays", async () => {
    const target = join(ext, "linked")
    await skillDir(target)
    const link = join(userRoot, "linked")
    await mkdir(userRoot, { recursive: true })
    await symlink(target, link)
    const { code } = await remove(target, [
      { path: link, root: userRoot, scope: "user" },
    ])
    expect(code).toBe(0)
    expect(await pathExists(link)).toBe(false)
    expect(await pathExists(join(target, "SKILL.md"))).toBe(true)
  })

  test("canonical folder plus agent link: both go", async () => {
    const canonical = join(home, ".agents/skills/both")
    await skillDir(canonical)
    const link = join(userRoot, "both")
    await symlink(canonical, link)
    const { code } = await remove(canonical, [
      { path: canonical, root: join(home, ".agents/skills"), scope: "user" },
      { path: link, root: userRoot, scope: "user" },
    ])
    expect(code).toBe(0)
    expect(await pathExists(canonical)).toBe(false)
    expect(await pathExists(link)).toBe(false)
  })

  test("a skills dir that is a symlink to elsewhere: the target is kept", async () => {
    const project = join(base, "proj")
    const repos = join(ext, "repos")
    await skillDir(join(repos, "repo"))
    await mkdir(join(repos, "repo/.git"), { recursive: true })
    await mkdir(join(project, ".claude"), { recursive: true })
    const root = join(project, ".claude/skills")
    await symlink(repos, root)
    // A link inside the aliased dir is not ours to remove either.
    await skillDir(join(ext, "target"))
    await symlink(join(ext, "target"), join(repos, "alias"))

    const repo = await remove(join(repos, "repo"), [
      { path: join(root, "repo"), root, scope: project },
    ])
    expect(repo.code).toBe(1)
    expect(await pathExists(join(repos, "repo/.git"))).toBe(true)
    expect((await lstat(root)).isSymbolicLink()).toBe(true)

    const alias = await remove(join(ext, "target"), [
      { path: join(root, "alias"), root, scope: project },
    ])
    expect(alias.code).toBe(1)
    expect((await lstat(join(repos, "alias"))).isSymbolicLink()).toBe(true)
  })

  test("a symlinked parent of the skills dir: the target is kept", async () => {
    const project = join(base, "proj2")
    const dotClaude = join(ext, "dotclaude")
    await skillDir(join(dotClaude, "skills/foo"))
    await mkdir(project, { recursive: true })
    await symlink(dotClaude, join(project, ".claude"))
    const root = join(project, ".claude/skills")
    const { code } = await remove(join(dotClaude, "skills/foo"), [
      { path: join(root, "foo"), root, scope: project },
    ])
    expect(code).toBe(1)
    expect(await pathExists(join(dotClaude, "skills/foo/SKILL.md"))).toBe(true)
  })

  test("a project that sits behind a symlink still works", async () => {
    const realProject = join(ext, "real-proj")
    const root = join(realProject, ".claude/skills")
    await skillDir(join(root, "mine"))
    const project = join(base, "proj-link")
    await symlink(realProject, project)
    const { code } = await remove(join(root, "mine"), [
      {
        path: join(project, ".claude/skills/mine"),
        root: join(project, ".claude/skills"),
        scope: project,
      },
    ])
    expect(code).toBe(0)
    expect(await pathExists(join(root, "mine"))).toBe(false)
  })
})
