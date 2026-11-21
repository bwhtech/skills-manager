import { HugeiconsIcon } from "@hugeicons/react"
import { PlusSignIcon } from "@hugeicons/core-free-icons"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { InstructionFile } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { api, errorMessage, keys, useScopes } from "@/lib/api"
import { tildify } from "@/lib/format"

function template(file: InstructionFile) {
  return file.scope === "user" ? "# User instructions\n" : "# Project instructions\n"
}

export function CreateInstruction({ file }: { file: InstructionFile }) {
  const client = useQueryClient()
  const home = useScopes().data?.home
  const create = useMutation({
    mutationFn: () => api.saveInstruction(file.id, { content: template(file), create: true }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.instructions(file.scope) })
      void client.invalidateQueries({ queryKey: keys.scopes })
      toast.success(`Created ${file.fileName}`)
    },
    onError: (error) => toast.error(`Could not create ${file.fileName}`, { description: errorMessage(error) }),
  })

  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle className="text-base">{file.fileName} does not exist</EmptyTitle>
        <EmptyDescription>
          {file.agentLabel} reads it from <span className="font-mono break-all">{tildify(file.path, home)}</span>.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? <Spinner /> : <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />}
          Create {file.fileName}
        </Button>
      </EmptyContent>
    </Empty>
  )
}
