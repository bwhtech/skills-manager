// Shared API contract between the Bun/Hono server (server/) and the React UI (src/).
// Both sides import from here. Change it only on purpose, and update both sides.
//
// Conventions
// - Every route is under /api. JSON in, JSON out.
// - Errors: non-2xx status with body ApiError.
// - Every mutating request (POST, PUT, DELETE) must send the header
//   `X-Skills-Manager: 1`. The server rejects mutating requests without it
//   (403) and rejects requests whose Origin header does not match the Host.
//   This blocks CSRF from other sites, because the app can run commands.
// - IDs are base64url of an absolute real path (see encodeId/decodeId).
//   The server must never trust an ID: it decodes it and checks that the path
//   is one it discovered itself.

export const MUTATION_HEADER = "X-Skills-Manager"

export interface ApiError {
  error: string
  detail?: string
}

// ---------- Scopes ----------

/** "user" for user-level, or the absolute path of a project. */
export type ScopeKey = "user" | (string & {})

export interface ProjectInfo {
  path: string // absolute path of the project root
  name: string // basename of path
  pinned: boolean
  /** true if found by the scan (it can also be pinned). */
  discovered: boolean
  skillCount: number
  instructionFileCount: number // only files that exist
}

export interface ScopesResponse {
  home: string
  projects: ProjectInfo[]
  scanRoots: string[]
  lastScanAt: string | null // ISO time
}

// GET /api/scopes                    -> ScopesResponse
// GET /api/health                    -> {ok: true}
// POST /api/projects/rescan            -> ScopesResponse
// POST /api/projects/pin   {path}      -> ScopesResponse  (400 if not a dir)
// DELETE /api/projects/pin {path}      -> ScopesResponse
export interface PinRequest {
  path: string
}

// ---------- Agents ----------

export interface AgentInfo {
  id: string // the id the skills CLI uses with --agent, e.g. "claude-code", "codex"
  label: string // e.g. "Claude Code"
  /** user-level skills dir, e.g. ~/.claude/skills */
  globalSkillsDir: string | null
  /** project-relative skills dir, e.g. .claude/skills */
  projectSkillsDir: string | null
  detected: boolean // the agent seems installed on this machine
}

// GET /api/agents -> AgentsResponse
export interface AgentsResponse {
  agents: AgentInfo[]
  /** lastSelectedAgents from ~/.agents/.skill-lock.json, used as install default */
  lastSelected: string[]
}

// ---------- Skills ----------

/**
 * npx     - tracked by the skills CLI lock file (global or project skills-lock.json)
 * manual  - a folder made by hand, not in any lock file
 * plugin  - provided by a Claude Code plugin (~/.claude/plugins/...)
 * synced  - claude.ai synced skills (~/.claude/skills/synced/...)
 * system  - an agent's built-in skills (e.g. ~/.codex/skills/.system)
 */
export type SkillOrigin = "npx" | "manual" | "plugin" | "synced" | "system"

export interface SkillSource {
  source: string // e.g. "vercel-labs/agent-skills"
  sourceUrl?: string
  sourceType?: string
  skillPath?: string
}

export interface SkillSummary {
  id: string // encodeId(realPath)
  name: string // frontmatter name, else folder name
  description: string // frontmatter description, "" if missing
  realPath: string // resolved skill folder
  /** every place this folder appears (symlinks included), absolute */
  locations: string[]
  agents: string[] // AgentInfo ids that see this skill
  /** owning scope: update and remove act here */
  scope: ScopeKey
  /** every scope the skill appears in (a project can link a user skill); includes scope */
  scopes: ScopeKey[]
  origin: SkillOrigin
  editable: boolean // false for plugin, synced, system
  /**
   * DELETE /api/skills/:id may act: true for npx skills (the CLI removes them)
   * and for manual skills in a user-level agent skills dir or a project skills
   * dir under a dot folder (.claude/skills, .agents/skills). Manual skills in
   * other project dirs (e.g. skills/, data/skills) are often the project's own
   * source folders, so they stay browsable and editable but not removable.
   */
  removable: boolean
  source?: SkillSource // origin === "npx"
  pluginName?: string // origin === "plugin"
  updateAvailable: boolean // from the last update check
}

// GET /api/skills?scope=<ScopeKey>  -> SkillSummary[]
//   scope omitted = all scopes. Sorted by name.
//   With scope: every skill whose `scopes` contains it (not only owned ones).

export interface SkillFileEntry {
  path: string // relative to realPath, posix separators
  size: number
  isText: boolean
}

export interface SkillDetail extends SkillSummary {
  files: SkillFileEntry[] // whole folder, max 500 entries, skips .git and node_modules
  skillMd: FileContent
}

export interface FileContent {
  content: string
  /** for display only; conflicts use hash */
  mtimeMs: number
  /** sha256 hex of the file bytes: the version token for SaveRequest.baseHash */
  hash: string
}

// GET /api/skills/:id                    -> SkillDetail
// GET /api/skills/:id/file?path=<rel>    -> FileContent (text files only, max 1 MB, read-only)
// PUT /api/skills/:id/skill-md  SaveRequest -> SaveResponse
//   403 if the skill is not editable. 409 SaveConflict if the file on disk no longer
//   has baseHash (compared under a per-file lock keyed by the canonical path).
// DELETE /api/skills/:id                 -> JobRef
//   npx skills: runs `skills remove -s <name> -y` (+ -g for user scope, cwd = project).
//   manual skills: the server deletes the folder itself (job logs what it did).
//   403 for plugin, synced, system, and for skills with removable: false.

export interface SaveRequest {
  content: string
  /** FileContent.hash the client loaded. Omit only together with force. */
  baseHash?: string
  /** overwrite even if the file changed on disk */
  force?: boolean
}

export interface SaveResponse {
  mtimeMs: number
  /** sha256 hex of the saved content: the next baseHash */
  hash: string
}

export interface SaveConflict extends ApiError {
  error: "conflict"
  /** hash of the file on disk now */
  currentHash: string
  currentMtimeMs: number
}

// ---------- Instruction files ----------

export type InstructionFileName = "CLAUDE.md" | "CLAUDE.local.md" | "AGENTS.md"

export interface InstructionFile {
  id: string // encodeId(path) where path is the place the file lives (not its link target)
  scope: ScopeKey
  fileName: InstructionFileName
  /** who reads it, e.g. "Claude Code", "Codex", "Claude Code (local, not committed)" */
  agentLabel: string
  path: string // absolute path where the file is or would be created
  exists: boolean
  /** set when path is a symlink: absolute resolved target */
  linkTarget?: string
}

// User level: ~/.claude/CLAUDE.md (Claude Code), ~/.codex/AGENTS.md (Codex).
// Project level: <root>/CLAUDE.md, <root>/CLAUDE.local.md, <root>/AGENTS.md.
//
// GET /api/instructions?scope=<ScopeKey>  -> InstructionFile[]  (scope required)
// GET /api/instructions/:id               -> FileContent (404 if missing)
// PUT /api/instructions/:id  SaveRequest & {create?: boolean} -> SaveResponse
//   Writes to the link target if the file is a symlink.
//   create: true makes a missing file (and its parent dir). 409 if it already exists.

export interface SaveInstructionRequest extends SaveRequest {
  create?: boolean
}

// ---------- Updates ----------

export interface UpdateStatus {
  checking: boolean
  checkedAt: string | null // ISO
  /** skill names with an update, per scope */
  available: { scope: ScopeKey; name: string }[]
  /** summary of failed checks, e.g. "user scope: 2 sources could not be checked" */
  error: string | null
  /**
   * what could not be checked, per scope. `name` is what the CLI names:
   * a skill source (owner/repo, URL) or a skill name.
   */
  failed?: { scope: ScopeKey; name: string; reason: string }[]
}

// GET  /api/updates            -> UpdateStatus  (cached; the server starts a check on boot)
// POST /api/updates/check      -> UpdateStatus  (starts a background check, returns at once)
// POST /api/updates/run  UpdateRunRequest -> JobRef
//   Runs `skills update [names...] -y` with -g (user) or -p (project, cwd = project).
//   After success the server re-runs the check.

export interface UpdateRunRequest {
  scope: ScopeKey
  names?: string[] // omitted = all in that scope
}

// GET /api/skills/:id/update-preview -> UpdatePreview
//   Only for origin "npx" skills (400 otherwise). Compares the local skill folder (what is on
//   disk now, including any local edits) with the version `skills update` would install.
//   400 when `skills update` cannot update the skill (e.g. local or legacy lock entries),
//   409 when the update would fail (skill deleted, moved ambiguously or renamed upstream),
//   502 when the source could not be fetched, 504 when the fetch timed out.
//   The upstream fetch is cached per (source, ref) for about 10 minutes.
export interface UpdatePreview {
  skillId: string
  name: string
  scope: ScopeKey
  source: string // owner/repo
  remoteRef: string | null // commit sha or tree hash fetched, if known
  upToDate: boolean // no file differences
  files: UpdateFileChange[] // sorted by path; SKILL.md first
  summary: {
    added: number
    removed: number
    modified: number
    linesAdded: number
    linesRemoved: number
  }
  fetchedAt: string
}

export interface UpdateFileChange {
  path: string // relative to the skill folder, posix
  status: "added" | "removed" | "modified"
  binary: boolean
  /** omitted for added files, binary files, and files over the size cap */
  oldContent?: string
  /** omitted for removed files, binary files, and files over the size cap */
  newContent?: string
  tooLarge?: boolean // over 256 KB; contents omitted
  linesAdded: number
  linesRemoved: number
}

// ---------- Install ----------

export interface SearchResult {
  id: string // "owner/repo@skill"
  source: string // "owner/repo"
  skill: string
  installs: number
  url: string // skills.sh page
}

// GET /api/search?q=<text>   -> SearchResult[]   (proxies the skills.sh search API)

export interface RepoSkill {
  name: string
  description: string
}

// POST /api/repo/skills  {source}  -> RepoSkill[]
//   source is "owner/repo", "owner/repo@skill" or a GitHub URL.
//   Runs `skills add <source> --list` (or reads --json if it supports it).
export interface RepoSkillsRequest {
  source: string
}

// POST /api/install  InstallRequest -> JobRef
//   Runs `skills add <source> -s <skills...> -a <agents...> -y` with -g for user scope,
//   cwd = project path for a project scope.
export interface InstallRequest {
  source: string
  skills: string[] // at least one
  agents: string[] // at least one
  scope: ScopeKey
}

// ---------- Jobs (CLI runs) ----------

export type JobStatus = "running" | "success" | "error"

export interface JobRef {
  jobId: string
}

export interface Job {
  id: string
  kind: "install" | "update" | "remove"
  title: string // e.g. "Install vercel-labs/agent-skills (2 skills)"
  command: string // the full command line, for display
  cwd: string
  status: JobStatus
  exitCode: number | null
  startedAt: string
  endedAt: string | null
  log: string[] // output lines, ANSI stripped; stdout and stderr merged
}

// GET /api/jobs              -> Job[]  (newest first, last 50, kept in memory)
// GET /api/jobs/:id          -> Job
// GET /api/jobs/:id/events   -> text/event-stream
//   event "line": data = one output line (string, JSON-encoded)
//   event "done": data = Job (JSON), then the stream closes
//   On connect the server first replays the existing log lines.

// ---------- Helpers ----------

export function encodeId(path: string): string {
  const bytes = new TextEncoder().encode(path)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function decodeId(id: string): string {
  const b64 = id.replace(/-/g, "+").replace(/_/g, "/")
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}
