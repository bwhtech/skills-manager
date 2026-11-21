import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { LinkSquare02Icon, Search01Icon } from "@hugeicons/core-free-icons"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage, useSearch } from "@/lib/api"
import { formatCount } from "@/lib/format"
import { useDebounced } from "@/lib/use-debounced"
import { cn } from "@/lib/utils"
import type { Pick } from "./types"

interface SearchSourceProps {
  initialText?: string
  pick: Pick | null
  onPick: (pick: Pick | null) => void
}

export function SearchSource({ initialText = "", pick, onPick }: SearchSourceProps) {
  const [text, setText] = useState(initialText)
  const query = useDebounced(text.trim(), 300)
  const results = useSearch(query)
  const list = query.length >= 2 ? (results.data ?? []) : []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <InputGroup className="h-9 shrink-0 pointer-coarse:h-11">
        <InputGroupAddon>
          <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search skills.sh, e.g. react, pdf, testing"
          aria-label="Search skills.sh"
          type="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        {results.isFetching && (
          <InputGroupAddon align="inline-end">
            <Spinner />
          </InputGroupAddon>
        )}
      </InputGroup>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl border max-md:flex-none max-md:overflow-visible"
        aria-label="Search results"
      >
        {query.length < 2 ? (
          <p className="p-4 text-xs text-muted-foreground">Type at least two characters.</p>
        ) : results.isPending ? (
          <div className="flex flex-col gap-1 p-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : results.isError ? (
          <p className="p-4 text-xs text-destructive">Search failed: {errorMessage(results.error)}</p>
        ) : list.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">No skills match “{query}”.</p>
        ) : (
          <ul className="flex flex-col gap-0.5 p-1.5">
            {list.map((result) => {
              const selected = pick?.source === result.source && pick.skills[0] === result.skill
              return (
                <li key={result.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onPick(selected ? null : { source: result.source, skills: [result.skill] })}
                    className={cn(
                      "pressable flex h-11 min-w-0 flex-1 flex-col justify-center rounded-xl px-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50",
                      selected && "bg-primary/15 hover:bg-primary/20 dark:bg-primary/15"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{result.skill}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatCount(result.installs)} installs
                      </span>
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{result.source}</span>
                  </button>
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={`Open ${result.skill} on skills.sh`}
                    className="pressable flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:size-11"
                  >
                    <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} className="size-3.5" />
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
