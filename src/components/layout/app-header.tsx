import { HugeiconsIcon } from "@hugeicons/react"
import {
  CircleArrowUp02Icon,
  CommandLineIcon,
  Download04Icon,
  Moon02Icon,
  MoreVerticalIcon,
  RefreshIcon,
  Sun03Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { modKey } from "@/components/editor/editor-toolbar"
import { UpdateStatus, useUpdateActions } from "@/features/updates/update-status"
import { useIsDesktop } from "@/hooks/use-media-query"
import { useJobs, useScopes } from "@/lib/api"
import { plural, scopeLabel, tildify } from "@/lib/format"
import { navigate, usePlace, type MainTab } from "@/lib/hash-state"
import { ui } from "@/lib/ui-store"
import { cn } from "@/lib/utils"
import { ThemeToggle, useThemeToggle } from "./theme-toggle"

export function AppHeader() {
  const isDesktop = useIsDesktop()
  return isDesktop ? <DesktopHeader /> : <PhoneHeader />
}

function useHeaderData() {
  const { scope, tab } = usePlace()
  const scopes = useScopes().data
  const name = scopeLabel(scope, scopes?.projects)
  const running = useJobs().data?.filter((job) => job.status === "running").length ?? 0
  return { scope, tab, scopes, name, running }
}

function DesktopHeader() {
  const { scope, tab, scopes, name, running } = useHeaderData()

  return (
    // Padding for a top inset (an iPad web app); 0 on a desktop browser.
    <header className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b px-3 pt-[env(safe-area-inset-top)]">
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

/**
 * Phones (360px and up): scope title, Install, and the rest in a menu.
 * The Skills / Instructions switch gets its own full-width row.
 */
function PhoneHeader() {
  const { scope, tab, name, running } = useHeaderData()
  const updates = useUpdateActions(scope)
  const theme = useThemeToggle()
  const attention = running > 0 || updates.total > 0

  return (
    <header className="shrink-0 border-b pt-[env(safe-area-inset-top)]">
      <div className="flex h-12 items-center gap-0.5 px-1">
        <SidebarTrigger className="size-11" />
        <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">{name}</h1>
        <Button variant="ghost" size="icon" className="size-11" aria-label="Install skills" onClick={() => ui.setInstallOpen(true)}>
          <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="relative size-11"
                aria-label={attention ? "More actions, needs attention" : "More actions"}
              />
            }
          >
            <HugeiconsIcon icon={MoreVerticalIcon} strokeWidth={2} />
            {attention && (
              <span
                className={cn(
                  "absolute top-2.5 right-2.5 size-2 rounded-full bg-primary",
                  running > 0 && "animate-pulse"
                )}
              />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem disabled={updates.checking} onClick={updates.refresh}>
              {updates.checking ? <Spinner /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />}
              <span className="flex min-w-0 flex-col">
                <span>{updates.checking ? "Checking for updates…" : "Check for updates"}</span>
                <span className="truncate text-xs font-normal text-muted-foreground">
                  {updates.total > 0 ? `${plural(updates.total, "update")} · ` : ""}
                  {updates.summary}
                </span>
              </span>
            </DropdownMenuItem>
            {updates.inScope.length > 0 && (
              <DropdownMenuItem onClick={updates.updateAll}>
                <HugeiconsIcon icon={CircleArrowUp02Icon} strokeWidth={2} />
                <span className="truncate">Update all {updates.inScope.length} in {name}…</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => ui.openJobs()}>
              <HugeiconsIcon icon={CommandLineIcon} strokeWidth={2} />
              Jobs
              {running > 0 && <span className="ml-auto text-xs text-muted-foreground">{running} running</span>}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={theme.toggle}>
              <HugeiconsIcon icon={theme.dark ? Sun03Icon : Moon02Icon} strokeWidth={2} />
              {theme.dark ? "Light mode" : "Dark mode"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-3 pb-2">
        <Tabs value={tab} onValueChange={(value) => navigate({ tab: value as MainTab })}>
          <TabsList className="h-10! w-full">
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="instructions">Instructions</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </header>
  )
}
