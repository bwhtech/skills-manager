import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LockEntry } from "../discovery/locks.ts"
import type { HttpError } from "../lib/errors.ts"
import { wellKnownIndexNames, type FetchLike } from "../preview/cli-sources.ts"
import { UpdatePreviewService } from "../preview/service.ts"

// Review round 7, item 1: the CLI's well-known fetch turns network errors and failed artifact
// downloads into "no skills". Removal must only count a skill as gone when an index was read.

const entry: LockEntry = {
  source: "example.com",
  sourceType: "well-known",
  sourceBaseUrl: "https://example.com",
  wellKnownDigest: "sha256:x",
}

const index = (...names: string[]) =>
  new Response(JSON.stringify({ skills: names.map((name) => ({ name, description: "d", files: ["SKILL.md"] })) }), {
    headers: { "content-type": "application/json" },
  })

/** Routes by URL; anything else is a 404. Artifact URLs always fail. */
function stub(routes: Record<string, () => Response | Promise<Response>>): FetchLike & { asked: string[] } {
  const asked: string[] = []
  const fn = async (url: string) => {
    asked.push(url)
    if (url.includes("/artifact")) throw new TypeError("fetch failed")
    const route = routes[url]
    return route ? route() : new Response("nope", { status: 404 })
  }
  return Object.assign(fn, { asked })
}

async function service(indexFetch: FetchLike) {
  const root = await mkdtemp(join(tmpdir(), "sm-wk-"))
  return new UpdatePreviewService(
    { root, ttlMs: 1000, maxConcurrent: 2, timeoutMs: 5000, indexFetch },
    async () => {
      throw new Error("the cached fetcher must not be used for the removal check")
    }
  )
}

const AGENT_SKILLS = "https://example.com/.well-known/agent-skills/index.json"
const SKILLS = "https://example.com/.well-known/skills/index.json"

describe("strict well-known upstream check", () => {
  test("listed in the index: present, even when its artifact would not download", async () => {
    const svc = await service(stub({ [AGENT_SKILLS]: () => index("foo", "bar") }))
    expect(await svc.upstreamState("user", "foo", entry)).toBe("present")
  })

  test("a fetched index without the skill: deleted", async () => {
    const svc = await service(stub({ [SKILLS]: () => index("bar") }))
    expect(await svc.upstreamState("user", "foo", entry)).toBe("deleted")
  })

  test("a network error, a 5xx or a broken body: could not verify (502), never deleted", async () => {
    const failures: Record<string, () => Response | Promise<Response>>[] = [
      {
        [AGENT_SKILLS]: () => {
          throw new TypeError("fetch failed")
        },
      },
      { [AGENT_SKILLS]: () => new Response("busy", { status: 503 }) },
      { [AGENT_SKILLS]: () => new Response("{ truncated", { status: 200 }) },
      // index found at the second URL only after the first failed: still an error
      { [AGENT_SKILLS]: () => new Response("", { status: 429 }), [SKILLS]: () => index("bar") },
    ]
    for (const routes of failures) {
      const svc = await service(stub(routes))
      const err = (await svc.upstreamState("user", "foo", entry).catch((e) => e)) as HttpError
      expect(err.status).toBe(502)
      expect(err.message).toBe("fetch_failed")
    }
  })

  test("no index at all: could not verify (502)", async () => {
    const svc = await service(stub({}))
    const err = (await svc.upstreamState("user", "foo", entry).catch((e) => e)) as HttpError
    expect(err.status).toBe(502)
    expect(err.detail).toContain("No skills index found")
  })

  test("a URL with a path never falls back to the root index, as discoverSkills", async () => {
    const fetchFn = stub({ [AGENT_SKILLS]: () => index("foo") })
    await expect(wellKnownIndexNames("https://example.com/team", AbortSignal.timeout(1000), fetchFn)).rejects.toThrow()
    expect(fetchFn.asked).toEqual([
      "https://example.com/team/.well-known/agent-skills/index.json",
      AGENT_SKILLS,
      "https://example.com/team/.well-known/skills/index.json",
      SKILLS,
    ])
  })
})
