import { Hono } from "hono"
import type { FileContent, OpenResult } from "../../shared/api.ts"
import { config } from "../config.ts"
import { PathOpener } from "../discovery/open-path.ts"
import type { Services } from "../services.ts"

/** Paths written in documents: where they lead, and a read-only view of plain files. */
export function fileRoutes(svc: Services): Hono {
  const app = new Hono()
  const opener = new PathOpener({
    home: config.home,
    roots: [config.home, "/mnt/data"],
    skills: () => svc.skills.all(),
    instructions: svc.instructions,
  })

  app.get("/open", async (c) => {
    const body: OpenResult = await opener.open(c.req.query("path"), c.req.query("from"))
    return c.json(body)
  })

  app.get("/file", async (c) => {
    const body: FileContent = await opener.read(c.req.query("path"))
    return c.json(body)
  })

  return app
}
