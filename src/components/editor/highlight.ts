import { syntaxHighlighting } from "@codemirror/language"
import { classHighlighter, tagHighlighter, tags } from "@lezer/highlight"

// Tokens get tok-* classes; index.css colors them from CSS variables, so the
// editor and the preview share one theme in light and dark mode.

const extraHighlighter = tagHighlighter([
  { tag: tags.monospace, class: "tok-monospace" },
  { tag: tags.quote, class: "tok-quote" },
  { tag: tags.list, class: "tok-list" },
  { tag: tags.contentSeparator, class: "tok-meta" },
  { tag: tags.processingInstruction, class: "tok-meta" },
  { tag: tags.strikethrough, class: "tok-strikethrough" },
])

export const highlighters = [classHighlighter, extraHighlighter]

export const highlighting = [
  syntaxHighlighting(classHighlighter),
  syntaxHighlighting(extraHighlighter),
]
