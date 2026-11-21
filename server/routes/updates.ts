import { Hono } from "hono"
import type { JobRef, UpdateRunRequest } from "../../shared/api.ts"
import { badRequest, readJson } from "../lib/errors.ts"
import { requireScope, requireSkillNames } from "../lib/validate.ts"
import type { Services } from "../services.ts"

export function updateRoutes(svc: Services): Hono {
  const app = new Hono()

  app.get("/updates", (c) => c.json(svc.updates.get()))

  app.post("/updates/check", (c) => c.json(svc.updates.start()))

  app.post("/updates/run", async (c) => {
    const req = await readJson<UpdateRunRequest>(c)
    const scope = requireScope(req.scope, (p) => svc.projects.has(p))
    if (req.names !== undefined && !Array.isArray(req.names))
      throw badRequest("names must be an array")
    const names = req.names?.length ? requireSkillNames(req.names, "names") : []
    const job = svc.actions.update({ scope, names })
    const body: JobRef = { jobId: job.id }
    return c.json(body, 202)
  })

  return app
}
