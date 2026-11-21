import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { Job } from "../../shared/api.ts"
import type { JobEvent } from "../jobs.ts"
import { notFound } from "../lib/errors.ts"
import type { Services } from "../services.ts"

export function jobRoutes(svc: Services): Hono {
  const app = new Hono()
  const find = (id: string): Job => {
    const job = svc.jobs.get(id)
    if (!job) throw notFound("Unknown job")
    return job
  }

  app.get("/jobs", (c) => c.json(svc.jobs.list()))

  app.get("/jobs/:id", (c) => c.json(find(c.req.param("id"))))

  // Replays the log, then streams new lines until the job ends.
  app.get("/jobs/:id/events", (c) => {
    const job = find(c.req.param("id"))
    return streamSSE(c, async (stream) => {
      const pending: JobEvent[] = []
      let wake: (() => void) | null = null
      const unsubscribe = svc.jobs.subscribe(job.id, (event) => {
        pending.push(event)
        wake?.()
      })
      stream.onAbort(() => {
        unsubscribe()
        wake?.()
      })
      // Subscribed and copied in the same tick, so no line is lost or sent twice.
      const replay = [...job.log]
      try {
        for (const line of replay)
          await stream.writeSSE({ event: "line", data: JSON.stringify(line) })
        while (!stream.aborted) {
          const event = pending.shift()
          if (event?.type === "done") break
          if (event) {
            await stream.writeSSE({
              event: "line",
              data: JSON.stringify(event.line),
            })
            continue
          }
          if (job.status !== "running") break
          await new Promise<void>((resolve) => (wake = resolve))
          wake = null
        }
        if (!stream.aborted)
          await stream.writeSSE({ event: "done", data: JSON.stringify(job) })
      } finally {
        unsubscribe()
      }
    })
  })

  return app
}
