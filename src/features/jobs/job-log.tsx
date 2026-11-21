import { useLayoutEffect, useRef } from "react"

/** Monospace log that sticks to the bottom unless the user scrolled up. */
export function JobLog({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div
      ref={ref}
      role="log"
      aria-live="polite"
      aria-label="Job output"
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-2xl bg-muted/60 p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {lines.length === 0 ? (
        <span className="text-muted-foreground">No output yet.</span>
      ) : (
        <pre className="break-words whitespace-pre-wrap">{lines.join("\n")}</pre>
      )}
    </div>
  )
}
