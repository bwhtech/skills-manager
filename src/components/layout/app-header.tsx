import { HugeiconsIcon } from "@hugeicons/react"
import { CommandLineIcon, Download04Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { modKey } from "@/components/editor/editor-toolbar"
import { UpdateStatus } from "@/features/updates/update-status"
import { useJobs, useScopes } from "@/lib/api"
import { scopeLabel, tildify } from "@/lib/format"
import { navigate, usePlace, type MainTab } from "@/lib/hash-state"
import { ui } from "@/lib/ui-store"
import { ThemeToggle } from "./theme-toggle"

export function AppHeader() {
  const { scope, tab } = usePlace()
  const scopes = useScopes().data
  const name = scopeLabel(scope, scopes?.projects)
  const running = useJobs().data?.filter((job) => job.status === "running").length ?? 0

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-1 h-5 self-center!" />
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="max-w-64 shrink-0 truncate text-sm font-semibold">{name}</h1>
        {scope !== "user" && (
          <span className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground lg:inline" title={scope}>
            {tildify(scope, scopes?.home)}
          </span>
        )}
      </div>
      <Tabs value={tab} onValueChange={(value) => navigate({ tab: value as MainTab })} className="ml-2 shrink-0">
        <TabsList className="h-8!">
          <TabsTrigger value="skills" className="px-2.5 text-xs">Skills</TabsTrigger>
          <TabsTrigger value="instructions" className="px-2.5 text-xs">Instructions</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <UpdateStatus scope={scope} scopeName={name} />
        <Separator orientation="vertical" className="mx-1 h-5 self-center!" />
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" className="h-7" onClick={() => ui.setInstallOpen(true)} />}>
            <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
            Install
          </TooltipTrigger>
          <TooltipContent>
            Install skills <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="relative"
                aria-label={running ? `Jobs, ${running} running` : "Jobs"}
                onClick={() => ui.openJobs()}
              />
            }
          >
            <HugeiconsIcon icon={CommandLineIcon} strokeWidth={2} />
            {running > 0 && (
              <span className="absolute top-1 right-1 size-2 animate-pulse rounded-full bg-primary" />
            )}
          </TooltipTrigger>
          <TooltipContent>{running ? `Jobs · ${running} running` : "Jobs log"}</TooltipContent>
        </Tooltip>
        <ThemeToggle />
      </div>
    </header>
  )
}
