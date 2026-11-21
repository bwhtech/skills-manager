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
  requestGeneration,
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
  test("a refetch replaces a clean document; under a draft it raises the conflict", () => {
    mount(v1)
    rebaseDraft(KEY, v2, { keepDraft: true })
    expect(getDraft(KEY)?.base).toEqual(v2)
    editDraft(KEY, "mine\n")
    rebaseDraft(KEY, { content: "three\n", hash: "h4", mtimeMs: 4 }, { keepDraft: true })
    expect(getDraft(KEY)).toMatchObject({ base: v2, content: "mine\n", conflict: true })
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

/** A version as a fetch sent now would load it. */
function fetched(file: Version): Version {
  return { ...file, generation: requestGeneration() }
}

describe("rollback on disk after a save (A -> save B -> restore A)", () => {
  /** Edit and save B over v1 (A); returns a fetch of A sent while the save ran. */
  function saveB() {
    mount(fetched(v1))
    editDraft(KEY, "B\n")
    const start = beginSave(KEY)!
    const early = fetched(v1) // sent before the save response arrived
    finishSave(KEY, start, { hash: "hB", mtimeMs: 3 })
    return early
  }

  test("a fetch sent before the save landed is ignored", () => {
    const early = saveB()
    rebaseDraft(KEY, early, { keepDraft: true })
    expect(getDraft(KEY)).toMatchObject({ base: { hash: "hB" }, content: "B\n", conflict: false })
  })

  test("a fetch sent after the save that returns A is a real change: a clean draft adopts it", () => {
    saveB()
    rebaseDraft(KEY, fetched({ content: "B\n", hash: "hB", mtimeMs: 3 }), { keepDraft: true })
    // Restored to A on disk, then refetched.
    rebaseDraft(KEY, fetched(v1), { keepDraft: true })
    expect(getDraft(KEY)).toMatchObject({ base: v1, content: v1.content, conflict: false })
    expect(isDraftDirty(getDraft(KEY))).toBe(false)
    // The leave guard has nothing to ask about.
    expect(hasDirtyDrafts()).toBe(false)
  })

  test("the restore can be the first fetch after the save, too", () => {
    saveB()
    rebaseDraft(KEY, fetched(v1), { keepDraft: true })
    expect(getDraft(KEY)?.base.hash).toBe(v1.hash)
  })

  test("a dirty draft gets the conflict instead", () => {
    saveB()
    editDraft(KEY, "B and more\n")
    rebaseDraft(KEY, fetched(v1), { keepDraft: true })
    expect(getDraft(KEY)).toMatchObject({ base: { hash: "hB" }, content: "B and more\n", conflict: true })
    expect(hasDirtyDrafts()).toBe(true)
  })

  test("openDraft (a remount) applies the same rules", () => {
    const early = saveB()
    const desktop = { release: retainDraft(KEY, v1) }
    // The cached pre-save version: restored as is.
    expect(openDraft(KEY, early)).toMatchObject({ base: { hash: "hB" }, conflict: false })
    // The disk after a restore to A: a clean draft starts over from it.
    expect(openDraft(KEY, fetched(v1))).toMatchObject({ base: v1, content: v1.content, conflict: false })
    desktop.release()
  })

  test("openDraft on a dirty draft after a restore marks the conflict", () => {
    saveB()
    editDraft(KEY, "B2\n")
    expect(openDraft(KEY, fetched(v1))).toMatchObject({ content: "B2\n", conflict: true })
  })

  test("without a generation, only the version the save replaced counts as late", () => {
    saveB()
    rebaseDraft(KEY, v1, { keepDraft: true }) // the replaced base: ignored
    expect(getDraft(KEY)?.base.hash).toBe("hB")
    rebaseDraft(KEY, v2, { keepDraft: true }) // anything else is the disk now
    expect(getDraft(KEY)?.base).toEqual(v2)
  })

  test("a refetch during a save waits for the save's answer", () => {
    mount(v1)
    editDraft(KEY, "x\n")
    beginSave(KEY)
    rebaseDraft(KEY, fetched(v2), { keepDraft: true })
    expect(getDraft(KEY)).toMatchObject({ base: v1, content: "x\n", conflict: false })
    expect(openDraft(KEY, fetched(v2)).conflict).toBe(false)
  })
})
