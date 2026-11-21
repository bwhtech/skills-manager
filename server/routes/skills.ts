import { Hono } from "hono"
import type {
  JobRef,
  SaveRequest,
  SaveResponse,
  SkillDetail,
  SkillSummary,
  UpdatePreview,
} from "../../shared/api.ts"
import { isRemovable, type IndexedSkill } from "../discovery/skill-index.ts"
import {
  containedSkillMd,
  listSkillFiles,
  readSkillFile,
  readSkillMd,
} from "../discovery/skill-files.ts"
import { forbidden, notFound, readJson } from "../lib/errors.ts"
import { saveTextFile } from "../lib/files.ts"
import { decodePathId, requireScope } from "../lib/validate.ts"
import type { Services } from "../services.ts"

export function skillRoutes(svc: Services): Hono {
  const app = new Hono()
  const summary = (s: IndexedSkill) => toSummary(s, svc)

  /** Find a skill by ID. The decoded path must be a skill the index found. */
  async function lookup(id: string): Promise<IndexedSkill> {
    const path = decodePathId(id)
    const skill = (await svc.skills.all()).find((s) => s.realPath === path)
    if (!skill) throw notFound("Unknown skill")
    return skill
  }

  app.get("/skills", async (c) => {
    const raw = c.req.query("scope")
    const scope =
      raw === undefined || raw === ""
        ? null
        : requireScope(raw, (p) => svc.projects.has(p))
    const skills = await svc.skills.all()
    return c.json(
      skills
        .filter((s) => scope === null || s.scopes.includes(scope))
        .map(summary)
    )
  })

  app.get("/skills/:id", async (c) => {
    const skill = await lookup(c.req.param("id"))
    const [files, skillMd] = await Promise.all([
      listSkillFiles(skill.realPath),
      readSkillMd(skill.realPath),
    ])
    const body: SkillDetail = { ...summary(skill), files, skillMd }
    return c.json(body)
  })

  app.get("/skills/:id/file", async (c) => {
    const skill = await lookup(c.req.param("id"))
    return c.json(await readSkillFile(skill.realPath, c.req.query("path")))
  })

  app.get("/skills/:id/update-preview", async (c) => {
    const skill = await lookup(c.req.param("id"))
    const body: UpdatePreview = await svc.previews.preview(skill)
    return c.json(body)
  })

  app.put("/skills/:id/skill-md", async (c) => {
    const skill = await lookup(c.req.param("id"))
    if (!skill.editable) throw forbidden(`${skill.origin} skills are read-only`)
    // A SKILL.md that links out of the folder is not ours to write.
    const target = await containedSkillMd(skill.realPath)
    if (!target)
      throw forbidden("SKILL.md is missing or links outside the skill folder")
    const body: SaveResponse = await saveTextFile(
      target,
      await readJson<SaveRequest>(c)
    )
    svc.skills.invalidate()
    return c.json(body)
  })

  app.delete("/skills/:id", async (c) => {
    const skill = await lookup(c.req.param("id"))
    const job = svc.actions.remove(skill)
    const body: JobRef = { jobId: job.id }
    return c.json(body, 202)
  })

  return app
}

function toSummary(skill: IndexedSkill, svc: Services): SkillSummary {
  const { cliName, folderName, placements, ...rest } = skill
  void placements // internal: where to remove from
  const updateAvailable =
    skill.origin === "npx" &&
    svc.updates.has(skill.scope, [cliName, folderName, skill.name])
  return { ...rest, removable: isRemovable(skill), updateAvailable }
}
