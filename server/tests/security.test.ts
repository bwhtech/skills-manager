import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { hostGuard, mutationGuard } from "../lib/security.ts"

const TAILNET = "box.tail0.ts.net"

const app = new Hono()
app.use("*", hostGuard([TAILNET]))
app.use("*", mutationGuard)
app.all("/x", (c) => c.text("ok"))

/** Bun's server as app.fetch's env: requestIP gives the TCP peer. */
const peer = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 50000 }) })
const LOOPBACK = peer("127.0.0.1")

function call(method: string, headers: Record<string, string> = {}, env: object = LOOPBACK) {
  return app.request(
    "http://localhost:3530/x",
    { method, headers: { host: "localhost:3530", ...headers } },
    env
  )
}

describe("mutationGuard", () => {
  test("GET passes without the header", async () => {
    expect((await call("GET")).status).toBe(200)
  })

  test("mutations need X-Skills-Manager: 1", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect((await call(method)).status).toBe(403)
      expect((await call(method, { "X-Skills-Manager": "0" })).status).toBe(403)
      expect((await call(method, { "X-Skills-Manager": "1" })).status).toBe(200)
    }
  })

  test("Origin must match Host", async () => {
    const h = { "X-Skills-Manager": "1" }
    expect(
      (await call("POST", { ...h, origin: "http://localhost:3530" })).status
    ).toBe(200)
    expect(
      (await call("POST", { ...h, origin: "http://evil.example" })).status
    ).toBe(403)
    expect(
      (await call("POST", { ...h, origin: "http://localhost:9999" })).status
    ).toBe(403)
    expect((await call("POST", { ...h, origin: "null" })).status).toBe(403)
  })

  test("Origin may match X-Forwarded-Host from a local proxy", async () => {
    const res = await call("POST", {
      "X-Skills-Manager": "1",
      origin: `https://${TAILNET}:8466`,
      "x-forwarded-host": `${TAILNET}:8466`,
    })
    expect(res.status).toBe(200)
  })

  test("a remote peer's X-Forwarded-Host does not satisfy the Origin check", async () => {
    const headers = { "X-Skills-Manager": "1", origin: `https://${TAILNET}:8466`, "x-forwarded-host": `${TAILNET}:8466` }
    expect((await call("POST", headers, peer("100.64.0.9"))).status).toBe(403)
    expect((await call("POST", headers, {})).status).toBe(403)
  })

  test("403 body is an ApiError", async () => {
    expect(await (await call("DELETE")).json()).toMatchObject({
      error: "forbidden",
    })
  })
})

describe("hostGuard", () => {
  test("loopback names and the allowlist pass on any port", async () => {
    for (const host of ["localhost", "localhost:5530", "127.0.0.1:3524", "[::1]:3530", `${TAILNET}:8466`, "LOCALHOST:1"])
      expect([host, (await call("GET", { host })).status]).toEqual([host, 200])
  })

  test("a foreign Host gets 403 bad_host", async () => {
    for (const host of ["evil.example", "evil.example:3530", "127.0.0.1.evil.example", `${TAILNET}.evil.example`, "[::2]:3530"]) {
      const res = await call("GET", { host })
      expect([host, res.status]).toEqual([host, 403])
      expect(await res.json()).toMatchObject({ error: "bad_host" })
    }
  })

  test("X-Forwarded-Host from loopback must be allowed too", async () => {
    expect((await call("GET", { "x-forwarded-host": `${TAILNET}:8466` })).status).toBe(200)
    expect((await call("GET", { "x-forwarded-host": "evil.example" })).status).toBe(403)
    expect((await call("GET", { "x-forwarded-host": `${TAILNET}, evil.example` })).status).toBe(403)
  })

  test("X-Forwarded-Host from a remote peer is ignored", async () => {
    // Neither lets a foreign Host through nor blocks an allowed one.
    const remote = peer("100.64.0.9")
    expect((await call("GET", { host: "evil.example", "x-forwarded-host": "localhost" }, remote)).status).toBe(403)
    expect((await call("GET", { "x-forwarded-host": "evil.example" }, remote)).status).toBe(200)
    expect((await call("GET", { "x-forwarded-host": "evil.example" }, {})).status).toBe(200)
  })

  test("Sec-Fetch-Site: cross-site gets 403; same-origin, same-site, none and missing pass", async () => {
    expect((await call("GET", { "sec-fetch-site": "cross-site" })).status).toBe(403)
    for (const site of ["same-origin", "same-site", "none"])
      expect((await call("GET", { "sec-fetch-site": site })).status).toBe(200)
    expect((await call("GET")).status).toBe(200)
  })
})
