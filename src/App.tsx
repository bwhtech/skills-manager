import { lazy, Suspense, useEffect, useState } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { UnsavedChangesDialog } from "@/components/editor"
import { AppHeader } from "@/components/layout/app-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { InstallDialog } from "@/features/install/install-dialog"
import { InstructionsView } from "@/features/instructions/instructions-view"
import { JobsSheet } from "@/features/jobs/jobs-sheet"
import { FileViewer } from "@/features/open/file-viewer"
import { RecoveryBanner } from "@/features/recovery/recovery-banner"
import { AppSidebar } from "@/features/scopes/app-sidebar"
import { SkillsView } from "@/features/skills/skills-view"
import { useIsDesktop } from "@/hooks/use-media-query"
import { useVisualViewportHeight } from "@/hooks/use-visual-viewport"
import { usePlace } from "@/lib/hash-state"
import { isMod, useWindowKeydown } from "@/lib/hotkeys"
import { queryClient } from "@/lib/query-client"
import { ui, useUi } from "@/lib/ui-store"

const UpdateAllDialog = lazy(() =>
  import("@/features/updates/update-all-dialog").then((module) => ({ default: module.UpdateAllDialog }))
)

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

/**
 * On phones a stacked screen (a skill, a file) brings its own top bar with a
 * back button, so the app header steps aside, like a pushed native screen.
 */
function Header() {
  const place = usePlace()
  const isDesktop = useIsDesktop()
  const pushed = place.tab === "skills" ? !!place.skill : !!place.doc
  return isDesktop || !pushed ? <AppHeader /> : null
}

/** The Update all dialog loads on first open, then stays mounted so it can animate out. */
function UpdateAllDialogSlot() {
  const { updateAllScope } = useUi()
  const [used, setUsed] = useState(false)
  if (updateAllScope && !used) setUsed(true)
  return used ? (
    <Suspense fallback={null}>
      <UpdateAllDialog />
    </Suspense>
  ) : null
}

/** Phones: toasts at the top, under the notch, clear of the editor toolbar and the jobs log. */
function AppToaster() {
  const isDesktop = useIsDesktop()
  return isDesktop ? (
    <Toaster position="bottom-right" />
  ) : (
    <Toaster
      position="top-center"
      offset={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
      mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 8px)", left: "12px", right: "12px" }}
    />
  )
}

export function App() {
  const [sidebarOpen, setSidebarOpen] = useAutoSidebar()
  useVisualViewportHeight()

  useWindowKeydown((event) => {
    if (isMod(event) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault()
      ui.setInstallOpen(true)
    }
  })

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={400}>
        {/* --app-height: the visible height above an iOS soft keyboard (see useVisualViewportHeight). */}
        <SidebarProvider
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          className="h-[var(--app-height,100dvh)] min-h-0 overflow-hidden"
        >
          <AppSidebar />
          {/* Landscape phones: keep content out of the notch and the rounded corners. */}
          <SidebarInset className="min-w-0 overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
            <Header />
            <RecoveryBanner />
            <Main />
          </SidebarInset>
        </SidebarProvider>
        <JobsSheet />
        <FileViewer />
        <InstallDialog />
        <UpdateAllDialogSlot />
        <UnsavedChangesDialog />
        <AppToaster />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

export default App
