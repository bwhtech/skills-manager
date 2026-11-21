import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowUp02Icon, PinIcon, PlusSignIcon, RefreshIcon, UserIcon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { ProjectInfo } from "@shared/api"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api, errorMessage, useScopes, useScopesMutation, useSkills } from "@/lib/api"
import { basename, plural, timeAgo, tildify } from "@/lib/format"
import { navigate, usePlace } from "@/lib/hash-state"
import { useUpdateCounts } from "@/features/updates/update-status"
import { PinProjectDialog } from "./pin-project-dialog"
import { ProjectMenu } from "./project-menu"

function sortProjects(projects: ProjectInfo[]) {
  return [...projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name)
  )
}

// Touch: rows 44px tall, with their count and menu re-centered.
const COARSE_ROW = "pointer-coarse:h-11"
const COARSE_SIDE = "pointer-coarse:top-3!"

/** Open a scope; on phones also close the sidebar sheet, so the pick shows. */
function useOpenScope() {
  const { isMobile, setOpenMobile } = useSidebar()
  return (scope: string) => {
    if (isMobile) setOpenMobile(false)
    navigate({ scope })
  }
}

export function AppSidebar() {
  const { scope } = usePlace()
  const openScope = useOpenScope()
  const scopes = useScopes()
  const userSkills = useSkills("user")
  const updateCounts = useUpdateCounts()
  const [pinOpen, setPinOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const rescan = useScopesMutation(api.rescan)

  const projects = sortProjects(scopes.data?.projects ?? [])
  const needle = filter.trim().toLowerCase()
  const nameCounts = new Map<string, number>()
  for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1)
  const shown = needle
    ? projects.filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(needle))
    : projects

  return (
    <Sidebar className="pl-[env(safe-area-inset-left)]">
      <SidebarHeader className="h-[calc(3rem+env(safe-area-inset-top))] flex-row items-center px-4 pt-[calc(--spacing(2)+env(safe-area-inset-top))]">
        <span className="font-heading text-sm font-semibold tracking-tight">Skills Manager</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={scope === "user"}
                onClick={() => openScope("user")}
                className={`pr-11! ${COARSE_ROW}`}
              >
                <HugeiconsIcon icon={UserIcon} strokeWidth={2} />
                <span>User</span>
                <UpdateCount count={updateCounts.get("user")} />
              </SidebarMenuButton>
              {userSkills.data && <SidebarMenuBadge className={COARSE_SIDE}>{userSkills.data.length}</SidebarMenuBadge>}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="min-h-0">
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupAction title="Pin a project" aria-label="Pin a project" onClick={() => setPinOpen(true)}>
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          </SidebarGroupAction>
          <SidebarGroupContent>
            {projects.length > 8 && (
              <SidebarInput
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter projects"
                aria-label="Filter projects"
                type="search"
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="mb-1.5"
              />
            )}
            <SidebarMenu>
              {scopes.isPending &&
                Array.from({ length: 5 }, (_, i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuSkeleton />
                  </SidebarMenuItem>
                ))}
              {scopes.isError && (
                <li className="px-3 py-2 text-xs text-destructive">{errorMessage(scopes.error)}</li>
              )}
              {scopes.data && shown.length === 0 && (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  {needle ? "No matching projects." : "No projects found."}
                </li>
              )}
              {shown.map((project) => (
                <ProjectItem
                  key={project.path}
                  project={project}
                  active={scope === project.path}
                  home={scopes.data?.home}
                  duplicate={(nameCounts.get(project.name) ?? 0) > 1}
                  updates={updateCounts.get(project.path)}
                  onOpen={openScope}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t pb-[calc(--spacing(2)+env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2 px-1">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {scopes.data ? `Scanned ${timeAgo(scopes.data.lastScanAt)}` : " "}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="pointer-coarse:h-10 pointer-coarse:px-3"
            disabled={rescan.isPending}
            onClick={() =>
              rescan.mutate(undefined, {
                onSuccess: () => toast.success("Projects rescanned"),
                onError: (error) => toast.error("Rescan failed", { description: errorMessage(error) }),
              })
            }
          >
            {rescan.isPending ? <Spinner className="size-3" /> : <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />}
            Rescan
          </Button>
        </div>
      </SidebarFooter>
      <SidebarRail />
      <PinProjectDialog open={pinOpen} onOpenChange={setPinOpen} />
    </Sidebar>
  )
}

interface ProjectItemProps {
  project: ProjectInfo
  active: boolean
  home?: string
  /** another project has the same name: show the parent folder too */
  duplicate: boolean
  /** skills with an update in this project */
  updates?: number
  onOpen: (scope: string) => void
}

/**
 * A small green "↑ 3" at the end of a scope's row: skills with an update
 * there. The arrow tells it apart from the skill count next to it.
 */
function UpdateCount({ count }: { count?: number }) {
  if (!count) return null
  return (
    <span
      className="mr-1 ml-auto flex shrink-0 items-center gap-0.5 rounded-full bg-primary py-px pr-1.5 pl-1 text-[0.625rem] leading-4 font-medium text-primary-foreground tabular-nums"
      title={plural(count, "update")}
      aria-label={plural(count, "update")}
    >
      <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2.5} className="size-2.5!" aria-hidden />
      {count}
    </span>
  )
}

function ProjectItem({ project, active, home, duplicate, updates, onOpen }: ProjectItemProps) {
  const parent = basename(project.path.slice(0, project.path.length - project.name.length - 1))
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              isActive={active}
              onClick={() => onOpen(project.path)}
              className={`pr-14! ${COARSE_ROW}`}
            />
          }
        >
          {project.pinned && (
            <HugeiconsIcon icon={PinIcon} strokeWidth={2} aria-label="Pinned" className="text-muted-foreground" />
          )}
          <span>
            {project.name}
            {duplicate && <span className="ml-1.5 text-xs text-muted-foreground">{parent}/</span>}
          </span>
          <UpdateCount count={updates} />
        </TooltipTrigger>
        <TooltipContent side="right" className="font-mono">
          {tildify(project.path, home)}
        </TooltipContent>
      </Tooltip>
      <SidebarMenuBadge className={`right-7 ${COARSE_SIDE}`}>{project.skillCount}</SidebarMenuBadge>
      <ProjectMenu project={project} />
    </SidebarMenuItem>
  )
}
