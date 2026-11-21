import { beforeEach, describe, expect, test } from "bun:test"
import {
  beginSave,
  discardDrafts,
  editDraft,
  failSave,
  finishSave,
  getDraft,
  hasDirtyDrafts,
  isDraftDirty,
  openDraft,
  rebaseDraft,
  resetDrafts,
  retainDraft,
  type Version,
} from "./drafts"

const KEY = "skill:id:SKILL.md"
const v1: Version = { content: "one\n", hash: "h1", mtimeMs: 1 }
const v2: Version = { content: "two\n", hash: "h2", mtimeMs: 2 }

/** An editor's life: open (state initializer), then mount (effect). */
function mount(file: Version, key = KEY) {
  const state = openDraft(key, file)
  const release = retainDraft(key, file)
  return { state, release }
}

beforeEach(resetDrafts)

describe("suspended drafts (layout switch)", () => {
  test("a dirty draft outlives its editor and keeps the guard on", () => {
    const desktop = mount(v1)
    editDraft(KEY, "edited\n")
    desktop.release() // phone skill screen: no editor
    expect(hasDirtyDrafts()).toBe(true)
    // Back on desktop: same key, same base hash -> restored.
    const again = mount(v1)
    expect(again.state.content).toBe("edited\n")
    expect(again.state.conflict).toBe(false)
  })

  test("discard while suspended: no resurrection", () => {
    const desktop = mount(v1)
    editDraft(KEY, "edited\n")
    desktop.release()
    discardDrafts()
    expect(hasDirtyDrafts()).toBe(false)
    expect(getDraft(KEY)).toBeUndefined()
    expect(mount(v1).state.content).toBe(v1.content)
  })

  test("discard with the editor mounted resets it to the base", () => {
    mount(v1)
    editDraft(KEY, "edited\n")
    discardDrafts()
    expect(getDraft(KEY)?.content).toBe(v1.content)
    expect(hasDirtyDrafts()).toBe(false)
  })

  test("a clean document is forgotten once no editor shows it", () => {
    const { release } = mount(v1)
    release()
    expect(getDraft(KEY)).toBeUndefined()
  })

  test("StrictMode remount of a clean document reopens it", () => {
    const state = openDraft(KEY, v1)
    retainDraft(KEY, v1)() // effect, cleanup
    retainDraft(KEY, v1) // effect again
    expect(getDraft(KEY)?.base).toEqual(state.base)
  })

  test("a draft based on another version is restored as a conflict", () => {
    const desktop = mount(v1)
    editDraft(KEY, "edited\n")
    desktop.release()
    const again = mount(v2) // changed on disk meanwhile
    expect(again.state).toMatchObject({ content: "edited\n", conflict: true, base: v1 })
  })

  test("a clean entry opened at another version starts over", () => {
    openDraft(KEY, v1)
    expect(openDraft(KEY, v2)).toMatchObject({ base: v2, content: v2.content })
  })

  test("two editors at once (new one mounts before the old unmounts)", () => {
    const desktop = mount(v1)
    editDraft(KEY, "edited\n")
    const phone = mount(v1)
    desktop.release()
    expect(phone.state.content).toBe("edited\n")
    phone.release()
    expect(isDraftDirty(getDraft(KEY))).toBe(true)
  })
})

describe("saves", () => {
  test("completes into the store after the editor that started it unmounted", () => {
    const desktop = mount(v1)
    editDraft(KEY, "edited\n")
    const start = beginSave(KEY)!
    expect(start).toEqual({ content: "edited\n", baseHash: "h1" })
    desktop.release()
    const phone = mount(v1) // the refetch has not landed yet
    expect(phone.state.saving).toBe(start)
    finishSave(KEY, start, { hash: "h3", mtimeMs: 3 })
    expect(getDraft(KEY)).toMatchObject({
      base: { content: "edited\n", hash: "h3" },
      content: "edited\n",
      saving: null,
    })
    expect(hasDirtyDrafts()).toBe(false)
    // The next save starts from the new hash: no false conflict.
    editDraft(KEY, "more\n")
    expect(beginSave(KEY)?.baseHash).toBe("h3")
  })

  test("edits made while saving stay dirty against the saved version", () => {
    mount(v1)
    editDraft(KEY, "a\n")
    const start = beginSave(KEY)!
    editDraft(KEY, "ab\n")
    finishSave(KEY, start, { hash: "h3", mtimeMs: 3 })
    expect(getDraft(KEY)).toMatchObject({ base: { content: "a\n" }, content: "ab\n" })
    expect(hasDirtyDrafts()).toBe(true)
  })

  test("a save that lands with no editor mounted is forgotten when clean", () => {
    const desktop = mount(v1)
    editDraft(KEY, "edited\n")
    const start = beginSave(KEY)!
    desktop.release()
    finishSave(KEY, start, { hash: "h3", mtimeMs: 3 })
    expect(getDraft(KEY)).toBeUndefined()
  })

  test("only one save at a time", () => {
    mount(v1)
    editDraft(KEY, "x\n")
    expect(beginSave(KEY)).not.toBeNull()
    expect(beginSave(KEY)).toBeNull()
  })

  test("a conflict is kept in the store for the next editor", () => {
    const desktop = mount(v1)
    editDraft(KEY, "x\n")
    const start = beginSave(KEY)!
    desktop.release()
    failSave(KEY, start, { conflict: true })
    expect(mount(v1).state).toMatchObject({ conflict: true, saving: null, content: "x\n" })
  })

  test("discard during a save treats the saved content as clean", () => {
    const desktop = mount(v1)
    editDraft(KEY, "x\n")
    const start = beginSave(KEY)!
    editDraft(KEY, "xy\n")
    desktop.release()
    discardDrafts()
    expect(getDraft(KEY)?.content).toBe("x\n")
    finishSave(KEY, start, { hash: "h3", mtimeMs: 3 })
    expect(getDraft(KEY)).toBeUndefined()
  })
})

describe("rebase", () => {
  test("a refetch replaces a clean document, not a draft", () => {
    mount(v1)
    rebaseDraft(KEY, v2, { keepDraft: true })
    expect(getDraft(KEY)?.base).toEqual(v2)
    editDraft(KEY, "mine\n")
    rebaseDraft(KEY, { content: "three\n", hash: "h4", mtimeMs: 4 }, { keepDraft: true })
    expect(getDraft(KEY)).toMatchObject({ base: v2, content: "mine\n" })
  })

  test("a late refetch of an older version does not roll back a save", () => {
    mount(v1)
    editDraft(KEY, "saved\n")
    const start = beginSave(KEY)!
    finishSave(KEY, start, { hash: "h3", mtimeMs: 3 })
    rebaseDraft(KEY, v1, { keepDraft: true })
    expect(getDraft(KEY)?.base.hash).toBe("h3")
  })

  test("reload takes the version on disk and clears the conflict", () => {
    mount(v1)
    editDraft(KEY, "x\n")
    const start = beginSave(KEY)!
    failSave(KEY, start, { conflict: true })
    rebaseDraft(KEY, v2)
    expect(getDraft(KEY)).toMatchObject({ base: v2, content: v2.content, conflict: false })
  })
})
