import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { mutationGuard } from "../lib/security.ts"

const app = new Hono()
app.use("*", mutationGuard)
app.all("/x", (c) => c.text("ok"))

function call(method: string, headers: Record<string, string> = {}) {
  return app.request("http://localhost:3530/x", {
    method,
    headers: { host: "localhost:3530", ...headers },
  })
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
      origin: "https://box.ts.net:8466",
      "x-forwarded-host": "box.ts.net:8466",
    })
    expect(res.status).toBe(200)
  })

  test("403 body is an ApiError", async () => {
    expect(await (await call("DELETE")).json()).toMatchObject({
      error: "forbidden",
    })
  })
})
