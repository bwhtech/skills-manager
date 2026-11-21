import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, MoreHorizontalIcon, PinOffIcon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { ProjectInfo } from "@shared/api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuAction } from "@/components/ui/sidebar"
import { api, errorMessage, useScopesMutation } from "@/lib/api"

export function ProjectMenu({ project }: { project: ProjectInfo }) {
  const unpin = useScopesMutation(api.unpin)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuAction
            showOnHover
            aria-label={`Actions for ${project.name}`}
            className="pointer-coarse:top-3! pointer-coarse:after:-inset-3"
          />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-auto">
        <DropdownMenuItem
          onClick={() => void navigator.clipboard?.writeText(project.path).then(() => toast.success("Path copied"))}
        >
          <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
          Copy path
        </DropdownMenuItem>
        {project.pinned && (
          <DropdownMenuItem
            onClick={() =>
              unpin.mutate(project.path, {
                onError: (error) => toast.error("Could not unpin", { description: errorMessage(error) }),
              })
            }
          >
            <HugeiconsIcon icon={PinOffIcon} strokeWidth={2} />
            Unpin
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
