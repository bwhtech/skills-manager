import { Hono } from "hono"
import type { SaveInstructionRequest, SaveResponse } from "../../shared/api.ts"
import { badRequest, readJson } from "../lib/errors.ts"
import { requireScope } from "../lib/validate.ts"
import type { Services } from "../services.ts"

export function instructionRoutes(svc: Services): Hono {
  const app = new Hono()

  app.get("/instructions", async (c) => {
    const raw = c.req.query("scope")
    if (!raw) throw badRequest("scope is required")
    const scope = requireScope(raw, (p) => svc.projects.has(p))
    return c.json(await svc.instructions.list(scope))
  })

  app.get("/instructions/:id", async (c) =>
    c.json(await svc.instructions.read(c.req.param("id")))
  )

  app.put("/instructions/:id", async (c) => {
    const mtimeMs = await svc.instructions.save(
      c.req.param("id"),
      await readJson<SaveInstructionRequest>(c)
    )
    svc.skills.invalidate()
    const body: SaveResponse = { mtimeMs }
    return c.json(body)
  })

  return app
}
