import { memo, useMemo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { classifyHref, isPathLike, type LinkTarget } from "@/lib/path-links"
import { splitFrontmatter } from "./frontmatter"
import { HighlightedCode } from "./highlighted-code"

type OpenLink = (link: LinkTarget) => void

/**
 * With onOpenLink, inline code that is a path and links to paths open with a plain click;
 * inline code that is a web URL opens in a new tab.
 */
function markdownComponents(onOpenLink: OpenLink | undefined): Components {
  return {
    code({ className, children }) {
      const language = /language-([\w+#.-]+)/.exec(className ?? "")?.[1]
      const text = String(children ?? "")
      if (language) return <HighlightedCode code={text.replace(/\n$/, "")} language={language} />
      if (onOpenLink && classifyHref(text)?.kind === "url") {
        return (
          <a href={text} target="_blank" rel="noreferrer noopener">
            <code className={className}>{children}</code>
          </a>
        )
      }
      if (onOpenLink && isPathLike(text)) {
        return (
          <button type="button" className="path-link" title="Open" onClick={() => onOpenLink({ kind: "path", target: text })}>
            <code className={className}>{children}</code>
          </button>
        )
      }
      return <code className={className}>{children}</code>
    },
    a({ href, children }) {
      const link = href ? classifyHref(href) : null
      if (onOpenLink && link?.kind === "path") {
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              onOpenLink(link)
            }}
          >
            {children}
          </a>
        )
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      )
    },
  }
}

export const MarkdownPreview = memo(function MarkdownPreview({
  text,
  onOpenLink,
}: {
  text: string
  onOpenLink?: OpenLink
}) {
  const { frontmatter, body } = splitFrontmatter(text)
  const components = useMemo(() => markdownComponents(onOpenLink), [onOpenLink])
  return (
    <div className="markdown-preview">
      {frontmatter && frontmatter.entries.length > 0 && (
        <table className="frontmatter-table" aria-label="Frontmatter">
          <tbody>
            {frontmatter.entries.map(([key, value]) => (
              <tr key={key}>
                <th scope="row">{key}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  )
})
