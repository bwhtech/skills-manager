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
  name: string // frontmatter name, else folder name; for display only
  /**
   * npx skills: the name the skills CLI tracks (the lock key). It can differ from `name`
   * when the frontmatter name differs from the lock key or folder. Use it for update,
   * remove, preview and every match against UpdateStatus or running jobs.
   */
  cliName?: string
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
  /**
   * npx skills: the last update check (or an update job, or a preview) found the skill
   * deleted upstream. `skills update` skips it; see UpdateStatus.deletedUpstream.
   * updateAvailable is then false.
   */
  deletedUpstream?: boolean
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
// GET /api/skills/:id/removal-plan       -> RemovalPlan  (npx skills only; 400 otherwise)
//   What DELETE would do. An explicit Remove counts a copy at an agent install path as part of
//   the install only when the canonical folder exists, the copy's full inventory is identical
//   to it, and the lock's recorded hash matches (RemovalPlan.promoted): it is in willDelete.
//   Without a canonical folder a copy is never part of the install. Other copies are opt-in
//   (RemovalPlan.copies), as for deleted-upstream removal.
// DELETE /api/skills/:id  RemoveSkillRequest (optional body) -> JobRef
//   npx skills: runs `skills remove -s <cliName> -a <agents> -y` (+ -g for user scope,
//   cwd = project), after deleting the ticked copies. With a body, the same checks as
//   UpdateRunRequest.removePlans (400 / 409 removal_blocked / 409 removal_plan_changed).
//   On success the skill leaves UpdateStatus.deletedUpstream.
//   manual skills: the server deletes the folder itself (job logs what it did).
//   403 for plugin, synced, system, and for skills with removable: false.

/** DELETE /api/skills/:id body: what the Remove dialog showed and ticked (npx skills). */
export type RemoveSkillRequest = ShownRemovalPlan

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
  /** set when linkTarget is itself a known instruction file, in any scope: its id */
  linkTargetId?: string
  /** that known instruction file (linkTargetFile.id === linkTargetId) */
  linkTargetFile?: InstructionLinkRef
  /** known instruction files (any scope) that are symlinks to this file */
  linkedFrom?: InstructionLinkRef[]
  /** path is a symlink whose target does not exist (exists is false) */
  linkBroken?: boolean
}

/** Another instruction file, as a link source or target shows it. */
export interface InstructionLinkRef {
  id: string
  scope: ScopeKey
  path: string
  fileName: InstructionFileName
  agentLabel: string
}

// User level: ~/.claude/CLAUDE.md (Claude Code), ~/.codex/AGENTS.md (Codex).
// Project level: <root>/CLAUDE.md, <root>/CLAUDE.local.md, <root>/AGENTS.md.
//
// GET /api/instructions?scope=<ScopeKey>  -> InstructionFile[]  (scope required)
// GET /api/instructions/:id               -> FileContent (404 if missing)
// PUT /api/instructions/:id  SaveRequest & {create?: boolean} -> SaveResponse
//   create: true makes a missing file (and its parent dir). 409 if it already exists.
//   409 now_linked {linkTarget, linkTargetId?} if the path is a symlink, unless
//   expectTarget equals its target now: then the save writes to the target.

export interface SaveInstructionRequest extends SaveRequest {
  create?: boolean
  /**
   * Only for a save addressed to a symlink: the absolute link target the
   * client meant to write (InstructionFile.linkTarget). Without it, or when
   * it no longer matches, the save is refused with 409 now_linked. The UI
   * always edits the real file's id and never sends it.
   */
  expectTarget?: string
}

// Sync via symlink. A "link" makes the file at :id a symlink to another known
// instruction file (the target), so both agents read one file.
//
// GET /api/instructions/:id/sync-preview  -> SyncPreview
//   :id is the target. Lists the files that could become links to it: the
//   target's scope, plus user scope when the target is in a project.
//   400 if the target is missing or is itself a symlink.
// POST /api/instructions/:id/link  LinkInstructionRequest -> LinkInstructionResponse
//   Turns the file at :id (the source) into a symlink to targetId.
//   Both must be known instruction files; the target a regular file, the source
//   a regular file or missing. 400 self_link, cycle, target_is_link (point at
//   the real file instead), target_missing, target_not_file, source_not_file.
//   409 already_linked if the source is a symlink, hard_linked if it has more
//   than one hard link. Both paths are locked (sorted) and probed again.
//   The live source is renamed away and given the name <path>.bak (or
//   <path>.bak-<time>; a backup is never overwritten), so the backup holds the
//   bytes on disk at that moment. 409 conflict if they do not hash to baseHash
//   (the file is put back). Then the symlink is made at the free name; 409
//   exists (with backupPath) if a file appeared there. 409 target_changed if the
//   target changed during the sync (undone). A missing source becomes a link,
//   no backup. The link text is relative when both files are under HOME.
// POST /api/instructions/:id/unlink  UnlinkInstructionRequest -> UnlinkInstructionResponse
//   Replaces the symlink at :id with a regular file: a copy of the target's
//   content now ("copy"), or an empty file ("empty"). Never touches the target.
//   400 not_a_link. 409 link_broken for "copy" when the target does not exist.

export interface LinkInstructionRequest {
  targetId: string
  /** FileContent.hash of the source; required when the source is a regular file */
  baseHash?: string
  /** the server always backs up a regular source; the client confirms it saw that */
  backup: true
}

export interface LinkInstructionResponse {
  file: InstructionFile
  /** absolute path of the backup, or null when the source did not exist */
  backupPath: string | null
}

export interface UnlinkInstructionRequest {
  mode: "copy" | "empty"
}

export interface UnlinkInstructionResponse {
  file: InstructionFile
}

export interface SyncCandidate {
  file: InstructionFile
  /** why it cannot become a link to the target; omitted when it can */
  blocked?: string
  /** the source's content now (regular files only): the diff's old side */
  content?: string
  /** send as LinkInstructionRequest.baseHash */
  hash?: string
  /** same bytes as the target */
  identical: boolean
  /** lines from the source's content to the target's */
  linesAdded: number
  linesRemoved: number
  /** where the link would back the source up; null for a missing source */
  backupPath: string | null
}

export interface SyncPreview {
  target: InstructionFile
  targetContent: string
  targetHash: string
  candidates: SyncCandidate[]
}

// ---------- Updates ----------

/** A locked skill that the skills CLI reports for one upstream source. */
export interface UpstreamSkillRef {
  scope: ScopeKey
  /** the CLI name (lock key) */
  name: string
  /** as the CLI prints it: owner/repo (user scope) or the lock's sourceUrl (project scope) */
  source: string
}

export interface UpdateStatus {
  checking: boolean
  checkedAt: string | null // ISO
  /** skill names with an update, per scope; never a deletedUpstream skill */
  available: { scope: ScopeKey; name: string }[]
  /**
   * Skills that are gone from their source ("appear to have been deleted upstream", or
   * "is no longer in this download"). `skills update` skips them and, run non-interactively,
   * never deletes them; UpdateRunRequest.remove does. From the last check, plus what update
   * jobs and previews found since.
   */
  deletedUpstream?: UpstreamSkillRef[]
  /**
   * "Multiple current paths match": several upstream skills match the name, so the CLI skips
   * them. Show as a warning only; never offer to delete them.
   */
  ambiguousUpstream?: UpstreamSkillRef[]
  /**
   * Scopes whose last check did not finish cleanly (timed out, failed sources, odd exit).
   * Only a scope that is checked and not listed here is "up to date".
   */
  scopeErrors?: { scope: ScopeKey; error: string }[]
  /** summary of failed checks, e.g. "user scope: 2 sources could not be checked" */
  error: string | null
  /**
   * what could not be checked, per scope. `name` is what the CLI names:
   * a skill source (owner/repo, URL) or a skill name.
   */
  failed?: { scope: ScopeKey; name: string; reason: string }[]
  /**
   * GET /api/updates and POST /api/updates/check only: one entry per deletedUpstream skill,
   * computed from the disk and the lock file at request time. It says exactly what
   * `skills remove` would delete for that name. A dialog shows `willDelete` and `kept`, and
   * offers a name only when `blocked` is missing. Absent: no plan yet, do not offer the name.
   */
  removalPlans?: RemovalPlan[]
}

/** What removing one deleted-upstream skill would do on disk. */
export interface RemovalPlan {
  scope: ScopeKey
  /** the CLI name (lock key), as in deletedUpstream */
  name: string
  /**
   * Absolute paths that `skills remove` deletes: the canonical folder (.agents/skills/<name>)
   * and agent placements that are links to it. Empty when `blocked` is set, or when only the
   * lock entry is left to remove.
   */
  willDelete: string[]
  /**
   * Same-named placements that stay and are never offered for deletion, and why: links to
   * other folders, anything outside a verified agent skills dir, plugin, synced and system
   * dirs, non-dot project dirs, folders without a SKILL.md.
   */
  kept: { path: string; reason: string }[]
  /**
   * Independent copies (real folders, not links to the canonical folder) in a verified agent
   * skills dir that block the removal or that `skills remove` would leave behind. Each one is
   * opt-in: it is deleted only when the request lists it in removePlans[].copies.
   */
  copies?: RemovalCopy[]
  /**
   * Set when the name cannot be removed here: the reason. The UI must not offer the name,
   * unless blockedUnlessCopies is set.
   */
  blocked?: string
  /**
   * The name is blocked only by copies with `blocking: true`. It becomes removable when the
   * request ticks all of them; willDelete then says what `skills remove` deletes.
   */
  blockedUnlessCopies?: boolean
  /**
   * Explicit Remove only: real-folder copies in willDelete that count as part of the install
   * because they have the same content as the installed version: the canonical folder exists,
   * the copy's full inventory is identical to it, and the lock's recorded hash matches by the
   * CLI's own algorithm. This shows the same content, not that the CLI made the folder. Any
   * other copy (and every copy when there is no canonical folder) is in `copies`.
   */
  promoted?: { path: string; reason: string }[]
}

/** One independent same-named copy of a skill, in an agent skills dir. */
export interface RemovalCopy {
  /** absolute path of the copy folder */
  path: string
  /** the label(s) of the agent(s) whose skills dir holds it, e.g. "Claude Code" */
  agent: string
  /**
   * Same deletion inventory as the canonical folder: every entry walked without following
   * links, with the same kind, permission bits, size, bytes and link text, and nothing a copy
   * made by the skills CLI never holds (.git, __pycache__, metadata.json, links that leave the
   * folder or lead nowhere, special files). False when anything differs, when there is no
   * canonical folder, or when the folders are too large to compare (the preview's limits).
   */
  identical: boolean
  /** entries that differ (added, removed or changed), when known */
  differences?: number
  /** files in the copy (at most the deletion cap, see tooLarge) */
  files: number
  /** too many entries or bytes to compare (the deletion cap, see tooLargeToRemove): not identical */
  tooLarge?: boolean
  /**
   * The copy itself is over the deletion cap (20,000 entries or 500 MB), so it cannot be
   * fingerprinted byte for byte and cannot be deleted here: ticking it is 400. Show its
   * checkbox disabled. If it blocks the skill, the plan is blocked ("still_used").
   */
  tooLargeToRemove?: boolean
  /** short reason when not identical: `reasons` joined with "; " */
  reason?: string
  /**
   * every reason when not identical, e.g. "has .git history (.git)", "has a link outside the
   * folder (docs -> /srv/docs)", "1 file changed (SKILL.md)", "no canonical folder to compare with"
   */
  reasons?: string[]
  /** the skills CLI keeps the canonical folder and the lock entry while this copy exists */
  blocking: boolean
}

/**
 * What the dialog showed for one name and what the user ticked. The server never deletes a
 * path that is not listed here.
 */
export interface ShownRemovalPlan {
  /** RemovalPlan.willDelete as shown */
  willDelete: string[]
  /** the paths of RemovalPlan.copies the user ticked: deleted before skills remove runs */
  copies?: string[]
  /**
   * every copy the dialog listed, with the identical flag it showed. When set, a copy list or
   * an identical flag that differs from the server's current plan is 409 removal_plan_changed.
   */
  shownCopies?: { path: string; identical: boolean }[]
}

// GET  /api/updates            -> UpdateStatus  (cached; the server starts a check on boot)
// POST /api/updates/check      -> UpdateStatus  (starts a background check, returns at once)
// POST /api/updates/run  UpdateRunRequest -> JobRef
//   Runs `skills update [names...] -y` with -g (user) or -p (project, cwd = project).
//   409 (error "update_in_progress", extra field jobId) when a queued or running update job
//   overlaps: same scope and a shared name, where names omitted means every skill in the scope.
//   When the job succeeds, the server drops its (scope, name) pairs from UpdateStatus.available
//   at once (names omitted: every name in the scope), so the skill list stops flagging them.
//   Whatever the outcome, it then re-runs the check in the background.
//   remove: deleted-upstream skills to remove after the update, in the same job: a second step
//   `skills remove -s <names> -a <agents> -y` (+ -g for user, cwd = project), one call per set of
//   agents. `-a` lists only the agents whose placement is the canonical folder or a link to it,
//   so independent same-named copies stay (RemovalPlan.kept).
//   Names and update names: an exact lock key of the scope, or a plain name (letters, digits,
//   _ . : + @ -); never a leading "-" or a control character (400).
//   400 unless every remove name is in UpdateStatus.deletedUpstream for that scope, its lock
//   entry is still the one it was found deleted for, and removePlans lists it.
//   Copies: removePlans[].copies may list only paths of that name's current RemovalPlan.copies
//   (400 otherwise). 409 "removal_blocked" while a copy with blocking: true is not ticked.
//   409 "removal_plan_changed" when shownCopies differs from the current copies (a copy came,
//   went, or its identical flag changed). In the job, after the fresh upstream recheck, each
//   ticked copy is deleted first (moved to a trash dir inside its verified skills dir, checked
//   by device and inode, then deleted); if one fails, nothing else runs. Then `skills remove`
//   runs. Each group of names is planned again right before its call and skipped when its lock
//   entry or the paths the CLI would touch changed. Afterwards: ticked copies gone, unticked
//   copies and kept paths still there, no other path the CLI could touch gone, and the lock file
//   readable and without the entry.
//   409 "removal_conflict" when a name collides with another lock key under the CLI's
//   sanitizeName, or would resolve to another lock key; 409 "removal_blocked" when its plan is
//   blocked; 409 "removal_plan_changed" when the server would delete a path that the
//   removePlans entry does not list (reopen the dialog).
//   Right before step 2, inside the job, each name is checked again: the lock entry must be
//   unchanged, a fresh upstream fetch (no cache) must still find it deleted, and the plan must
//   still be within removePlans. A name that fails a check is skipped and the job log says why.
//   Step 2 is skipped when step 1 printed a failure, whatever its exit code. After step 2 the
//   job checks the disk: every willDelete path gone, the lock entry gone, every kept path still
//   there. Otherwise the job fails and the name stays in deletedUpstream.
//   Names that left the disk leave deletedUpstream at once. With remove set and names omitted
//   or empty, the job only removes (no update step). Overlap (409) counts names and remove
//   together.

export interface UpdateRunRequest {
  scope: ScopeKey
  names?: string[] // omitted = all in that scope (unless remove is set: then none)
  /** CLI names from UpdateStatus.deletedUpstream (this scope) to remove after the update */
  remove?: string[]
  /**
   * Required with `remove`: for each name, the RemovalPlan.willDelete list that the dialog
   * showed, and the copies the user ticked. The server never deletes a path that is not listed.
   */
  removePlans?: ({ name: string } & ShownRemovalPlan)[]
}

// GET /api/skills/:id/update-preview -> UpdatePreview
//   Only for origin "npx" skills (400 otherwise). Compares the local skill folder (what is on
//   disk now, including any local edits) with the version `skills update` would install.
//   400 when `skills update` cannot update the skill (e.g. local or legacy lock entries),
//   409 when the update would fail (skill deleted, moved ambiguously or renamed upstream),
//   error "not_upstream" for a deleted skill: the server then also adds it to
//   UpdateStatus.deletedUpstream, so UpdateRunRequest.remove accepts it,
//   502 when the source could not be fetched, 504 when the fetch timed out.
//   413 (error "preview_too_large", detail "Preview too large: ...") when a limit is passed,
//   instead of a partial preview: more than 2,000 files in the local or the upstream skill
//   folder, more than 50 MB to read for the diff, a source over 300 MB on disk, more than
//   5,000 SKILL.md files when the skill must be found by name, or an upstream SKILL.md over 256 KB.
//   409 also when the upstream SKILL.md is unsafe to read (error "unsafe_upstream": a link
//   out of the skill folder, or not a regular file).
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
  tooLarge?: boolean // over 256 KB: compared by SHA-256; contents omitted, line counts 0
  linesAdded: number
  linesRemoved: number
}

// ---------- Recovery of interrupted removals ----------

// A job stages each ticked copy in a hidden trash dir (`.skills-manager-trash-*`) inside its
// own skills dir before `skills remove` runs, and records it first in a journal
// (~/.config/skills-manager/removals/<jobId>.json, mode 600). The journal is deleted once every
// copy is deleted or moved back. A journal left behind (a crash, a copy that could not be
// moved back or deleted) is listed here until each copy is settled.
//
// GET  /api/recovery                          -> RecoveryStatus
//   Read from the disk at request time. Journals of jobs still running are left out.
// POST /api/recovery/restore  RecoveryRequest -> RecoveryResult
//   Moves each listed copy back: mkdir of the original path (never over anything there), then
//   rename into that empty dir, then a device/inode check. A copy that cannot go back stays in
//   the trash dir, and its result says why.
// POST /api/recovery/delete   RecoveryRequest -> RecoveryResult
//   Deletes each listed copy for good, after checking that its trash dir is still in its
//   verified skills dir, and that its device, inode and full content inventory match what the
//   journal recorded. A copy that does not match is kept.
// Only paths of that job's journal are acted on (400 otherwise; 404 when there is no such
// journal). 409 job_running when the job is still queued or running.
// Unknown leftovers (trash dirs no journal covers) are only listed, never touched by the
// server. Nothing is restored or deleted at startup: only these requests act.
//
// Test hook: SKILLS_MANAGER_TEST_CRASH_AFTER_STAGE=1 makes the server kill itself (SIGKILL)
// right after a removal job staged a group's ticked copies. Honored only under a fixture HOME
// (HOME is not the user's passwd home) or NODE_ENV=test.

export interface RecoveryStatus {
  interruptedRemovals: InterruptedRemoval[]
  /** `.skills-manager-trash-*` dirs in the known agent skills dirs that no journal covers */
  unknownLeftovers: { path: string }[]
}

export interface InterruptedRemoval {
  jobId: string
  /** when the job started staging (ISO) */
  at: string
  /** copies still in a trash dir */
  items: InterruptedCopy[]
}

export interface InterruptedCopy {
  /** where the copy was */
  original: string
  /** where it is now, in a trash dir */
  staged: string
  /**
   * staged: whole, as it was set aside (or about to be, when the job stopped right then).
   * purge_failed: its delete threw or was interrupted part way (a crash after "purging" was
   * recorded), so what is left is incomplete: neither restorable
   * nor deletable here; delete it by hand.
   */
  status: "staged" | "purge_failed"
  /** POST /api/recovery/restore can move it back (nothing is at `original`) */
  restorable: boolean
  /** POST /api/recovery/delete can delete it (checked again in full when asked) */
  deletable: boolean
  /** why it cannot be restored or deleted, e.g. "partially deleted, still in trash: <path>" */
  reason?: string
}

export interface RecoveryRequest {
  jobId: string
  /** InterruptedCopy.staged paths of that job */
  staged: string[]
}

export interface RecoveryResult {
  results: { staged: string; ok: boolean; message: string }[]
  /** the status after the action */
  recovery: RecoveryStatus
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
  /**
   * update jobs only: what they update (names empty = every skill in the scope). A job with
   * a remove step lists the removed names here too, so overlapping runs are refused.
   */
  update?: UpdateTarget
  /** jobs from UpdateRunRequest.remove: the deleted-upstream names their remove step removes */
  remove?: string[]
}

export interface UpdateTarget {
  scope: ScopeKey
  names: string[]
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

/**
 * Two update runs touch the same skill: same scope, and a shared name or
 * either one updates every skill in the scope (names empty). Names compare
 * without case.
 */
export function updateTargetsOverlap(a: UpdateTarget, b: UpdateTarget): boolean {
  if (a.scope !== b.scope) return false
  if (a.names.length === 0 || b.names.length === 0) return true
  const names = new Set(a.names.map((name) => name.toLowerCase()))
  return b.names.some((name) => names.has(name.toLowerCase()))
}
