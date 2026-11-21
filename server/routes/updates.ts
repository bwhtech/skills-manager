import { Hono } from "hono"
import type { JobRef, UpdateRunRequest, UpdateStatus } from "../../shared/api.ts"
import { readScopeLock } from "../discovery/locks.ts"
import { badRequest, readJson } from "../lib/errors.ts"
import { isSkillName, requireScope } from "../lib/validate.ts"
import { requireRemovalNames, requireShownPlans } from "../removal/guard.ts"
import { invalidNameReason } from "../removal/plan.ts"
import type { Services } from "../services.ts"

export function updateRoutes(svc: Services): Hono {
  const app = new Hono()
  const readLock = svc.readLock ?? readScopeLock

  /** The status, with a removal plan per deleted-upstream skill (from the disk, now). */
  async function statusWithPlans(status: UpdateStatus): Promise<UpdateStatus> {
    await svc.updates.reconcile()
    const current = svc.updates.get()
    const removalPlans = await svc.removals.statusPlans(current.deletedUpstream ?? [])
    return { ...status, deletedUpstream: current.deletedUpstream, removalPlans }
  }

  app.get("/updates", async (c) => c.json(await statusWithPlans(svc.updates.get())))

  app.post("/updates/check", async (c) => c.json(await statusWithPlans(svc.updates.start())))

  app.post("/updates/run", async (c) => {
    const req = await readJson<UpdateRunRequest>(c)
    const scope = requireScope(req.scope, (p) => svc.projects.has(p))
    if (req.names !== undefined && !Array.isArray(req.names))
      throw badRequest("names must be an array")
    if (req.remove !== undefined && !Array.isArray(req.remove))
      throw badRequest("remove must be an array")
    const lockKeys = new Set(
      req.names?.length || req.remove?.length
        ? (await readLock(scope).catch(() => null))?.skills.keys()
        : []
    )
    const names = req.names?.length ? requireUpdateNames(req.names, lockKeys) : []
    const remove = req.remove?.length ? requireRemovalNames(req.remove, lockKeys) : []
    const authorized = remove.length
      ? {
          shown: requireShownPlans(req.removePlans),
          plans: [] as Awaited<ReturnType<typeof svc.removals.authorize>>,
        }
      : null
    if (authorized)
      authorized.plans = await svc.removals.authorize(scope, remove, authorized.shown)
    const job = svc.actions.update({
      scope,
      names,
      ...(authorized ? { remove: authorized } : {}),
    })
    const body: JobRef = { jobId: job.id }
    return c.json(body, 202)
  })

  return app
}

/**
 * Update names: a plain name, or an exact lock key of the scope (spaces and Unicode are
 * fine there). Never a leading "-" or a control character: they would reach the CLI argv.
 */
export function requireUpdateNames(value: unknown[], lockKeys: ReadonlySet<string>): string[] {
  for (const name of value) {
    if (typeof name !== "string" || invalidNameReason(name))
      throw badRequest("names has an invalid name")
    if (!isSkillName(name) && !lockKeys.has(name))
      throw badRequest(`names has an invalid name: ${name} is not a lock key of this scope`)
  }
  return [...new Set(value as string[])]
}
