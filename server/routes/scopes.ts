import { Hono } from "hono"
import type {
  PinRequest,
  ProjectInfo,
  ScopesResponse,
} from "../../shared/api.ts"
import { config } from "../config.ts"
import { readJson } from "../lib/errors.ts"
import type { Services } from "../services.ts"

export function scopeRoutes(svc: Services): Hono {
  const app = new Hono()
  const respond = async () => scopesResponse(svc)

  app.get("/scopes", async (c) => c.json(await respond()))

  app.post("/projects/rescan", async (c) => {
    await svc.projects.rescan()
    await svc.agents.refreshDetection()
    svc.skills.invalidate()
    return c.json(await respond())
  })

  app.post("/projects/pin", async (c) => {
    await svc.projects.pin((await readJson<PinRequest>(c)).path)
    svc.skills.invalidate()
    return c.json(await respond())
  })

  app.delete("/projects/pin", async (c) => {
    await svc.projects.unpin((await readJson<PinRequest>(c)).path)
    svc.skills.invalidate()
    return c.json(await respond())
  })

  return app
}

async function scopesResponse(svc: Services): Promise<ScopesResponse> {
  const skills = await svc.skills.all()
  const projects: ProjectInfo[] = await Promise.all(
    svc.projects.list().map(async (p) => ({
      path: p.path,
      name: p.path.split("/").pop() ?? p.path,
      pinned: p.pinned,
      discovered: p.discovered,
      skillCount: skills.filter((s) => s.scopes.includes(p.path)).length,
      instructionFileCount: await svc.instructions.countExisting(p.path),
    }))
  )
  return {
    home: config.home,
    projects,
    scanRoots: [config.home],
    lastScanAt: svc.projects.lastScanAt(),
  }
}
