// Loaded with React.lazy: @pierre/diffs and its Shiki highlighter stay out of
// the main bundle. Shiki loads each language and theme on first use.
import { useMemo } from "react"
import { MultiFileDiff, type FileContents, type FileDiffOptions } from "@pierre/diffs/react"
import type { UpdateFileChange } from "@shared/api"
import { useDarkClass } from "@/hooks/use-dark-class"

export type DiffLayout = "unified" | "split"

interface DiffViewProps {
  change: UpdateFileChange
  layout: DiffLayout
}

const THEMES = { light: "pierre-light", dark: "pierre-dark" } as const

export default function DiffView({ change, layout }: DiffViewProps) {
  const dark = useDarkClass()

  // Added and removed files have one side only.
  const oldFile = useMemo<FileContents | null>(
    () => (change.status === "added" ? null : { name: change.path, contents: change.oldContent ?? "" }),
    [change]
  )
  const newFile = useMemo<FileContents | null>(
    () => (change.status === "removed" ? null : { name: change.path, contents: change.newContent ?? "" }),
    [change]
  )

  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      theme: THEMES,
      themeType: dark ? "dark" : "light",
      diffStyle: layout,
      // Skills are mostly prose: wrap long lines rather than scroll each one sideways.
      overflow: "wrap",
      // The row above the diff already shows the path, status and counts.
      disableFileHeader: true,
      lineDiffType: "word-alt",
      hunkSeparators: "line-info",
    }),
    [dark, layout]
  )

  if (oldFile && newFile) {
    return <MultiFileDiff className="update-diff" oldFile={oldFile} newFile={newFile} options={options} />
  }
  if (newFile) return <MultiFileDiff className="update-diff" oldFile={null} newFile={newFile} options={options} />
  if (oldFile) return <MultiFileDiff className="update-diff" oldFile={oldFile} newFile={null} options={options} />
  return null
}
