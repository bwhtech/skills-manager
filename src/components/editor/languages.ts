import { LanguageDescription, type LanguageSupport } from "@codemirror/language"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { yamlFrontmatter } from "@codemirror/lang-yaml"
import { languages } from "@codemirror/language-data"

/** Markdown (GFM) with YAML frontmatter and highlighted fenced code. */
export function markdownWithFrontmatter(): LanguageSupport {
  return yamlFrontmatter({
    content: markdown({ base: markdownLanguage, codeLanguages: languages }),
  })
}

export function isMarkdownPath(path: string) {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/** Language for a file by its name. Loads the grammar lazily. */
export async function languageForPath(path: string): Promise<LanguageSupport | null> {
  if (isMarkdownPath(path)) return markdownWithFrontmatter()
  const fileName = path.split("/").pop() ?? path
  const description = LanguageDescription.matchFilename(languages, fileName)
  return description ? description.load() : null
}

/** Language for a fenced code block's info string, e.g. "ts" or "bash". */
export async function languageForInfo(info: string): Promise<LanguageSupport | null> {
  const description = LanguageDescription.matchLanguageName(languages, info, true)
  return description ? description.load() : null
}
