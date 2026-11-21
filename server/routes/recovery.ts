import { Hono } from "hono"
import type { RecoveryRequest } from "../../shared/api.ts"
import { readJson } from "../lib/errors.ts"
import type { Services } from "../services.ts"

/** Interrupted removals: list, move back, delete (shared/api.ts, Recovery). */
export function recoveryRoutes(svc: Services): Hono {
  const app = new Hono()

  app.get("/recovery", async (c) => c.json(await svc.recovery.status()))

  app.post("/recovery/restore", async (c) => {
    const req = await readJson<RecoveryRequest>(c)
    return c.json(await svc.recovery.restore(req.jobId, req.staged))
  })

  app.post("/recovery/delete", async (c) => {
    const req = await readJson<RecoveryRequest>(c)
    return c.json(await svc.recovery.delete(req.jobId, req.staged))
  })

  return app
}
