import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeId, MUTATION_HEADER } from "../../shared/api.ts"
import { createApi } from "../app.ts"
import { containedSkillMd } from "../discovery/skill-files.ts"
import type { IndexedSkill } from "../discovery/skill-index.ts"
import { listSkillFolders } from "../discovery/skill-locations.ts"
import type { Services } from "../services.ts"

const base = await realpath(await mkdtemp(join(tmpdir(), "skills-md-")))
afterAll(() => rm(base, { recursive: true, force: true }))

const skillsDir = join(base, "skills")
const secret = join(base, "secret.txt")
const leaky = join(skillsDir, "leaky")
const good = join(skillsDir, "good")
await mkdir(leaky, { recursive: true })
await mkdir(good, { recursive: true })
await writeFile(secret, "TOKEN=hunter2\n")
await symlink(secret, join(leaky, "SKILL.md"))
await writeFile(join(good, "SKILL.md"), "---\nname: good\n---\n")

function indexed(realPath: string): IndexedSkill {
  return {
    id: encodeId(realPath),
    name: "x",
    description: "",
    realPath,
    locations: [realPath],
    agents: [],
    scope: "user",
    scopes: ["user"],
    origin: "manual",
    editable: true,
    cliName: "x",
    folderName: "x",
    placements: [],
  }
}

// The index may still hold a skill whose SKILL.md was swapped for a link.
const fakeServices = {
  skills: { all: async () => [indexed(leaky), indexed(good)], invalidate() {} },
  updates: { has: () => false },
  projects: { has: () => false },
} as unknown as Services
const api = createApi(fakeServices)

describe("SKILL.md containment", () => {
  test("discovery skips a folder whose SKILL.md links outside", async () => {
    const found = await listSkillFolders(skillsDir)
    expect(found.map((f) => f.path)).toEqual([good])
    expect(await containedSkillMd(leaky)).toBeNull()
    expect(await containedSkillMd(good)).toBe(join(good, "SKILL.md"))
  })

  test("GET /skills/:id does not read a SKILL.md outside the folder", async () => {
    const res = await api.request(`/skills/${encodeId(leaky)}`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain("hunter2")
    const ok = await api.request(`/skills/${encodeId(good)}`)
    expect(ok.status).toBe(200)
    expect((await ok.json()).skillMd.content).toContain("name: good")
  })

  test("PUT /skills/:id/skill-md refuses to write through the link", async () => {
    const res = await api.request(`/skills/${encodeId(leaky)}/skill-md`, {
      method: "PUT",
      headers: {
        [MUTATION_HEADER]: "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: "pwned",
        baseMtimeMs: (await stat(secret)).mtimeMs,
      }),
    })
    expect(res.status).toBe(403)
    expect(await readFile(secret, "utf8")).toBe("TOKEN=hunter2\n")
  })
})
