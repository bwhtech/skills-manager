import { Hono } from "hono"
import { config } from "./config.ts"
import { handleError } from "./lib/errors.ts"
import { hostGuard, mutationGuard } from "./lib/security.ts"
import { agentRoutes } from "./routes/agents.ts"
import { type FileRoots, fileRoutes } from "./routes/files.ts"
import { installRoutes } from "./routes/install.ts"
import { instructionRoutes } from "./routes/instructions.ts"
import { jobRoutes } from "./routes/jobs.ts"
import { recoveryRoutes } from "./routes/recovery.ts"
import { scopeRoutes } from "./routes/scopes.ts"
import { skillRoutes } from "./routes/skills.ts"
import { updateRoutes } from "./routes/updates.ts"
import type { Services } from "./services.ts"

export interface ApiOptions {
  /** tests: where /api/open and /api/file look, instead of HOME and /mnt/data */
  fileRoots?: FileRoots
}

/** The /api app. */
export function createApi(svc: Services, options: ApiOptions = {}): Hono {
  const api = new Hono()
  api.use("*", hostGuard(config.allowedHosts))
  api.use("*", mutationGuard)
  api.onError(handleError)
  api.get("/health", (c) => c.json({ ok: true }))
  for (const routes of [
    scopeRoutes,
    agentRoutes,
    skillRoutes,
    instructionRoutes,
    updateRoutes,
    installRoutes,
    jobRoutes,
    recoveryRoutes,
  ]) {
    api.route("/", routes(svc))
  }
  api.route("/", fileRoutes(svc, options.fileRoots))
  api.all("*", (c) =>
    c.json(
      { error: "not_found", detail: `No route ${c.req.method} ${c.req.path}` },
      404
    )
  )
  return api
}
