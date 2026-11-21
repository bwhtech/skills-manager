import { useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon, File01Icon, FileAttachmentIcon, Folder01Icon } from "@hugeicons/core-free-icons"
import type { SkillFileEntry } from "@shared/api"
import { DirtyDot } from "@/components/editor"
import { formatBytes } from "@/lib/format"
import { cn } from "@/lib/utils"

interface TreeNode {
  name: string
  path: string
  entry: SkillFileEntry | null // null for folders
  children: TreeNode[]
}

function buildTree(files: SkillFileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", entry: null, children: [] }
  for (const file of files) {
    let node = root
    const parts = file.path.split("/")
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/")
      let child = node.children.find((c) => c.name === part)
      if (!child) {
        child = { name: part, path, entry: null, children: [] }
        node.children.push(child)
      }
      if (i === parts.length - 1) child.entry = file
      node = child
    })
  }
  sortTree(root)
  return root.children
}

// SKILL.md first, then folders, then files, each by name.
function sortTree(node: TreeNode) {
  node.children.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  node.children.forEach(sortTree)
}

function rank(node: TreeNode) {
  if (node.path === "SKILL.md") return 0
  return node.entry ? 2 : 1
}

interface FileTreeProps {
  files: SkillFileEntry[]
  selectedPath: string
  /** files with unsaved edits */
  dirtyPaths: ReadonlySet<string>
  onSelect: (path: string) => void
}

export function FileTree({ files, selectedPath, dirtyPaths, onSelect }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files])
  return (
    <ul role="tree" aria-label="Skill files" className="flex flex-col gap-px p-2 text-xs">
      {tree.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          dirtyPaths={dirtyPaths}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}

interface TreeItemProps extends Omit<FileTreeProps, "files"> {
  node: TreeNode
  depth: number
}

function TreeItem({ node, depth, selectedPath, dirtyPaths, onSelect }: TreeItemProps) {
  const [open, setOpen] = useState(depth < 1 || selectedPath.startsWith(node.path + "/"))
  const indent = { paddingLeft: `${8 + depth * 14}px` }
  const rowClass =
    "pressable flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-11 pointer-coarse:gap-2 pointer-coarse:text-sm"

  if (!node.entry) {
    return (
      <li role="treeitem" aria-expanded={open} aria-selected={false}>
        <button type="button" style={indent} className={cn(rowClass, "hover:bg-muted/60")} onClick={() => setOpen(!open)}>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2}
            className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && (
          <ul role="group" className="flex flex-col gap-px">
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                dirtyPaths={dirtyPaths}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  const { entry } = node
  const selected = entry.path === selectedPath
  return (
    <li role="treeitem" aria-selected={selected}>
      <button
        type="button"
        style={indent}
        disabled={!entry.isText}
        title={entry.isText ? `${entry.path} · ${formatBytes(entry.size)}` : `${entry.path} · binary file, cannot be shown`}
        onClick={() => onSelect(entry.path)}
        className={cn(
          rowClass,
          "hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
          selected && "bg-muted font-medium hover:bg-muted"
        )}
      >
        <span className="size-3 shrink-0" />
        <HugeiconsIcon
          icon={entry.isText ? File01Icon : FileAttachmentIcon}
          strokeWidth={2}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <DirtyDot dirty={dirtyPaths.has(entry.path)} />
      </button>
    </li>
  )
}
