import { EditorView } from "@codemirror/view"

// Colors come from the app's CSS variables, so the editor follows the theme.
export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.6",
    // Scrolling past the end must not drag the page or the screen behind.
    overscrollBehavior: "contain",
  },
  ".cm-content": {
    // Last lines clear the home indicator on phones (0 elsewhere).
    padding: "12px 0 calc(12px + env(safe-area-inset-bottom, 0px))",
    caretColor: "var(--foreground)",
  },
  ".cm-line": { padding: "0 16px 0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "color-mix(in oklch, var(--primary) 30%, transparent)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 12px", minWidth: "36px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px" },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent)",
    outline: "none",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--chart-2) 35%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklch, var(--chart-3) 50%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button": { fontFamily: "inherit", fontSize: "12px" },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
  },
})
