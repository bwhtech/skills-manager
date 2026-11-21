import { Hono } from "hono"
import type {
  LinkInstructionRequest,
  LinkInstructionResponse,
  SaveInstructionRequest,
  SaveResponse,
  SyncPreview,
  UnlinkInstructionRequest,
  UnlinkInstructionResponse,
} from "../../shared/api.ts"
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

  app.get("/instructions/:id/sync-preview", async (c) => {
    const body: SyncPreview = await svc.instructions.syncPreview(
      c.req.param("id")
    )
    return c.json(body)
  })

  app.post("/instructions/:id/link", async (c) => {
    const body: LinkInstructionResponse = await svc.instructions.link(
      c.req.param("id"),
      await readJson<LinkInstructionRequest>(c)
    )
    svc.skills.invalidate()
    return c.json(body)
  })

  app.post("/instructions/:id/unlink", async (c) => {
    const body: UnlinkInstructionResponse = await svc.instructions.unlink(
      c.req.param("id"),
      await readJson<UnlinkInstructionRequest>(c)
    )
    svc.skills.invalidate()
    return c.json(body)
  })

  app.get("/instructions/:id", async (c) =>
    c.json(await svc.instructions.read(c.req.param("id")))
  )

  app.put("/instructions/:id", async (c) => {
    const body: SaveResponse = await svc.instructions.save(
      c.req.param("id"),
      await readJson<SaveInstructionRequest>(c)
    )
    svc.skills.invalidate()
    return c.json(body)
  })

  return app
}
