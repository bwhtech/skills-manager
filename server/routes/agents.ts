import { Hono } from "hono"
import type { AgentsResponse } from "../../shared/api.ts"
import { readGlobalLock } from "../discovery/locks.ts"
import type { Services } from "../services.ts"

export function agentRoutes(svc: Services): Hono {
  const app = new Hono()
  app.get("/agents", async (c) => {
    const lock = await readGlobalLock()
    const body: AgentsResponse = {
      agents: svc.agents.list(),
      lastSelected: lock.lastSelectedAgents.filter((id) => svc.agents.has(id)),
    }
    return c.json(body)
  })
  return app
}
