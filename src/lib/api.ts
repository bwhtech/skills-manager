import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  MUTATION_HEADER,
  type AgentsResponse,
  type ApiError,
  type FileContent,
  type InstallRequest,
  type InstructionFile,
  type Job,
  type JobRef,
  type RepoSkill,
  type SaveInstructionRequest,
  type SaveRequest,
  type SaveResponse,
  type ScopeKey,
  type ScopesResponse,
  type SearchResult,
  type SkillDetail,
  type SkillSummary,
  type UpdatePreview,
  type UpdateRunRequest,
  type UpdateStatus,
} from "@shared/api"

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

export const api = {
  scopes: () => request<ScopesResponse>("GET", "/api/scopes"),
  rescan: () => request<ScopesResponse>("POST", "/api/projects/rescan"),
  pin: (path: string) => request<ScopesResponse>("POST", "/api/projects/pin", { path }),
  unpin: (path: string) => request<ScopesResponse>("DELETE", "/api/projects/pin", { path }),

  agents: () => request<AgentsResponse>("GET", "/api/agents"),

  skills: (scope: ScopeKey) => request<SkillSummary[]>("GET", `/api/skills?${q({ scope })}`),
  skill: (id: string) => request<SkillDetail>("GET", `/api/skills/${id}`),
  skillFile: (id: string, path: string) =>
    request<FileContent>("GET", `/api/skills/${id}/file?${q({ path })}`),
  saveSkillMd: (id: string, body: SaveRequest) =>
    request<SaveResponse>("PUT", `/api/skills/${id}/skill-md`, body),
  removeSkill: (id: string) => request<JobRef>("DELETE", `/api/skills/${id}`),

  instructions: (scope: ScopeKey) =>
    request<InstructionFile[]>("GET", `/api/instructions?${q({ scope })}`),
  instruction: (id: string) => request<FileContent>("GET", `/api/instructions/${id}`),
  saveInstruction: (id: string, body: SaveInstructionRequest) =>
    request<SaveResponse>("PUT", `/api/instructions/${id}`, body),

  updates: () => request<UpdateStatus>("GET", "/api/updates"),
  checkUpdates: () => request<UpdateStatus>("POST", "/api/updates/check"),
  runUpdate: (body: UpdateRunRequest) => request<JobRef>("POST", "/api/updates/run", body),
  updatePreview: (id: string) => request<UpdatePreview>("GET", `/api/skills/${id}/update-preview`),

  search: (text: string) => request<SearchResult[]>("GET", `/api/search?${q({ q: text })}`),
  repoSkills: (source: string) => request<RepoSkill[]>("POST", "/api/repo/skills", { source }),
  install: (body: InstallRequest) => request<JobRef>("POST", "/api/install", body),

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
  updates: ["updates"] as const,
  updatePreviews: ["update-preview"] as const,
  updatePreview: (id: string) => ["update-preview", id] as const,
  search: (text: string) => ["search", text] as const,
  jobs: ["jobs"] as const,
}

// ---------- Queries ----------

export function useScopes() {
  return useQuery({ queryKey: keys.scopes, queryFn: api.scopes })
}

export function useAgents() {
  return useQuery({ queryKey: keys.agents, queryFn: api.agents, staleTime: Infinity })
}

export function useSkills(scope: ScopeKey) {
  return useQuery({ queryKey: keys.skills(scope), queryFn: () => api.skills(scope) })
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

export function useUpdates() {
  return useQuery({
    queryKey: keys.updates,
    queryFn: api.updates,
    refetchInterval: (query) => (query.state.data?.checking ? 1500 : false),
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

export function useUpdatePreview(id: string | null, enabled = true) {
  return useQuery(updatePreviewQuery(id, enabled))
}

/** HTTP status of a failed preview, and whether it rules the update out. */
export function previewFailure(error: unknown) {
  const status = error instanceof HttpError ? error.status : 0
  const message =
    error instanceof HttpError ? (error.body.detail ?? error.body.error) : errorMessage(error)
  // 400: skills update would skip the skill. 409: the update would fail upstream.
  const blocking = status === 400 || status === 409
  return { status, message, blocking }
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

export function useJobs() {
  return useQuery({
    queryKey: keys.jobs,
    queryFn: api.jobs,
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === "running") ? 3000 : false,
  })
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

/** Refresh everything a finished job can change. */
export function invalidateAfterJob(client: ReturnType<typeof useQueryClient>) {
  for (const key of [["skills"], ["skill"], keys.updates, keys.scopes, keys.jobs]) {
    void client.invalidateQueries({ queryKey: key })
  }
}

/**
 * Drop update previews whose skill folder changed (an update ran, SKILL.md was saved).
 * Reset, not invalidate: a stale diff must not show while the fresh one loads.
 * No ids = every preview.
 */
export function resetUpdatePreviews(client: ReturnType<typeof useQueryClient>, ids?: string[]) {
  if (!ids) {
    void client.resetQueries({ queryKey: keys.updatePreviews })
    return
  }
  for (const id of ids) void client.resetQueries({ queryKey: keys.updatePreview(id) })
}
