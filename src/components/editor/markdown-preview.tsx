import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { splitFrontmatter } from "./frontmatter"
import { HighlightedCode } from "./highlighted-code"

const components: Components = {
  code({ className, children }) {
    const language = /language-([\w+#.-]+)/.exec(className ?? "")?.[1]
    const text = String(children ?? "")
    if (!language) return <code className={className}>{children}</code>
    return <HighlightedCode code={text.replace(/\n$/, "")} language={language} />
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  },
}

export const MarkdownPreview = memo(function MarkdownPreview({ text }: { text: string }) {
  const { frontmatter, body } = splitFrontmatter(text)
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
