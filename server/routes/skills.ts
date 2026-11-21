import { Hono } from "hono"
import type {
  JobRef,
  RemovalPlan,
  SaveRequest,
  SaveResponse,
  SkillDetail,
  SkillFileContent,
  SkillSummary,
  UpdatePreview,
} from "../../shared/api.ts"
import { isRemovable, type IndexedSkill } from "../discovery/skill-index.ts"
import {
  containedSkillMd,
  editableSkillFile,
  isEditableSkillFile,
  listSkillFiles,
  readOnly,
  readSkillFile,
  readSkillMd,
} from "../discovery/skill-files.ts"
import { badRequest, forbidden, HttpError, notFound, readJson } from "../lib/errors.ts"
import { isInside, realpathOrNull, saveTextFile } from "../lib/files.ts"
import { decodePathId, requireRelativePath, requireScope } from "../lib/validate.ts"
import { requireShownPlan, toPublic } from "../removal/guard.ts"
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
    const raw = c.req.query("path")
    const file = await readSkillFile(skill.realPath, raw)
    const editable = skill.editable && (await isEditableSkillFile(skill.realPath, requireRelativePath(raw)))
    const body: SkillFileContent = { ...file, editable }
    return c.json(body)
  })

  // Any Markdown file of an editable skill. Writes the validated real path as is, after the
  // same checks run again under the save lock (see saveTextFile `resolved`).
  app.put("/skills/:id/file", async (c) => {
    const skill = await lookup(c.req.param("id"))
    if (!skill.editable) throw readOnly(`This skill is read-only: ${readOnlyReason(skill)}`)
    const rel = requireRelativePath(c.req.query("path"))
    const root = skill.realPath
    const real = await editableSkillFile(root, rel)
    const guard = async () => {
      const now = await editableSkillFile(root, rel)
      if (now !== real || (await realpathOrNull(real)) !== real || !isInside(root, real))
        throw new HttpError(409, "moved", "The file was moved or replaced; reload it", { currentPath: now })
    }
    const body: SaveResponse = await saveTextFile(real, await readJson<SaveRequest>(c), { resolved: true, guard })
    // The frontmatter feeds the skill index.
    if (real === (await containedSkillMd(root))) svc.skills.invalidate()
    return c.json(body)
  })

  app.get("/skills/:id/update-preview", async (c) => {
    const skill = await lookup(c.req.param("id"))
    try {
      const body: UpdatePreview = await svc.previews.preview(skill)
      // Found upstream: an earlier "deleted" finding for it is stale.
      svc.updates.notePresent(skill.scope, skill.cliName)
      return c.json(body)
    } catch (err) {
      // The preview mirrors how `skills update` finds the skill: gone means deleted upstream.
      const found = { name: skill.cliName, source: cliSourceName(skill) }
      if (err instanceof HttpError && err.message === "not_upstream")
        await svc.updates.noteUpstream(skill.scope, { deleted: [found] })
      if (err instanceof HttpError && err.message === "ambiguous_upstream")
        await svc.updates.noteUpstream(skill.scope, { ambiguous: [found] })
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
    const guard = async () => {
      if ((await containedSkillMd(skill.realPath)) !== target)
        throw new HttpError(409, "moved", "SKILL.md was moved or replaced; reload it")
    }
    const body: SaveResponse = await saveTextFile(target, await readJson<SaveRequest>(c), {
      resolved: true,
      guard,
    })
    svc.skills.invalidate()
    return c.json(body)
  })

  app.get("/skills/:id/removal-plan", async (c) => {
    const skill = await lookup(c.req.param("id"))
    if (skill.origin !== "npx")
      throw badRequest("Removal plans are only for skills installed with the skills CLI")
    const [plan] = await svc.removals.plans(skill.scope, [skill.cliName], { intent: "remove" })
    const body: RemovalPlan = toPublic(plan)
    return c.json(body)
  })

  app.delete("/skills/:id", async (c) => {
    const skill = await lookup(c.req.param("id"))
    // Optional body (RemoveSkillRequest): what the Remove dialog showed and ticked.
    const raw = await c.req.text()
    const shown = raw.trim() ? requireShownPlan(parseBody(raw)) : undefined
    const plan =
      skill.origin === "npx"
        ? (
            await svc.removals.plans(skill.scope, [skill.cliName], {
              intent: "remove",
              gone: new Map([[skill.cliName, shown?.copies ?? []]]),
            })
          )[0]
        : undefined
    if (skill.origin !== "npx" && shown?.copies?.length)
      throw badRequest("Separate copies can be ticked only for skills installed with the skills CLI")
    const job = svc.actions.remove(skill, plan, shown)
    const body: JobRef = { jobId: job.id }
    return c.json(body, 202)
  })

  return app
}

function parseBody(raw: string): unknown {
  try {
    const body = JSON.parse(raw)
    if (body && typeof body === "object") return body
  } catch {
    // fall through
  }
  throw badRequest("Body must be a JSON object")
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

/** Why a skill is read-only, as the save refusal says it. */
function readOnlyReason(skill: IndexedSkill): string {
  switch (skill.origin) {
    case "plugin":
      return `provided by the ${skill.pluginName ?? "Claude Code"} plugin; plugin updates replace it`
    case "synced":
      return "synced from claude.ai; edit it on claude.ai"
    case "system":
      return "a built-in skill of an agent; the agent manages it"
    default:
      return `${skill.origin} skills cannot be edited`
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
