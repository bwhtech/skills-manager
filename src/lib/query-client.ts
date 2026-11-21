import { QueryClient } from "@tanstack/react-query"
import { refreshAfterDeletedPreviews, refreshSkillsAfterChecks } from "./api"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
    },
  },
})

refreshSkillsAfterChecks(queryClient)
refreshAfterDeletedPreviews(queryClient)
