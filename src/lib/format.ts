import type { ProjectInfo, ScopeKey } from "@shared/api"

export function basename(path: string) {
  const parts = path.replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] || path
}

/** Replace the home directory with ~ for display. */
export function tildify(path: string, home: string | undefined) {
  if (!home) return path
  if (path === home) return "~"
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path
}

export function scopeLabel(scope: ScopeKey, projects?: ProjectInfo[]) {
  if (scope === "user") return "User"
  return projects?.find((p) => p.path === scope)?.name ?? basename(scope)
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

export function timeAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "never"
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return "just now"
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute")
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour")
  return relative.format(Math.round(seconds / 86400), "day")
}

const compact = new Intl.NumberFormat("en", { notation: "compact" })

export function formatCount(n: number) {
  return compact.format(n)
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}
