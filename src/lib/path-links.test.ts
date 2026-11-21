import { describe, expect, test } from "bun:test"
import { MAX_SCAN_LINE, classifyHref, findLinks, isPathLike, scanLine } from "./path-links"

const targets = (line: string) => findLinks(line).map((m) => `${m.kind}:${m.target}`)

describe("isPathLike", () => {
  test("needs a file extension or a known file name", () => {
    for (const yes of ["~/setup.md", "shared/api.ts", "package.json", "src/app.ts:42", "/etc/caddy/Caddyfile", "a.md#x"])
      expect([yes, isPathLike(yes)]).toEqual([yes, true])
    for (const no of ["bun run dev", "~/pilot", "/api/open", "console.log", "react-markdown", "https://x.dev/a.md", ""])
      expect([no, isPathLike(no)]).toEqual([no, false])
  })
})

describe("findLinks", () => {
  test("inline code, link targets and bare paths", () => {
    expect(targets("- `~/setup.md` is the full reference")).toEqual(["path:~/setup.md"])
    expect(targets("See [the api](references/api.md) and `bun test`")).toEqual(["path:references/api.md"])
    expect(targets("Edit ~/.claude/CLAUDE.md, then ./run.sh:12.")).toEqual([
      "path:~/.claude/CLAUDE.md",
      "path:./run.sh:12",
    ])
    expect(targets("Docs at https://example.com/a.md.")).toEqual(["url:https://example.com/a.md"])
  })

  test("offsets point at the path itself", () => {
    const line = "read `~/setup.md` first"
    const [m] = findLinks(line)
    expect(line.slice(m.from, m.to)).toBe("~/setup.md")
  })

  test("a path inside a link is found once", () => {
    expect(targets("[`~/a.md`](~/a.md)")).toEqual(["path:~/a.md", "path:~/a.md"])
    expect(findLinks("[x](~/a.md) ~/a.md")).toHaveLength(2)
  })
})

describe("long lines", () => {
  test("a line with 5,000 paths is processed in linear time", () => {
    const line = Array.from({ length: 5000 }, (_, i) => `~/d/f${i}.md \`p${i}.ts\``).join(" ")
    findLinks(line) // warm up the regexes
    const start = performance.now()
    const found = findLinks(line)
    const elapsed = performance.now() - start
    expect(found).toHaveLength(10_000)
    expect(elapsed).toBeLessThan(50)
  })

  test("overlapping matches: the first to start wins, then the earlier kind", () => {
    // The link target and the bare path start at the same offset.
    expect(findLinks("(see [x](~/a.md))").map((m) => [m.from, m.to])).toEqual([[9, 15]])
    expect(targets("`~/a.md` ~/a.md [y](./b.md)")).toEqual(["path:~/a.md", "path:~/a.md", "path:./b.md"])
  })

  test("the editor skips lines over 10,000 characters", () => {
    const long = "~/setup.md ".padEnd(20_000, "x")
    expect(long).toHaveLength(20_000)
    expect(findLinks(long).length).toBeGreaterThan(0)
    expect(scanLine(long)).toEqual([])
    const edge = "~/setup.md ".padEnd(MAX_SCAN_LINE, "x")
    expect(scanLine(edge).map((m) => m.target)).toEqual(["~/setup.md"])
  })
})

describe("classifyHref", () => {
  test("web URLs, paths, and the rest", () => {
    expect(classifyHref("https://skills.sh")).toEqual({ kind: "url", target: "https://skills.sh" })
    expect(classifyHref("references/my%20file.md")).toEqual({ kind: "path", target: "references/my file.md" })
    expect(classifyHref("#setup")).toBeNull()
    expect(classifyHref("mailto:a@b.c")).toBeNull()
  })
})
