import { afterAll, describe, expect, test } from "bun:test"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SkillActions,
  removeManualSkill,
  type RemoveHooks,
} from "../actions.ts"
import type { SkillsCli } from "../cli/skills-cli.ts"
import type { IndexedSkill } from "../discovery/skill-index.ts"
import type { JobManager } from "../jobs.ts"
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

type Place = Omit<SkillPlacement, "deletable"> & { deletable?: boolean }

async function remove(
  realPath: string,
  placements: Place[],
  hooks: RemoveHooks = {}
) {
  const log: string[] = []
  const code = await removeManualSkill(
    {
      realPath,
      placements: placements.map((p) => ({ deletable: true, ...p })),
    },
    (line) => log.push(line),
    home,
    hooks
  )
  return { code, log }
}

async function trashDirs(dir: string) {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((n) => n.startsWith(".skills-manager-trash-"))
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

  test("leaves no trash dir behind after a delete", async () => {
    const path = join(userRoot, "tidy")
    await skillDir(path)
    const { code } = await remove(path, [
      { path, root: userRoot, scope: "user" },
    ])
    expect(code).toBe(0)
    expect(await trashDirs(userRoot)).toEqual([])
  })

  test("a placement in a dir that is not deletable is kept", async () => {
    const project = join(base, "src-proj")
    const root = join(project, "skills")
    const path = join(root, "frappe-builder")
    await skillDir(path)
    const { code, log } = await remove(path, [
      { path, root, scope: project, deletable: false },
    ])
    expect(code).toBe(1)
    expect(await pathExists(join(path, "SKILL.md"))).toBe(true)
    expect(log.join("\n")).toContain("does not delete from")
  })

  test("symlinks inside the folder are unlinked, never followed", async () => {
    const outside = join(ext, "precious")
    await mkdir(join(outside, "sub"), { recursive: true })
    await writeFile(join(outside, "sub/data.txt"), "keep")
    const path = join(userRoot, "with-links")
    await skillDir(join(path, "nested"))
    await symlink(outside, join(path, "dir-link"))
    await symlink(join(outside, "sub"), join(path, "nested/sub-link"))
    await symlink(join(outside, "sub/data.txt"), join(path, "file-link"))
    const { code } = await remove(path, [
      { path, root: userRoot, scope: "user" },
    ])
    expect(code).toBe(0)
    expect(await pathExists(path)).toBe(false)
    expect(await readFile(join(outside, "sub/data.txt"), "utf8")).toBe("keep")
  })

  // The skills dir is swapped for a symlink to a dir that holds a folder of
  // the same name (an external checkout) after the checks pass.
  async function swapSetup(tag: string) {
    const project = join(base, `swap-${tag}`)
    const root = join(project, ".claude/skills")
    const path = join(root, "foo")
    await skillDir(path)
    const checkout = join(ext, `checkout-${tag}`)
    await skillDir(join(checkout, "foo"))
    await mkdir(join(checkout, "foo/.git"), { recursive: true })
    await writeFile(join(checkout, "foo/.git/HEAD"), "ref: main\n")
    const swap = async () => {
      await rename(root, join(project, ".claude/skills-real"))
      await symlink(checkout, root)
    }
    return { project, root, path, checkout, swap }
  }

  test("parent swapped between check and move: nothing outside is touched", async () => {
    const { project, root, path, checkout, swap } = await swapSetup("a")
    const { code, log } = await remove(path, [{ path, root, scope: project }], {
      afterVerify: swap,
    })
    expect(code).toBe(1)
    expect(log.join("\n")).toContain("Refused to delete")
    expect(await readFile(join(checkout, "foo/.git/HEAD"), "utf8")).toBe(
      "ref: main\n"
    )
    expect(await trashDirs(checkout)).toEqual([])
    // The real skill was not deleted either; it now sits in the moved dir.
    expect(
      await pathExists(join(project, ".claude/skills-real/foo/SKILL.md"))
    ).toBe(true)
  })

  test("parent swapped between move and delete: nothing is deleted", async () => {
    const { project, root, path, checkout, swap } = await swapSetup("b")
    const { code } = await remove(path, [{ path, root, scope: project }], {
      afterTrash: swap,
    })
    expect(code).toBe(1)
    expect(await readFile(join(checkout, "foo/.git/HEAD"), "utf8")).toBe(
      "ref: main\n"
    )
    // The real folder was moved to the trash dir before the swap. It cannot
    // be moved back through the swapped path, so it is left there, intact.
    const realDir = join(project, ".claude/skills-real")
    const [trash] = await trashDirs(realDir)
    expect(await pathExists(join(realDir, trash, "foo/SKILL.md"))).toBe(true)
  })

  test("folder replaced after the check: moved back, not deleted", async () => {
    const root = join(home, ".agents/skills")
    const path = join(root, "replaced")
    await skillDir(path)
    const { code } = await remove(path, [{ path, root, scope: "user" }], {
      afterVerify: async () => {
        await rename(path, join(root, "replaced-original"))
        await skillDir(path)
        await writeFile(join(path, "marker"), "new")
      },
    })
    expect(code).toBe(1)
    expect(await readFile(join(path, "marker"), "utf8")).toBe("new")
    expect(await pathExists(join(root, "replaced-original/SKILL.md"))).toBe(true)
    expect(await trashDirs(root)).toEqual([])
  })

  test("SkillActions refuses a manual skill with no deletable placement", () => {
    let queued = 0
    const jobs = { enqueue: () => (queued++, {}) } as unknown as JobManager
    const actions = new SkillActions({} as SkillsCli, jobs)
    const skill = {
      name: "frappe-crm",
      origin: "manual",
      scope: "/p",
      realPath: "/p/skills/frappe-crm",
      placements: [
        { path: "/p/skills/frappe-crm", root: "/p/skills", scope: "/p", deletable: false },
      ],
    } as unknown as IndexedSkill
    expect(() => actions.remove(skill)).toThrow()
    expect(queued).toBe(0)
  })
})
