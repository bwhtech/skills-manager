import { Hono } from "hono"
import { serveStatic } from "hono/bun"

const PORT = Number(process.env.PORT ?? 3530)
const HOST = process.env.HOST ?? "127.0.0.1"

const app = new Hono()

app.get("/api/health", (c) => c.json({ ok: true }))

// Built UI (production). In development, Vite serves the UI and proxies /api here.
app.use("/*", serveStatic({ root: "./dist" }))
app.get("*", serveStatic({ path: "./dist/index.html" }))

export default { port: PORT, hostname: HOST, fetch: app.fetch, idleTimeout: 0 }
console.log(`skills-manager on http://${HOST}:${PORT}`)
