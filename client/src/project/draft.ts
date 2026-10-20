// A gesture's draft: the live values of the entities a drag changes, kept out of the doc until release (see `Moving` in the
// shared schema). The store shows them over the doc (and our own at once); a drop writes the final ones in one transaction.
import {
  addNote, addPoint, clipsMap, deleteNote, deletePoint, lanesMap, loopersMap, notesMap, padsMap, pointsMap, updateClip, updateLaneLfo, updateLooper, updateNote, updatePad, updatePoint,
  type Moving,
} from '@mobdaw/shared'
import type * as Y from 'yjs'

const withoutId = <T extends { id?: string }>(p: T): Omit<T, 'id'> => {
  const { id: _id, ...rest } = p
  return rest
}

export const KINDS = ['clips', 'notes', 'pads', 'loopers', 'lanes', 'points'] as const

export const isEmptyMoving = (d: Moving | null | undefined) => !d || KINDS.every((k) => !d[k] || !Object.keys(d[k]!).length)

/** Drafts laid over each other, later ones winning field by field. */
export function mergeMoving(...ds: (Moving | null | undefined)[]): Moving {
  const out: Record<string, Record<string, object | null>> = {}
  for (const d of ds) {
    if (!d) continue
    for (const k of KINDS) for (const [id, p] of Object.entries(d[k] ?? {})) (out[k] ??= {})[id] = p && { ...out[k]?.[id], ...p }
  }
  return out as Moving
}

/**
 * Write a draft to the doc as one transaction (so one undo step, bracketed so neighbouring edits don't merge into it).
 * An entity that is gone from the doc is skipped, unless the draft carries all of it (a note copy), which is added under its id.
 */
export function commitMoving(doc: Y.Doc, undo: Y.UndoManager, d: Moving) {
  if (isEmptyMoving(d)) return
  undo.stopCapturing()
  doc.transact(() => {
    for (const [id, p] of Object.entries(d.clips ?? {})) {
      const { id: _id, kind: _kind, ...rest } = p as Record<string, unknown>
      if (clipsMap(doc).has(id)) updateClip(doc, id, rest)
    }
    for (const [id, p] of Object.entries(d.notes ?? {})) {
      if (!p) deleteNote(doc, id)
      else if (notesMap(doc).has(id)) updateNote(doc, id, withoutId(p))
      else if (p.id && p.clipId != null) addNote(doc, withoutId(p) as Parameters<typeof addNote>[1], id)
    }
    for (const [id, p] of Object.entries(d.pads ?? {})) if (padsMap(doc).has(id)) updatePad(doc, id, p)
    for (const [id, p] of Object.entries(d.loopers ?? {})) if (loopersMap(doc).has(id)) updateLooper(doc, id, p)
    for (const [id, p] of Object.entries(d.lanes ?? {})) if (lanesMap(doc).has(id)) updateLaneLfo(doc, id, p)
    for (const [id, p] of Object.entries(d.points ?? {})) {
      if (!p) deletePoint(doc, id)
      else if (pointsMap(doc).has(id)) updatePoint(doc, id, withoutId(p))
      else if (p.id && p.laneId != null && p.pos != null && p.value != null) addPoint(doc, p.laneId, p.pos, p.value, p.curve, id)
    }
  })
  undo.stopCapturing()
}

/**
 * A slider's draft: its live value goes to the store (and so the peers) while it is dragged, and the doc is written once, when it
 * lets go (the `change` event; the pointer coming up is the backstop for a slider that is gone by then).
 */
export function sliderDraft(store: { setDraft(d: Moving): void; clearDraft(): void }, doc: Y.Doc, undo: Y.UndoManager) {
  let draft: Moving | null = null
  const release = () => {
    if (!draft) return
    commitMoving(doc, undo, draft)
    draft = null
    store.clearDraft()
  }
  const later = () => void setTimeout(release, 0) // (after the slider's own `change`)
  return {
    set(d: Moving) {
      draft = d
      store.setDraft(d)
      if (typeof addEventListener === 'function') addEventListener('pointerup', later, { once: true, capture: true })
    },
    release,
  }
}
