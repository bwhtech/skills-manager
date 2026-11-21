import { describe, expect, test } from "bun:test"
import { hasLineEditor, requestLine, subscribeLineRequests, takePendingLine } from "./pending-line"

describe("pending-line", () => {
  test("a request is taken once, by its key only", () => {
    requestLine("a", 42)
    expect(takePendingLine("b")).toBeUndefined()
    expect(takePendingLine("a")).toBe(42)
    expect(takePendingLine("a")).toBeUndefined()
  })

  test("a request does not expire", () => {
    const realNow = Date.now
    requestLine("a", 7)
    Date.now = () => realNow() + 60_000
    try {
      expect(takePendingLine("a")).toBe(7)
    } finally {
      Date.now = realNow
    }
  })

  test("a newer request replaces the older one; no line clears it", () => {
    requestLine("a", 1)
    requestLine("b", 2)
    expect(takePendingLine("a")).toBeUndefined()
    requestLine("b", undefined)
    expect(takePendingLine("b")).toBeUndefined()
  })

  test("a mounted editor hears requests for its key and takes them at once", () => {
    const seen: (number | undefined)[] = []
    const stop = subscribeLineRequests("a", () => seen.push(takePendingLine("a")))
    expect(hasLineEditor("a")).toBe(true)
    requestLine("a", 3)
    requestLine("a", 3)
    requestLine("b", 4)
    // Not "a"'s request: left for the editor of "b" that mounts next.
    expect(takePendingLine("b")).toBe(4)
    requestLine("a", undefined)
    expect(seen).toEqual([3, 3])
    stop()
    expect(hasLineEditor("a")).toBe(false)
    requestLine("a", 5)
    expect(seen).toEqual([3, 3])
    expect(takePendingLine("a")).toBe(5)
  })

  test("a late unsubscribe leaves a newer editor for the same key alone", () => {
    const stopOld = subscribeLineRequests("a", () => {})
    stopOld()
    const stopNew = subscribeLineRequests("a", () => {})
    stopOld()
    expect(hasLineEditor("a")).toBe(true)
    stopNew()
    expect(hasLineEditor("a")).toBe(false)
  })
})
