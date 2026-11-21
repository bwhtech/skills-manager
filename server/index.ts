import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { createApi } from "./app.ts"
import { config } from "./config.ts"
import { createServices } from "./services.ts"

const services = await createServices()

const app = new Hono()
app.route("/api", createApi(services))

// Built UI (production). In development, Vite serves the UI and proxies /api here.
app.use("/*", serveStatic({ root: "./dist" }))
app.get("*", serveStatic({ path: "./dist/index.html" }))

// Warm the skill cache and look for updates in the background.
void services.skills
  .all()
  .catch((err) => console.error("skill discovery failed:", err))
services.updates.start()

// Report removals a crash left behind. Nothing is restored or deleted here: only the banner does.
void services.recovery
  .status()
  .then(({ interruptedRemovals, unknownLeftovers }) => {
    const copies = interruptedRemovals.reduce((n, r) => n + r.items.length, 0)
    if (copies) console.warn(`${copies} separate cop${copies === 1 ? "y is" : "ies are"} set aside by an interrupted removal; see the banner.`)
    if (unknownLeftovers.length) console.warn(`Unknown trash dirs: ${unknownLeftovers.map((l) => l.path).join(", ")}`)
  })
  .catch((err) => console.error("could not read removal journals:", err))

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
  idleTimeout: 0,
}
console.log(`skills-manager on http://${config.host}:${config.port}`)
