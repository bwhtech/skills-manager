import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Download04Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { AgentsResponse, ScopeKey } from "@shared/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, errorMessage, useAgents, useJobMutation, useScopes } from "@/lib/api"
import { plural } from "@/lib/format"
import { usePlace } from "@/lib/hash-state"
import { ui, useUi } from "@/lib/ui-store"
import { showJob } from "@/features/jobs/job-store"
import { InstallTarget } from "./install-target"
import { RepoSource } from "./repo-source"
import { SearchSource } from "./search-source"
import type { Pick } from "./types"

export function InstallDialog() {
  const { installOpen } = useUi()
  return (
    <Dialog open={installOpen} onOpenChange={ui.setInstallOpen}>
      <DialogContent className="flex h-[min(640px,calc(100svh-2rem))] flex-col gap-5 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Install skills</DialogTitle>
          <DialogDescription>Find skills on skills.sh or in a GitHub repository.</DialogDescription>
        </DialogHeader>
        <InstallForm />
      </DialogContent>
    </Dialog>
  )
}

function defaultAgents(data: AgentsResponse | undefined) {
  if (!data) return []
  const known = new Set(data.agents.map((agent) => agent.id))
  const last = data.lastSelected.filter((id) => known.has(id))
  if (last.length) return last
  return known.has("claude-code") ? ["claude-code"] : []
}

// Mounted only while the dialog is open, so each open starts fresh.
function InstallForm() {
  const place = usePlace()
  const projects = useScopes().data?.projects ?? []
  const agents = useAgents()
  const [tab, setTab] = useState<"search" | "repo">("search")
  const [searchPick, setSearchPick] = useState<Pick | null>(null)
  const [repoPick, setRepoPick] = useState<Pick | null>(null)
  const [scope, setScope] = useState<ScopeKey>(place.scope)
  const [chosenAgents, setChosenAgents] = useState<string[] | null>(null)
  const install = useJobMutation(api.install)

  const pick = tab === "search" ? searchPick : repoPick
  const selectedAgents = chosenAgents ?? defaultAgents(agents.data)
  const ready = !!pick && pick.skills.length > 0 && selectedAgents.length > 0

  const submit = () => {
    if (!pick || !ready) return
    install.mutate(
      { source: pick.source, skills: pick.skills, agents: selectedAgents, scope },
      {
        onSuccess: ({ jobId }) => {
          ui.setInstallOpen(false)
          showJob(jobId)
        },
        onError: (error) => toast.error("Could not start the install", { description: errorMessage(error) }),
      }
    )
  }

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-5">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "search" | "repo")}
          className="min-h-0"
        >
          <TabsList className="w-full shrink-0">
            <TabsTrigger value="search">Search skills.sh</TabsTrigger>
            <TabsTrigger value="repo">From repository</TabsTrigger>
          </TabsList>
          <TabsContent value="search" keepMounted className="flex min-h-0 flex-col [&[hidden]]:hidden">
            <SearchSource pick={searchPick} onPick={setSearchPick} />
          </TabsContent>
          <TabsContent value="repo" keepMounted className="flex min-h-0 flex-col [&[hidden]]:hidden">
            <RepoSource pick={repoPick} onPick={setRepoPick} />
          </TabsContent>
        </Tabs>
        {agents.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-9" />
            <Skeleton className="min-h-0 flex-1" />
          </div>
        ) : agents.isError ? (
          <p className="text-xs text-destructive">Could not load agents: {errorMessage(agents.error)}</p>
        ) : (
          <InstallTarget
            scope={scope}
            onScopeChange={setScope}
            projects={projects}
            agents={agents.data.agents}
            lastSelected={agents.data.lastSelected}
            selectedAgents={selectedAgents}
            onAgentsChange={setChosenAgents}
          />
        )}
      </div>
      <DialogFooter className="items-center">
        <p className="mr-auto min-w-0 truncate text-xs text-muted-foreground">
          {pick && pick.skills.length > 0
            ? `${plural(pick.skills.length, "skill")} from ${pick.source} → ${plural(selectedAgents.length, "agent")}`
            : "Pick at least one skill."}
        </p>
        <Button variant="outline" onClick={() => ui.setInstallOpen(false)}>
          Cancel
        </Button>
        <Button disabled={!ready || install.isPending} onClick={submit}>
          {install.isPending ? <Spinner /> : <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />}
          Install
        </Button>
      </DialogFooter>
    </>
  )
}
