import { describe, expect, test } from "bun:test"
import { classifyHref, findLinks, isPathLike } from "./path-links"

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

describe("classifyHref", () => {
  test("web URLs, paths, and the rest", () => {
    expect(classifyHref("https://skills.sh")).toEqual({ kind: "url", target: "https://skills.sh" })
    expect(classifyHref("references/my%20file.md")).toEqual({ kind: "path", target: "references/my file.md" })
    expect(classifyHref("#setup")).toBeNull()
    expect(classifyHref("mailto:a@b.c")).toBeNull()
  })
})
