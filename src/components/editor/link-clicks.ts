import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import { scanLine, type LinkTarget } from "@/lib/path-links"

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD_CLICK_LABEL = IS_MAC ? "⌘-click to open" : "Ctrl-click to open"

const setHeld = StateEffect.define<boolean>()
const linkMark = Decoration.mark({ class: "cm-path-link", attributes: { title: MOD_CLICK_LABEL } })

const isModHeld = (event: KeyboardEvent | MouseEvent) => event.metaKey || event.ctrlKey

/** Marks every link on the visible lines. */
function buildMarks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  let lastLine = 0
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      if (line.number > lastLine) {
        for (const link of scanLine(line.text)) builder.add(line.from + link.from, line.from + link.to, linkMark)
        lastLine = line.number
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * Cmd/Ctrl+click on a path or URL calls `open`. While the modifier is held,
 * links on the visible lines are underlined. `getOpen` returns null to turn it off.
 */
export function linkClicks(getOpen: () => ((link: LinkTarget) => void) | null | undefined): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none
      held = false
      readonly view: EditorView
      private readonly sync: (event: KeyboardEvent | MouseEvent) => void
      private readonly release: () => void

      constructor(view: EditorView) {
        this.view = view
        this.sync = (event) => this.setHeld(isModHeld(event))
        this.release = () => this.setHeld(false)
        window.addEventListener("keydown", this.sync)
        window.addEventListener("keyup", this.sync)
        window.addEventListener("blur", this.release)
        view.dom.addEventListener("mousemove", this.sync)
      }

      setHeld(held: boolean) {
        if (held === this.held || (held && !getOpen())) return
        this.view.dispatch({ effects: setHeld.of(held) })
      }

      update(update: ViewUpdate) {
        const toggled = update.transactions.some((tr) => tr.effects.some((e) => e.is(setHeld)))
        for (const tr of update.transactions)
          for (const effect of tr.effects) if (effect.is(setHeld)) this.held = effect.value
        if (!this.held) this.decorations = Decoration.none
        else if (toggled || update.docChanged || update.viewportChanged) this.decorations = buildMarks(update.view)
      }

      destroy() {
        window.removeEventListener("keydown", this.sync)
        window.removeEventListener("keyup", this.sync)
        window.removeEventListener("blur", this.release)
        this.view.dom.removeEventListener("mousemove", this.sync)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )

  const clicks = EditorView.domEventHandlers({
    mousedown(event, view) {
      const open = getOpen()
      if (!open || event.button !== 0 || !isModHeld(event)) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return false
      const line = view.state.doc.lineAt(pos)
      const offset = pos - line.from
      const link = scanLine(line.text).find((m) => m.from <= offset && offset <= m.to)
      if (!link) return false
      // Not a cursor move or an added selection range.
      event.preventDefault()
      open(link)
      return true
    },
  })

  const theme = EditorView.baseTheme({
    ".cm-path-link": { textDecoration: "underline", textUnderlineOffset: "3px", cursor: "pointer" },
  })

  return [plugin, clicks, theme]
}
