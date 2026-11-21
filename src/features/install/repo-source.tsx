import { useState, type FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import type { RepoSkill } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, errorMessage } from "@/lib/api"
import type { Pick } from "./types"

interface RepoSourceProps {
  pick: Pick | null
  onPick: (pick: Pick | null) => void
}

export function RepoSource({ pick, onPick }: RepoSourceProps) {
  const [source, setSource] = useState(pick?.source ?? "")
  const [listed, setListed] = useState<{ source: string; skills: RepoSkill[] } | null>(null)
  const list = useMutation({
    mutationFn: api.repoSkills,
    onSuccess: (skills, value) => {
      setListed({ source: value, skills })
      // One skill, or a source that names a skill: select everything.
      onPick(skills.length === 1 || value.includes("@") ? { source: value, skills: skills.map((s) => s.name) } : { source: value, skills: [] })
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = source.trim()
    if (value) list.mutate(value)
  }

  const chosen = new Set(listed && pick?.source === listed.source ? pick.skills : [])
  const toggle = (name: string, on: boolean) => {
    if (!listed) return
    const next = new Set(chosen)
    if (on) next.add(name)
    else next.delete(name)
    onPick({ source: listed.source, skills: listed.skills.map((s) => s.name).filter((n) => next.has(n)) })
  }
  const allOn = !!listed && listed.skills.length > 0 && chosen.size === listed.skills.length

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <form onSubmit={submit} className="flex shrink-0 gap-2">
        <Input
          autoFocus
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="owner/repo or https://github.com/owner/repo"
          aria-label="Repository"
          className="font-mono"
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" variant="secondary" disabled={!source.trim() || list.isPending}>
          {list.isPending && <Spinner />}
          List skills
        </Button>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border">
        {list.isPending ? (
          <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> Reading the repository…
          </p>
        ) : list.isError ? (
          <p className="p-4 text-xs text-destructive">{errorMessage(list.error)}</p>
        ) : !listed ? (
          <p className="p-4 text-xs text-muted-foreground">
            Paste a GitHub repository to list the skills in it.
          </p>
        ) : listed.skills.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">No skills found in {listed.source}.</p>
        ) : (
          <div className="flex flex-col p-1.5">
            <label className="flex h-9 items-center gap-3 rounded-xl px-3 text-xs text-muted-foreground hover:bg-muted/60">
              <Checkbox
                checked={allOn}
                indeterminate={chosen.size > 0 && !allOn}
                onCheckedChange={(on) =>
                  onPick({ source: listed.source, skills: on ? listed.skills.map((s) => s.name) : [] })
                }
              />
              Select all ({listed.skills.length})
            </label>
            {listed.skills.map((skill) => (
              <label
                key={skill.name}
                className="flex cursor-default items-start gap-3 rounded-xl px-3 py-2 hover:bg-muted/60"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={chosen.has(skill.name)}
                  onCheckedChange={(on) => toggle(skill.name, on)}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{skill.name}</span>
                  {skill.description && (
                    <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
