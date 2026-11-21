import { LineSplitter } from "../lib/ansi.ts"
import { config } from "../config.ts"

export interface CaptureResult {
  exitCode: number
  output: string
  timedOut: boolean
}

/** Runs the skills CLI non-interactively, always with an argument array. */
export class SkillsCli {
  private token: string | null = null

  constructor(private readonly bin = config.skillsBin) {}

  setGithubToken(token: string | null): void {
    this.token = token
  }

  /** The command line for display. Never includes the token. */
  display(args: string[]): string {
    return ["skills", ...args].map(quoteForDisplay).join(" ")
  }

  /** Run and collect merged output. */
  async capture(
    args: string[],
    cwd: string,
    timeoutMs = config.cliTimeoutMs
  ): Promise<CaptureResult> {
    const lines: string[] = []
    const { exitCode, timedOut } = await this.stream(
      args,
      cwd,
      (l) => lines.push(l),
      timeoutMs
    )
    return { exitCode, output: lines.join("\n"), timedOut }
  }

  /** Run and report each output line (stdout and stderr merged, ANSI stripped). */
  async stream(
    args: string[],
    cwd: string,
    onLine: (line: string) => void,
    timeoutMs = config.cliTimeoutMs
  ): Promise<{ exitCode: number; timedOut: boolean }> {
    const proc = Bun.spawn([this.bin, ...args], {
      cwd,
      env: this.env(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)
    await Promise.all([pump(proc.stdout, onLine), pump(proc.stderr, onLine)])
    const exitCode = await proc.exited
    clearTimeout(timer)
    return { exitCode, timedOut }
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined) env[k] = v
    Object.assign(env, {
      DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    })
    if (this.token) env.GITHUB_TOKEN = this.token
    return env
  }
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const splitter = new LineSplitter(onLine)
  for await (const chunk of stream) splitter.push(chunk)
  splitter.flush()
}

function quoteForDisplay(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`
}

/** `gh auth token`, read once. Returns null when gh is missing or logged out. */
export function readGithubToken(): string | null {
  try {
    const out = Bun.spawnSync(["gh", "auth", "token"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const token = out.stdout.toString().trim()
    return out.exitCode === 0 && token ? token : null
  } catch {
    return null
  }
}
