import { describe, expect, test } from "bun:test"
import { updateTargetsOverlap } from "../../shared/api.ts"
import { SkillActions } from "../actions.ts"
import type { SkillsCli } from "../cli/skills-cli.ts"
import type { ProjectService } from "../discovery/projects.ts"
import { HttpError } from "../lib/errors.ts"
import { JobManager } from "../jobs.ts"
import { UpdateChecker } from "../updates.ts"

/** A CLI stand-in: each run waits until the test releases it. */
function fakeCli(exitCode = 0) {
  const pending: (() => void)[] = []
  const cli = {
    display: (args: string[]) => ["skills", ...args].join(" "),
    stream: () =>
      new Promise<{ exitCode: number; timedOut: boolean }>((resolve) =>
        pending.push(() => resolve({ exitCode, timedOut: false }))
      ),
  } as unknown as SkillsCli
  return {
    cli,
    /** finish the oldest running CLI call */
    release: async () => {
      while (pending.length === 0) await Bun.sleep(1)
      pending.shift()!()
      await Bun.sleep(1)
    },
  }
}

function setup(exitCode = 0, hooks = {}) {
  const fake = fakeCli(exitCode)
  const jobs = new JobManager()
  const actions = new SkillActions(fake.cli, jobs, hooks)
  return { ...fake, jobs, actions }
}

function refusal(run: () => unknown): HttpError | null {
  try {
    run()
    return null
  } catch (err) {
    return err as HttpError
  }
}

describe("updateTargetsOverlap", () => {
  test("same scope and a shared name, without case", () => {
    expect(updateTargetsOverlap({ scope: "user", names: ["a", "B"] }, { scope: "user", names: ["b"] })).toBe(true)
    expect(updateTargetsOverlap({ scope: "user", names: ["a"] }, { scope: "user", names: ["b"] })).toBe(false)
  })

  test("names empty = every skill in that scope only", () => {
    expect(updateTargetsOverlap({ scope: "user", names: [] }, { scope: "user", names: ["x"] })).toBe(true)
    expect(updateTargetsOverlap({ scope: "user", names: ["x"] }, { scope: "user", names: [] })).toBe(true)
    expect(updateTargetsOverlap({ scope: "user", names: [] }, { scope: "/p", names: [] })).toBe(false)
    expect(updateTargetsOverlap({ scope: "user", names: ["x"] }, { scope: "/p", names: ["x"] })).toBe(false)
  })
})

describe("overlapping update jobs", () => {
  test("a second update of a running skill is refused with 409 update_in_progress", async () => {
    const { actions, release } = setup()
    const first = actions.update({ scope: "user", names: ["foo"] })
    expect(first.update).toEqual({ scope: "user", names: ["foo"] })
    const err = refusal(() => actions.update({ scope: "user", names: ["bar", "foo"] }))
    expect(err).toBeInstanceOf(HttpError)
    expect(err?.status).toBe(409)
    expect(err?.message).toBe("update_in_progress")
    expect(err?.extra).toEqual({ jobId: first.id })
    await release()
  })

  test("a queued job counts too, and so does 'all in scope'", async () => {
    const { actions, release } = setup()
    actions.update({ scope: "user", names: ["foo"] }) // running
    const queued = actions.update({ scope: "user", names: ["bar"] }) // waits for the first
    expect(refusal(() => actions.update({ scope: "user", names: ["bar"] }))?.extra).toEqual({ jobId: queued.id })
    // Every skill in user scope overlaps both.
    expect(refusal(() => actions.update({ scope: "user", names: [] }))?.status).toBe(409)
    await release()
    await release()
  })

  test("a running 'all in scope' job blocks every name in that scope, not other scopes", async () => {
    const { actions, release } = setup()
    actions.update({ scope: "user", names: [] })
    expect(refusal(() => actions.update({ scope: "user", names: ["anything"] }))?.status).toBe(409)
    expect(refusal(() => actions.update({ scope: "/p", names: ["anything"] }))).toBeNull()
    await release()
    await release()
  })

  test("after the job ends, the same update can run again", async () => {
    const { actions, jobs, release } = setup()
    const first = actions.update({ scope: "user", names: ["foo"] })
    await release()
    expect(jobs.get(first.id)?.status).toBe("success")
    expect(refusal(() => actions.update({ scope: "user", names: ["foo"] }))).toBeNull()
    await release()
  })

  test("the after-update hook learns whether the job succeeded", async () => {
    const calls: unknown[] = []
    const ok = setup(0, { afterUpdate: (...args: unknown[]) => calls.push(args) })
    ok.actions.update({ scope: "user", names: ["foo"] })
    await ok.release()
    const failed = setup(1, { afterUpdate: (...args: unknown[]) => calls.push(args) })
    failed.actions.update({ scope: "/p", names: [] })
    await failed.release()
    expect(calls).toEqual([
      ["user", ["foo"], true],
      ["/p", [], false],
    ])
  })

  test("the hooks run before the done event goes out", async () => {
    const order: string[] = []
    const jobs = new JobManager(() => order.push("finished"))
    const job = jobs.enqueue({
      kind: "update",
      title: "t",
      command: "c",
      cwd: "/",
      run: async () => 0,
      onDone: () => order.push("onDone"),
    })
    jobs.subscribe(job.id, (event) => event.type === "done" && order.push("done"))
    await Bun.sleep(5)
    expect(order).toEqual(["onDone", "finished", "done"])
  })
})

describe("UpdateChecker.markUpdated", () => {
  /** A checker whose `skills check` output the test controls. */
  function checker(outputs: Record<string, string>) {
    const pending: (() => void)[] = []
    const cli = {
      capture: (args: string[]) =>
        new Promise((resolve) =>
          pending.push(() =>
            resolve({ exitCode: 1, timedOut: false, output: outputs[args.includes("-g") ? "user" : "project"] ?? "" })
          )
        ),
    } as unknown as SkillsCli
    const projects = { paths: () => [] } as unknown as ProjectService
    const updates = new UpdateChecker(cli, projects)
    const finishCheck = async () => {
      while (pending.length === 0) await Bun.sleep(1)
      pending.shift()!()
      await Bun.sleep(1)
    }
    return { updates, finishCheck, outputs }
  }

  const CHECK = "↑ foo has an update\n↑ bar has an update\n✗ old-thing: no longer in its download source\n"

  test("drops the updated pairs at once and keeps the rest, failures included", async () => {
    const { updates, finishCheck } = checker({ user: CHECK })
    updates.start()
    await finishCheck()
    expect(updates.get().available.map((a) => a.name).sort()).toEqual(["bar", "foo"])
    const failedBefore = updates.get().failed

    updates.markUpdated("user", ["FOO"])
    expect(updates.get().available).toEqual([{ scope: "user", name: "bar" }])
    expect(updates.has("user", ["foo"])).toBe(false)
    expect(updates.get().failed).toEqual(failedBefore)
    expect(updates.get().checking).toBe(false)
  })

  test("names empty drops every name in that scope", async () => {
    const { updates, finishCheck } = checker({ user: CHECK })
    updates.start()
    await finishCheck()
    updates.markUpdated("/other", [])
    expect(updates.get().available).toHaveLength(2)
    updates.markUpdated("user", [])
    expect(updates.get().available).toEqual([])
  })

  test("a check that started before the update does not bring the pair back", async () => {
    const { updates, finishCheck, outputs } = checker({ user: CHECK })
    updates.start()
    await finishCheck()
    // A check is running (its CLI call started before the update finished)...
    updates.start()
    updates.markUpdated("user", ["foo"])
    updates.start() // what the job manager does after every job
    // ...and still reports foo, because it read the old state.
    await finishCheck()
    expect(updates.get().available).toEqual([{ scope: "user", name: "bar" }])
    // The queued re-check is the truth from now on.
    outputs.user = "↑ bar has an update\n"
    await finishCheck()
    expect(updates.get()).toMatchObject({ checking: false, available: [{ scope: "user", name: "bar" }] })
  })
})
