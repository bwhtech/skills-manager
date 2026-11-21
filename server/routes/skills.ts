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
import { forbidden, HttpError, notFound, readJson } from "../lib/errors.ts"
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
    try {
      const body: UpdatePreview = await svc.previews.preview(skill)
      return c.json(body)
    } catch (err) {
      // The preview mirrors how `skills update` finds the skill: gone means deleted upstream.
      if (err instanceof HttpError && err.message === "not_upstream")
        svc.updates.noteUpstream(skill.scope, {
          deleted: [{ name: skill.cliName, source: cliSourceName(skill) }],
        })
      throw err
    }
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

export function toSummary(skill: IndexedSkill, svc: Pick<Services, "updates">): SkillSummary {
  const { cliName, folderName, placements, ...rest } = skill
  void placements // internal: where to remove from
  const npx = skill.origin === "npx"
  const deletedUpstream = npx && svc.updates.isDeleted(skill.scope, cliName)
  const updateAvailable =
    npx &&
    !deletedUpstream &&
    svc.updates.has(skill.scope, [cliName, folderName, skill.name])
  return {
    ...rest,
    ...(npx ? { cliName } : {}),
    removable: isRemovable(skill),
    updateAvailable,
    ...(deletedUpstream ? { deletedUpstream } : {}),
  }
}

/** The source as `skills update` prints it: owner/repo for user scope, else the sourceUrl. */
function cliSourceName(skill: IndexedSkill): string {
  const source = skill.source
  if (!source) return ""
  return skill.scope === "user"
    ? source.source
    : (source.sourceUrl ?? source.source)
}
