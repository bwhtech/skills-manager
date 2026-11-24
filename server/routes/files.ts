import { Hono } from "hono"
import type { OpenResult, SaveRequest, SaveResponse, ViewedFileContent } from "../../shared/api.ts"
import { config } from "../config.ts"
import { PathOpener } from "../discovery/open-path.ts"
import { readJson } from "../lib/errors.ts"
import type { Services } from "../services.ts"

/** HOME, and the folders whose files may be shown (and Markdown files saved). */
export interface FileRoots {
  home: string
  roots: string[]
}

function defaultFileRoots(): FileRoots {
  return { home: config.home, roots: [config.home, ...config.extraFileRoots] }
}

/** Paths written in documents: where they lead, and a view of plain files (Markdown ones editable). */
export function fileRoutes(svc: Services, where: FileRoots = defaultFileRoots()): Hono {
  const app = new Hono()
  const opener = new PathOpener({
    ...where,
    skills: () => svc.skills.all(),
    instructions: svc.instructions,
  })

  app.get("/open", async (c) => {
    const body: OpenResult = await opener.open(c.req.query("path"), c.req.query("from"))
    return c.json(body)
  })

  app.get("/file", async (c) => {
    const body: ViewedFileContent = await opener.read(c.req.query("path"))
    return c.json(body)
  })

  app.put("/file", async (c) => {
    const body: SaveResponse = await opener.save(c.req.query("path"), await readJson<SaveRequest>(c))
    return c.json(body)
  })

  return app
}
