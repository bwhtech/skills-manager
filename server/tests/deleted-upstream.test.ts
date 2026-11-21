import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { UpdateStatus } from "../../shared/api.ts"
import { SkillActions, removeSucceeded, updateSucceeded } from "../actions.ts"
import type { IndexedSkill } from "../discovery/skill-index.ts"
import type { SkillsCli } from "../cli/skills-cli.ts"
import type { ProjectService } from "../discovery/projects.ts"
import { handleError, HttpError } from "../lib/errors.ts"
import { JobManager } from "../jobs.ts"
import { toSummary } from "../routes/skills.ts"
import { updateRoutes } from "../routes/updates.ts"
import type { Services } from "../services.ts"
import { UpdateChecker } from "../updates.ts"

type Reply = { exitCode: number; lines: string[] }

/**
 * A CLI stand-in. `replies` maps a subcommand ("update", "remove", "check") to what it
 * prints and its exit code. Every call is recorded.
 */
function scriptedCli(replies: Record<string, Reply>) {
  const calls: string[][] = []
  const cli = {
    display: (args: string[]) => ["skills", ...args].join(" "),
    stream: async (args: string[], _cwd: string, onLine: (line: string) => void) => {
      calls.push(args)
      const reply = replies[args[0]] ?? { exitCode: 0, lines: [] }
      for (const line of reply.lines) onLine(line)
      return { exitCode: reply.exitCode, timedOut: false }
    },
    capture: async (args: string[]) => {
      const reply = replies[args[0]] ?? { exitCode: 0, lines: [] }
      return { exitCode: reply.exitCode, timedOut: false, output: reply.lines.join("\n") }
    },
  } as unknown as SkillsCli
  return { cli, calls }
}

const DELETED_CHECK: Reply = {
  exitCode: 1,
  lines: [
    "Checking for skill updates…",
    "Warning: The following skills from owner/repo appear to have been deleted upstream:",
    "  • gone-one",
    "  • gone-two",
    "Skipping deletion in non-interactive mode.",
    "Warning: Multiple current paths match these skills from owner/repo; skipping them rather than deleting or migrating the wrong skill:",
    "  • twin",
    "↑ fresh has an update",
    "↑ gone-one has an update", // never offered as an update while it is deleted
    "1 skill(s) can be updated; run npx skills update to install",
  ],
}

const UPDATE_OK: Reply = {
  exitCode: 0,
  lines: [
    "Updating fresh…",
    "Warning: The following skills from owner/repo appear to have been deleted upstream:",
    "  • gone-one",
    "  • gone-two",
    "Skipping deletion in non-interactive mode.",
    "✓ Updated 1 skill(s)",
  ],
}

const REMOVE_OK: Reply = {
  exitCode: 0,
  lines: ["◇  Removal process complete", "◆  Successfully removed 2 skill(s)", "└  Done!"],
}

async function settle(jobs: JobManager) {
  while (jobs.unfinished().length) await Bun.sleep(1)
  await Bun.sleep(1)
}

/** Checker, actions and the /updates routes wired like services.ts does. */
async function setup(replies: Record<string, Reply>) {
  const { cli, calls } = scriptedCli({ check: DELETED_CHECK, ...replies })
  const projects = { paths: () => [], has: () => false } as unknown as ProjectService
  const updates = new UpdateChecker(cli, projects)
  const jobs = new JobManager(() => updates.start())
  const hooks: string[] = []
  const actions = new SkillActions(cli, jobs, {
    afterUpdate: (scope, names, succeeded, output) => {
      hooks.push(`update ${succeeded}`)
      updates.noteJobOutput(scope, output)
      if (succeeded) updates.markUpdated(scope, names)
    },
    afterRemove: (scope, names, succeeded) => {
      hooks.push(`remove ${names.join(",")} ${succeeded}`)
      if (succeeded) updates.markRemoved(scope, names)
      hooks.push(`left ${(updates.get().deletedUpstream ?? []).map((d) => d.name).join(",")}`)
    },
  })
  updates.start()
  while (updates.get().checking) await Bun.sleep(1)
  const app = new Hono()
  app.onError(handleError)
  app.route("/", updateRoutes({ updates, projects, actions } as unknown as Services))
  const run = (body: unknown) =>
    app.request("/updates/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  return { updates, jobs, actions, calls, hooks, run }
}

describe("UpdateStatus.deletedUpstream", () => {
  test("a check lists deleted and ambiguous skills apart from available", async () => {
    const { updates } = await setup({})
    const status: UpdateStatus = updates.get()
    expect(status.available).toEqual([{ scope: "user", name: "fresh" }])
    expect(status.deletedUpstream).toEqual([
      { scope: "user", name: "gone-one", source: "owner/repo" },
      { scope: "user", name: "gone-two", source: "owner/repo" },
    ])
    expect(status.ambiguousUpstream).toEqual([{ scope: "user", name: "twin", source: "owner/repo" }])
    expect(status.scopeErrors).toEqual([])
    expect(updates.isDeleted("user", "GONE-ONE")).toBe(true)
    expect(updates.isDeleted("/p", "gone-one")).toBe(false)
  })

  test("an update job's output adds the deleted skills it found", async () => {
    const { updates } = await setup({ check: { exitCode: 0, lines: [] } })
    expect(updates.get().deletedUpstream).toEqual([])
    updates.noteJobOutput("user", UPDATE_OK.lines.join("\n"))
    expect(updates.get().deletedUpstream?.map((d) => d.name)).toEqual(["gone-one", "gone-two"])
  })

  test("a scope whose check failed is listed in scopeErrors", async () => {
    const { updates } = await setup({
      check: { exitCode: 0, lines: ["Checking skills from source: a/b", "  ✗ Failed to check skills from a/b"] },
    })
    expect(updates.get().scopeErrors).toEqual([
      { scope: "user", error: "user scope: 1 source could not be checked" },
    ])
  })
})

describe("POST /updates/run with remove", () => {
  test("update first, then remove, in one job; both steps in the log; pruned at once", async () => {
    const { run, jobs, calls, hooks } = await setup({ update: UPDATE_OK, remove: REMOVE_OK })
    const res = await run({ scope: "user", names: ["fresh"], remove: ["gone-one", "gone-two"] })
    expect(res.status).toBe(202)
    const { jobId } = (await res.json()) as { jobId: string }
    const job = jobs.get(jobId)!
    expect(job.kind).toBe("update")
    expect(job.update).toEqual({ scope: "user", names: ["fresh", "gone-one", "gone-two"] })
    expect(job.remove).toEqual(["gone-one", "gone-two"])
    expect(job.command).toBe("skills update fresh -g -y && skills remove -s gone-one gone-two -y -g")
    await settle(jobs)
    expect(calls.filter((c) => c[0] !== "check")).toEqual([
      ["update", "fresh", "-g", "-y"],
      ["remove", "-s", "gone-one", "gone-two", "-y", "-g"],
    ])
    expect(job.status).toBe("success")
    expect(job.log).toContain("Step 1 of 2: skills update fresh -g -y")
    expect(job.log).toContain("Step 2 of 2: skills remove -s gone-one gone-two -y -g")
    // Pruned in the hook, before the re-check (which the stub answers with the old output).
    expect(hooks).toEqual(["update true", "remove gone-one,gone-two true", "left "])
  })

  test("the pruned skills stay out of a check that started before the remove", async () => {
    const { updates } = await setup({})
    updates.start() // a check is running
    updates.markRemoved("user", ["gone-one"])
    while (updates.get().checking) await Bun.sleep(1)
    expect(updates.get().deletedUpstream?.map((d) => d.name)).toEqual(["gone-two"])
  })

  test("markRemoved drops the names at once, other scopes untouched", async () => {
    const { updates } = await setup({})
    updates.markRemoved("/p", ["gone-one"])
    expect(updates.get().deletedUpstream).toHaveLength(2)
    updates.markRemoved("user", ["gone-one"])
    expect(updates.get().deletedUpstream?.map((d) => d.name)).toEqual(["gone-two"])
  })

  test("a failed update skips the remove step", async () => {
    const { run, jobs, calls, hooks } = await setup({
      update: { exitCode: 1, lines: ["✗ Failed to update fresh", "Failed to update 1 skill(s)"] },
      remove: REMOVE_OK,
    })
    const { jobId } = (await (await run({ scope: "user", names: ["fresh"], remove: ["gone-one"] })).json()) as {
      jobId: string
    }
    await settle(jobs)
    const job = jobs.get(jobId)!
    expect(job.status).toBe("error")
    expect(calls.some((c) => c[0] === "remove")).toBe(false)
    expect(job.log).toContain("Step 2 of 2 skipped: the update failed, so nothing was removed.")
    expect(hooks).toEqual(["update false", "remove gone-one false", "left gone-one,gone-two"])
  })

  test("remove only: names empty runs no update step", async () => {
    const { run, jobs, calls } = await setup({ remove: REMOVE_OK })
    const { jobId } = (await (await run({ scope: "user", names: [], remove: ["gone-two"] })).json()) as {
      jobId: string
    }
    await settle(jobs)
    const job = jobs.get(jobId)!
    expect(job.kind).toBe("remove")
    expect(job.update).toEqual({ scope: "user", names: ["gone-two"] })
    expect(calls.filter((c) => c[0] !== "check")).toEqual([["remove", "-s", "gone-two", "-y", "-g"]])
    expect(job.status).toBe("success")
  })

  test("names that are not deleted upstream in that scope are refused", async () => {
    const { run, calls } = await setup({})
    for (const body of [
      { scope: "user", names: ["fresh"], remove: ["fresh"] },
      { scope: "user", remove: ["twin"] }, // ambiguous: never removed here
      { scope: "user", remove: ["-g"] },
      { scope: "user", remove: "gone-one" },
    ]) {
      const res = await run(body)
      expect(res.status).toBe(400)
    }
    expect(calls.some((c) => c[0] === "update" || c[0] === "remove")).toBe(false)
  })

  test("a remove overlapping a running update is refused with 409", async () => {
    const pending: (() => void)[] = []
    const slow = {
      display: (args: string[]) => args.join(" "),
      stream: () => new Promise((resolve) => pending.push(() => resolve({ exitCode: 0, timedOut: false }))),
    } as unknown as SkillsCli
    const jobs = new JobManager()
    const blocking = new SkillActions(slow, jobs)
    blocking.update({ scope: "user", names: ["gone-one"] })
    let err: HttpError | null = null
    try {
      blocking.update({ scope: "user", names: [], remove: ["gone-one"] })
    } catch (e) {
      err = e as HttpError
    }
    expect(err?.status).toBe(409)
    expect(err?.message).toBe("update_in_progress")
    while (pending.length === 0) await Bun.sleep(1)
    pending.shift()!()
  })
})

describe("step outcomes", () => {
  test("skills remove exits 0 even when nothing was removed", () => {
    expect(removeSucceeded({ code: 0, output: REMOVE_OK.lines.join("\n") })).toBe(true)
    expect(removeSucceeded({ code: 0, output: "■  No matching skills found for: x" })).toBe(false)
    expect(removeSucceeded({ code: 0, output: "Failed to remove 1 skill(s)\n  ✗ x: EACCES" })).toBe(false)
    expect(removeSucceeded({ code: 1, output: "" })).toBe(false)
  })

  test("an update whose only failures are skills gone from their download succeeded", () => {
    const gone = "  ✗ old is no longer in this download\nFailed to update 1 skill(s)"
    expect(updateSucceeded({ code: 1, output: gone })).toBe(true)
    expect(updateSucceeded({ code: 1, output: `${gone}\n✗ Failed to update x` })).toBe(false)
    expect(updateSucceeded({ code: 1, output: "TypeError: boom" })).toBe(false)
    expect(updateSucceeded({ code: 0, output: "" })).toBe(true)
  })
})

describe("SkillSummary.cliName", () => {
  // Folder and lock key foo-bar, frontmatter name "Foo Bar": they differ by more than case.
  const alias = {
    id: "id",
    name: "Foo Bar",
    description: "",
    realPath: "/home/u/.agents/skills/foo-bar",
    locations: [],
    agents: [],
    scope: "user",
    scopes: ["user"],
    origin: "npx",
    editable: true,
    cliName: "foo-bar",
    folderName: "foo-bar",
    placements: [],
  } as IndexedSkill

  test("the summary carries the CLI name, and flags match on it", async () => {
    const { updates } = await setup({
      check: {
        exitCode: 0,
        lines: ["Warning: The following skills from a/b appear to have been deleted upstream:", "  • foo-bar"],
      },
    })
    const summary = toSummary(alias, { updates })
    expect(summary.name).toBe("Foo Bar")
    expect(summary.cliName).toBe("foo-bar")
    expect(summary.deletedUpstream).toBe(true)
    expect(summary.updateAvailable).toBe(false)
    expect(toSummary({ ...alias, cliName: "Foo Bar" }, { updates }).deletedUpstream).toBeUndefined()
  })

  test("manual skills have no cliName", () => {
    const updates = new UpdateChecker({} as SkillsCli, { paths: () => [] } as unknown as ProjectService)
    expect(toSummary({ ...alias, origin: "manual" }, { updates }).cliName).toBeUndefined()
  })
})
