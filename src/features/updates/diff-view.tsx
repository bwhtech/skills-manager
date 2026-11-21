// Loaded with React.lazy: @pierre/diffs and its Shiki highlighter stay out of
// the main bundle. Shiki loads each language and theme on first use.
import { useContext, useLayoutEffect, useMemo, type ReactNode } from "react"
import { DEFAULT_VIRTUAL_FILE_METRICS, Virtualizer } from "@pierre/diffs"
import { MultiFileDiff, VirtualizerContext, type FileContents, type FileDiffOptions } from "@pierre/diffs/react"
import type { UpdateFileChange } from "@shared/api"
import { useDarkClass } from "@/hooks/use-dark-class"
import { DiffScrollContext, type DiffScrollSlot } from "./diff-scroll"

export type DiffLayout = "unified" | "split"

interface DiffViewProps {
  change: UpdateFileChange
  layout: DiffLayout
}

const THEMES = { light: "pierre-light", dark: "pierre-dark" } as const

// Row height before a line is measured: --diffs-line-height in index.css.
const METRICS = { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight: 18 }

/**
 * The virtualizer that every diff in a dialog body shares. A diff that mounts
 * inside it renders only the lines near the viewport: a skill update can
 * bring tens of thousands of lines. Created on first use (no DOM work), bound
 * to the scroll container after mount, disposed of by the body.
 */
function useSharedVirtualizer(slot: DiffScrollSlot | null): Virtualizer | undefined {
  const virtualizer = slot?.shared(() => {
    const value = new Virtualizer()
    return { value, dispose: () => value.cleanUp() }
  })
  // Diffs connect before this runs; the virtualizer queues them until setup. Setup runs once.
  useLayoutEffect(() => {
    if (slot && virtualizer) virtualizer.setup(slot.root, slot.content)
  }, [slot, virtualizer])
  return virtualizer
}

function Virtualized({ children }: { children: ReactNode }) {
  const virtualizer = useSharedVirtualizer(useContext(DiffScrollContext))
  // Outside a dialog body: plain rendering.
  if (!virtualizer) return children
  return <VirtualizerContext.Provider value={virtualizer}>{children}</VirtualizerContext.Provider>
}

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

  if (!oldFile && !newFile) return null
  return (
    <Virtualized>
      {oldFile && newFile ? (
        <MultiFileDiff className="update-diff" oldFile={oldFile} newFile={newFile} options={options} metrics={METRICS} />
      ) : newFile ? (
        <MultiFileDiff className="update-diff" oldFile={null} newFile={newFile} options={options} metrics={METRICS} />
      ) : (
        <MultiFileDiff className="update-diff" oldFile={oldFile!} newFile={null} options={options} metrics={METRICS} />
      )}
    </Virtualized>
  )
}
