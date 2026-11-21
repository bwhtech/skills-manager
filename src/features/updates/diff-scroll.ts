import { createContext } from "react"

/**
 * The scrolling body of an update dialog, for the diff renderer's virtualizer
 * (@pierre/diffs). The dialog body owns the slot; the first diff that mounts
 * creates the one virtualizer every diff in that body shares, and the body
 * disposes of it when it unmounts. A module of its own, with no
 * @pierre/diffs import, so the dialogs do not pull the diff chunk in.
 */
export interface DiffScrollSlot {
  /** the element that scrolls */
  root: HTMLElement
  /** its only child, which holds the content: the virtualizer watches its size */
  content: HTMLElement
  /** the shared object: made by `create` on the first call, disposed of with the body */
  shared<T>(create: () => { value: T; dispose: () => void }): T
}

export const DiffScrollContext = createContext<DiffScrollSlot | null>(null)

/** A slot for a mounted body; call the returned dispose when it unmounts. */
export function createDiffScrollSlot(root: HTMLElement, content: HTMLElement) {
  let made: { value: unknown; dispose: () => void } | null = null
  const slot: DiffScrollSlot = {
    root,
    content,
    shared: <T,>(create: () => { value: T; dispose: () => void }) => {
      made ??= create()
      return made.value as T
    },
  }
  return { slot, dispose: () => made?.dispose() }
}
