import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  type QueryClient,
  useQueryClient,
} from "@tanstack/react-query"
import {
  MUTATION_HEADER,
  type AgentsResponse,
  type ApiError,
  type FileContent,
  type InstallRequest,
  type InstructionFile,
  type LinkInstructionRequest,
  type LinkInstructionResponse,
  type OpenResult,
  type Job,
  type JobRef,
  type RecoveryRequest,
  type RecoveryResult,
  type RecoveryStatus,
  type RemovalPlan,
  type RemoveSkillRequest,
  type RepoSkill,
  type SaveInstructionRequest,
  type SaveRequest,
  type SaveResponse,
  type ScopeKey,
  type ScopesResponse,
  type SearchResult,
  type SkillDetail,
  type SkillSummary,
  type SyncPreview,
  type UnlinkInstructionRequest,
  type UnlinkInstructionResponse,
  type UpdatePreview,
  type UpdateRunRequest,
  type UpdateStatus,
  type UpdateTarget,
  updateTargetsOverlap,
} from "@shared/api"
import { requestGeneration } from "./drafts"

/** A non-2xx response, with the parsed ApiError body. */
export class HttpError extends Error {
  readonly status: number
  readonly body: ApiError & Record<string, unknown>

  constructor(status: number, body: ApiError & Record<string, unknown>) {
    super(body.detail ? `${body.error}: ${body.detail}` : body.error)
    this.name = "HttpError"
    this.status = status
    this.body = body
  }
}

export function isConflict(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 409
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

type Method = "GET" | "POST" | "PUT" | "DELETE"

async function request<T>(method: Method, path: string, body?: unknown) {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (method !== "GET") headers[MUTATION_HEADER] = "1"
  if (body !== undefined) headers["Content-Type"] = "application/json"

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!response.ok) throw new HttpError(response.status, await readError(response))
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function readError(response: Response) {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as ApiError & Record<string, unknown>
    if (typeof parsed.error === "string") return parsed
  } catch {
    // not JSON: fall through
  }
  if (response.status >= 502 && response.status <= 504 && !text.trim()) {
    return { error: "The API server is not reachable", detail: `HTTP ${response.status}` }
  }
  return { error: `HTTP ${response.status}`, detail: text.slice(0, 300) || undefined }
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

/** A file an editor can save, stamped with the request generation of its fetch (lib/drafts.ts). */
export type LoadedFile = FileContent & { generation: number }

function loaded(file: FileContent, generation: number): LoadedFile {
  return { ...file, generation }
}

export const api = {
  scopes: () => request<ScopesResponse>("GET", "/api/scopes"),
  rescan: () => request<ScopesResponse>("POST", "/api/projects/rescan"),
  pin: (path: string) => request<ScopesResponse>("POST", "/api/projects/pin", { path }),
  unpin: (path: string) => request<ScopesResponse>("DELETE", "/api/projects/pin", { path }),

  agents: () => request<AgentsResponse>("GET", "/api/agents"),

  skills: (scope: ScopeKey) => request<SkillSummary[]>("GET", `/api/skills?${q({ scope })}`),
  skill: async (id: string) => {
    const generation = requestGeneration()
    const detail = await request<SkillDetail>("GET", `/api/skills/${id}`)
    return { ...detail, skillMd: loaded(detail.skillMd, generation) }
  },
  skillFile: (id: string, path: string) =>
    request<FileContent>("GET", `/api/skills/${id}/file?${q({ path })}`),
  saveSkillMd: (id: string, body: SaveRequest) =>
    request<SaveResponse>("PUT", `/api/skills/${id}/skill-md`, body),
  removeSkill: ({ id, body }: { id: string; body?: RemoveSkillRequest }) =>
    request<JobRef>("DELETE", `/api/skills/${id}`, body),
  removalPlan: (id: string) => request<RemovalPlan>("GET", `/api/skills/${id}/removal-plan`),

  instructions: (scope: ScopeKey) =>
    request<InstructionFile[]>("GET", `/api/instructions?${q({ scope })}`),
  instruction: async (id: string) => {
    const generation = requestGeneration()
    return loaded(await request<FileContent>("GET", `/api/instructions/${id}`), generation)
  },
  saveInstruction: (id: string, body: SaveInstructionRequest) =>
    request<SaveResponse>("PUT", `/api/instructions/${id}`, body),
  syncPreview: (id: string) => request<SyncPreview>("GET", `/api/instructions/${id}/sync-preview`),
  linkInstruction: (id: string, body: LinkInstructionRequest) =>
    request<LinkInstructionResponse>("POST", `/api/instructions/${id}/link`, body),
  unlinkInstruction: (id: string, body: UnlinkInstructionRequest) =>
    request<UnlinkInstructionResponse>("POST", `/api/instructions/${id}/unlink`, body),

  updates: () => request<UpdateStatus>("GET", "/api/updates"),
  checkUpdates: () => request<UpdateStatus>("POST", "/api/updates/check"),
  runUpdate: (body: UpdateRunRequest) => request<JobRef>("POST", "/api/updates/run", body),
  updatePreview: (id: string) => request<UpdatePreview>("GET", `/api/skills/${id}/update-preview`),

  search: (text: string) => request<SearchResult[]>("GET", `/api/search?${q({ q: text })}`),
  repoSkills: (source: string) => request<RepoSkill[]>("POST", "/api/repo/skills", { source }),
  install: (body: InstallRequest) => request<JobRef>("POST", "/api/install", body),

  recovery: () => request<RecoveryStatus>("GET", "/api/recovery"),
  restoreCopies: (body: RecoveryRequest) => request<RecoveryResult>("POST", "/api/recovery/restore", body),
  deleteCopies: (body: RecoveryRequest) => request<RecoveryResult>("POST", "/api/recovery/delete", body),

  open: (path: string, from: string) => request<OpenResult>("GET", `/api/open?${q({ path, from })}`),
  file: (path: string) => request<FileContent>("GET", `/api/file?${q({ path })}`),

  jobs: () => request<Job[]>("GET", "/api/jobs"),
  job: (id: string) => request<Job>("GET", `/api/jobs/${id}`),
  jobEventsUrl: (id: string) => `/api/jobs/${id}/events`,
}

export const keys = {
  scopes: ["scopes"] as const,
  agents: ["agents"] as const,
  skills: (scope: ScopeKey) => ["skills", scope] as const,
  skill: (id: string) => ["skill", id] as const,
  skillFile: (id: string, path: string) => ["skill", id, "file", path] as const,
  instructions: (scope: ScopeKey) => ["instructions", scope] as const,
  instruction: (id: string) => ["instruction", id] as const,
  syncPreview: (id: string) => ["instruction", id, "sync-preview"] as const,
  updates: ["updates"] as const,
  updatePreviews: ["update-preview"] as const,
  updatePreview: (id: string) => ["update-preview", id] as const,
  search: (text: string) => ["search", text] as const,
  file: (path: string) => ["file", path] as const,
  jobs: ["jobs"] as const,
  recovery: ["recovery"] as const,
}

// ---------- Queries ----------

export function useScopes() {
  return useQuery({ queryKey: keys.scopes, queryFn: api.scopes })
}

export function useAgents() {
  return useQuery({ queryKey: keys.agents, queryFn: api.agents, staleTime: Infinity })
}

// Skill lists and the update status refetch whenever a screen mounts (Back,
// a layout switch): the update flags change when jobs and checks end.
export function useSkills(scope: ScopeKey) {
  return useQuery({ queryKey: keys.skills(scope), queryFn: () => api.skills(scope), refetchOnMount: "always" })
}

export function useSkill(id: string | null) {
  return useQuery({
    queryKey: keys.skill(id ?? ""),
    queryFn: () => api.skill(id!),
    enabled: !!id,
    retry: (count, error) => !(error instanceof HttpError && error.status === 404) && count < 2,
  })
}

export function useSkillFile(id: string, path: string | null) {
  return useQuery({
    queryKey: keys.skillFile(id, path ?? ""),
    queryFn: () => api.skillFile(id, path!),
    enabled: !!path,
  })
}

export function useInstructions(scope: ScopeKey) {
  return useQuery({ queryKey: keys.instructions(scope), queryFn: () => api.instructions(scope) })
}

export function useInstruction(id: string | null, exists: boolean) {
  return useQuery({
    queryKey: keys.instruction(id ?? ""),
    queryFn: () => api.instruction(id!),
    enabled: !!id && exists,
  })
}

/** A plain file a document links to (read-only viewer). */
export function useFile(path: string | null) {
  return useQuery({
    queryKey: keys.file(path ?? ""),
    queryFn: () => api.file(path!),
    enabled: !!path,
    staleTime: 0,
    retry: false,
  })
}

export function useSyncPreview(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.syncPreview(id),
    queryFn: () => api.syncPreview(id),
    enabled,
    // The dialog compares hashes: always start from the disk as it is now.
    staleTime: 0,
    refetchOnMount: "always",
  })
}

/** After a link or unlink: every scope's list and every open file may have changed. */
export async function invalidateInstructions(client: QueryClient) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["instructions"] }),
    client.invalidateQueries({ queryKey: ["instruction"] }),
    client.invalidateQueries({ queryKey: keys.scopes }),
  ])
}

export function useUpdates() {
  return useQuery({
    queryKey: keys.updates,
    queryFn: api.updates,
    refetchOnMount: "always",
    refetchInterval: (query) => (query.state.data?.checking ? 3000 : false),
  })
}

/**
 * When a background check ends, refetch the skills: their updateAvailable and
 * deletedUpstream flags come from that check. A check ends when UpdateStatus.checking
 * goes from true to false, or when checkedAt changes: a fast check can start and end
 * between two status fetches, so the client never sees checking: true.
 * Call once for the app's query client.
 */
export function refreshSkillsAfterChecks(client: QueryClient) {
  let checking = false
  let checkedAt: string | null | undefined
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey[0] !== keys.updates[0]) return
    const data = event.query.state.data as UpdateStatus | undefined
    if (!data) return
    const finished = checking && !data.checking
    const newRound = checkedAt !== undefined && data.checkedAt !== checkedAt
    if (finished || newRound) {
      void client.invalidateQueries({ queryKey: ["skills"] })
      void client.invalidateQueries({ queryKey: ["skill"] })
    }
    checking = data.checking
    checkedAt = data.checkedAt
  })
}

/**
 * A preview that finds the skill deleted upstream (409 not_upstream) also adds it to
 * UpdateStatus.deletedUpstream on the server: refetch the status and the skills, so the
 * badge and counts show it. Call once for the app's query client.
 */
export function refreshAfterDeletedPreviews(client: QueryClient) {
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "error") return
    if (event.query.queryKey[0] !== keys.updatePreviews[0]) return
    if (!previewFailure(event.action.error).deletedUpstream) return
    void client.invalidateQueries({ queryKey: keys.updates })
    void client.invalidateQueries({ queryKey: ["skills"] })
    void client.invalidateQueries({ queryKey: ["skill"] })
  })
}

// Each preview fetches the skill's source from upstream (1-2 s the first time),
// so at most this many run at once, e.g. when Update all loads every summary.
const PREVIEW_CONCURRENCY = 3
let previewsInFlight = 0
const previewQueue: (() => void)[] = []

async function limitedPreview(id: string) {
  // A finished fetch hands its slot straight to the next waiter.
  if (previewsInFlight >= PREVIEW_CONCURRENCY) {
    await new Promise<void>((resolve) => previewQueue.push(resolve))
  } else {
    previewsInFlight++
  }
  try {
    return await api.updatePreview(id)
  } finally {
    const next = previewQueue.shift()
    if (next) next()
    else previewsInFlight--
  }
}

/** What `skills update` would change in a skill folder. Not retried: the dialogs offer Retry. */
export function updatePreviewQuery(id: string | null, enabled = true) {
  return queryOptions({
    queryKey: keys.updatePreview(id ?? ""),
    queryFn: () => limitedPreview(id!),
    enabled: !!id && enabled,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: false,
  })
}

/** What Remove would delete for an npx skill, from the disk now. Always fresh. */
export function useRemovalPlan(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ["removal-plan", id ?? ""],
    queryFn: () => api.removalPlan(id!),
    enabled: !!id && enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

export function useUpdatePreview(id: string | null, enabled = true) {
  return useQuery(updatePreviewQuery(id, enabled))
}

/**
 * HTTP status of a failed preview, and whether it rules the update out.
 * 400: skills update would skip the skill. 409: the update would fail upstream
 * (also "unsafe_upstream"). 413: only the preview is too large; the update can run.
 */
export function previewFailure(error: unknown) {
  const status = error instanceof HttpError ? error.status : 0
  const code = error instanceof HttpError ? error.body.error : null
  const message =
    error instanceof HttpError ? (error.body.detail ?? error.body.error) : errorMessage(error)
  const blocking = status === 400 || status === 409
  const tooLarge = status === 413
  /** 409 not_upstream: the skill is gone from its source; the dialog offers to remove it */
  const deletedUpstream = status === 409 && code === "not_upstream"
  return { status, code, message, blocking, tooLarge, deletedUpstream }
}

export function useSearch(text: string) {
  return useQuery({
    queryKey: keys.search(text),
    queryFn: () => api.search(text),
    enabled: text.length >= 2,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
}

/** The job list. Only useJobs polls; derived hooks read the same cache entry. */
function jobsQuery<T = Job[]>(select?: (jobs: Job[]) => T) {
  return queryOptions({ queryKey: keys.jobs, queryFn: api.jobs, select })
}

export function useJobs() {
  return useQuery({
    ...jobsQuery(),
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === "running") ? 3000 : false,
  })
}

/** What the queued and running update jobs update (status "running" covers queued). */
function runningUpdates(jobs: Job[]): UpdateTarget[] {
  return jobs.filter((job) => job.status === "running" && job.update).map((job) => job.update!)
}

/**
 * Whether a queued or running update job covers a skill, by scope and name.
 * The server refuses a second overlapping update (409 update_in_progress);
 * the UI disables it first.
 */
export function isBeingUpdated(running: UpdateTarget[], scope: ScopeKey, name: string) {
  return running.some((target) => updateTargetsOverlap(target, { scope, names: [name] }))
}

/** The targets of queued and running update jobs. Same array until it changes. */
export function useRunningUpdates(): UpdateTarget[] {
  return useQuery(jobsQuery(runningUpdates)).data ?? NO_TARGETS
}

const NO_TARGETS: UpdateTarget[] = []

export function useIsBeingUpdated(scope: ScopeKey, name: string) {
  return useQuery(jobsQuery((jobs) => isBeingUpdated(runningUpdates(jobs), scope, name))).data ?? false
}

/** Removals a crash or a failed delete left in trash dirs (the recovery banner). */
export function useRecovery() {
  return useQuery({ queryKey: keys.recovery, queryFn: api.recovery, refetchOnMount: "always" })
}

// ---------- Mutations ----------

export function useScopesMutation<TArg>(fn: (arg: TArg) => Promise<ScopesResponse>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => client.setQueryData(keys.scopes, data),
  })
}

export function useCheckUpdates() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.checkUpdates,
    onSuccess: (data) => client.setQueryData(keys.updates, data),
  })
}

/** Mutations that start a CLI job. The caller opens the jobs drawer. */
export function useJobMutation<TArg>(fn: (arg: TArg) => Promise<JobRef>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.jobs }),
  })
}

/** Refresh everything a finished job can change. Active queries refetch now, the rest on mount. */
export function invalidateAfterJob(client: QueryClient) {
  for (const key of [["skills"], ["skill"], keys.updates, keys.scopes, keys.jobs, keys.recovery]) {
    void client.invalidateQueries({ queryKey: key })
  }
}

/**
 * Drop update previews whose skill folder changed (an update ran, SKILL.md was saved).
 * Reset, not invalidate: a stale diff must not show while the fresh one loads.
 * No ids = every preview.
 */
export function resetUpdatePreviews(client: QueryClient, ids?: string[]) {
  if (!ids) {
    void client.resetQueries({ queryKey: keys.updatePreviews })
    return
  }
  for (const id of ids) void client.resetQueries({ queryKey: keys.updatePreview(id) })
}
