import { Hono } from "hono"
import type {
  InstallRequest,
  JobRef,
  RepoSkillsRequest,
} from "../../shared/api.ts"
import { readJson } from "../lib/errors.ts"
import {
  requireAgents,
  requireScope,
  requireSkillNames,
  requireSource,
} from "../lib/validate.ts"
import type { Services } from "../services.ts"

export function installRoutes(svc: Services): Hono {
  const app = new Hono()

  app.get("/search", async (c) =>
    c.json(await svc.catalog.search(c.req.query("q") ?? ""))
  )

  app.post("/repo/skills", async (c) => {
    const source = requireSource((await readJson<RepoSkillsRequest>(c)).source)
    return c.json(await svc.catalog.repoSkills(source))
  })

  app.post("/install", async (c) => {
    const req = await readJson<InstallRequest>(c)
    const job = svc.actions.install({
      source: requireSource(req.source),
      skills: requireSkillNames(req.skills),
      agents: requireAgents(req.agents, (id) => svc.agents.has(id)),
      scope: requireScope(req.scope, (p) => svc.projects.has(p)),
    })
    const body: JobRef = { jobId: job.id }
    return c.json(body, 202)
  })

  return app
}
