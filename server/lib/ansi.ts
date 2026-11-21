// Matches CSI and OSC escape sequences.
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// Cursor moves to column 1 (spinners redraw the line this way).
// eslint-disable-next-line no-control-regex
const LINE_RESET = /\x1b\[(?:1)?G(?:\x1b\[[0-2]?[JK])?/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

/**
 * Splits a byte stream into clean lines. A carriage return or a "go to
 * column 1" sequence redraws the line, so only the last frame is kept.
 */
export class LineSplitter {
  private buffer = ""
  private readonly decoder = new TextDecoder()

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const parts = this.buffer.split("\n")
    this.buffer = parts.pop() ?? ""
    for (const part of parts) this.emit(part)
  }

  flush(): void {
    this.buffer += this.decoder.decode()
    if (this.buffer) this.emit(this.buffer)
    this.buffer = ""
  }

  private emit(raw: string): void {
    this.onLine(cleanLine(raw))
  }
}

export function cleanLine(raw: string): string {
  const frames = raw.replace(LINE_RESET, "\r").split("\r")
  const last =
    [...frames].reverse().find((f) => stripAnsi(f).trim() !== "") ?? ""
  return stripAnsi(last).trimEnd()
}
