import { useEffect, useState } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { UnsavedChangesDialog } from "@/components/editor"
import { AppHeader } from "@/components/layout/app-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { InstallDialog } from "@/features/install/install-dialog"
import { InstructionsView } from "@/features/instructions/instructions-view"
import { JobsSheet } from "@/features/jobs/jobs-sheet"
import { AppSidebar } from "@/features/scopes/app-sidebar"
import { SkillsView } from "@/features/skills/skills-view"
import { usePlace } from "@/lib/hash-state"
import { isMod, useWindowKeydown } from "@/lib/hotkeys"
import { queryClient } from "@/lib/query-client"
import { ui } from "@/lib/ui-store"

const WIDE = "(min-width: 1024px)"

/** The sidebar starts open on wide screens and closes itself below 1024px. */
function useAutoSidebar() {
  const [open, setOpen] = useState(() => window.matchMedia(WIDE).matches)
  useEffect(() => {
    const media = window.matchMedia(WIDE)
    const onChange = () => setOpen(media.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])
  return [open, setOpen] as const
}

function Main() {
  const place = usePlace()
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {place.tab === "skills" ? (
        <SkillsView key={place.scope} scope={place.scope} skillId={place.skill} file={place.file} />
      ) : (
        <InstructionsView key={place.scope} scope={place.scope} docId={place.doc} />
      )}
    </div>
  )
}

export function App() {
  const [sidebarOpen, setSidebarOpen] = useAutoSidebar()

  useWindowKeydown((event) => {
    if (isMod(event) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault()
      ui.setInstallOpen(true)
    }
  })

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={400}>
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="h-svh overflow-hidden">
          <AppSidebar />
          <SidebarInset className="min-w-0 overflow-hidden">
            <AppHeader />
            <Main />
          </SidebarInset>
        </SidebarProvider>
        <JobsSheet />
        <InstallDialog />
        <UnsavedChangesDialog />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

export default App
