import { useEffect, useState, type ReactNode } from "react"
import { highlightCode } from "@lezer/highlight"
import { highlighters } from "./highlight"
import { languageForInfo } from "./languages"

/** A fenced code block, highlighted with the same grammar the editor uses. */
export function HighlightedCode({ code, language }: { code: string; language: string }) {
  const [nodes, setNodes] = useState<ReactNode[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void languageForInfo(language).then((support) => {
      if (cancelled || !support) return
      const tree = support.language.parser.parse(code)
      const out: ReactNode[] = []
      highlightCode(
        code,
        tree,
        highlighters,
        (text, classes) =>
          out.push(classes ? <span key={out.length} className={classes}>{text}</span> : text),
        () => out.push("\n")
      )
      setNodes(out)
    })
    return () => {
      cancelled = true
    }
  }, [code, language])

  return <code className={`language-${language}`}>{nodes ?? code}</code>
}
