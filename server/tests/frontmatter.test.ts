import { describe, expect, test } from "bun:test"
import { parseFrontmatter, stringField } from "../lib/frontmatter.ts"

describe("parseFrontmatter", () => {
  test("reads name and description", () => {
    const fm = parseFrontmatter(
      "---\nname: demo\ndescription: Does things\n---\n# Body\n"
    )
    expect(fm.hasFrontmatter).toBe(true)
    expect(fm.data).toEqual({ name: "demo", description: "Does things" })
    expect(fm.body).toBe("# Body\n")
  })

  test("handles CRLF, BOM and quoted values with colons", () => {
    const fm = parseFrontmatter(
      '﻿---\r\nname: demo\r\ndescription: "a: b"\r\n---\r\nbody'
    )
    expect(stringField(fm.data, "description")).toBe("a: b")
    expect(fm.body).toBe("body")
  })

  test("handles folded multi-line descriptions", () => {
    const fm = parseFrontmatter(
      "---\nname: x\ndescription: >\n  line one\n  line two\n---\n"
    )
    expect(stringField(fm.data, "description")).toBe("line one line two")
  })

  test("empty frontmatter block", () => {
    const fm = parseFrontmatter("---\n---\nbody")
    expect(fm.hasFrontmatter).toBe(true)
    expect(fm.data).toEqual({})
    expect(fm.body).toBe("body")
  })

  test("no frontmatter", () => {
    const fm = parseFrontmatter("# Just markdown\n---\n")
    expect(fm.hasFrontmatter).toBe(false)
    expect(fm.body).toBe("# Just markdown\n---\n")
  })

  test("broken YAML falls back to flat key: value lines", () => {
    const fm = parseFrontmatter(
      "---\nname: demo\ndescription: [unclosed\n---\n"
    )
    expect(fm.error).toBeString()
    expect(fm.data.name).toBe("demo")
  })

  test("non-object YAML gives empty data", () => {
    expect(parseFrontmatter("---\n- a\n- b\n---\n").data).toEqual({})
  })

  test("stringField ignores non-strings", () => {
    expect(stringField({ a: ["x"], b: 3, c: "  t  " }, "a")).toBe("")
    expect(stringField({ b: 3 }, "b")).toBe("3")
    expect(stringField({ c: "  t  " }, "c")).toBe("t")
  })
})
