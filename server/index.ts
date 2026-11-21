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

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
  idleTimeout: 0,
}
console.log(`skills-manager on http://${config.host}:${config.port}`)
