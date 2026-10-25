// The bus tree as the timeline lists it, and the edits that move tracks around in it (docs/routing.md). Pure over the doc: the
// view (collapsed buses) is passed in, never stored here. A track's `order` sorts it among its siblings (the children of one parent).
import { MASTER_TRACK, addBus, effectiveParent, getTracks, nextTrackColor, orderBetween, setParent, trackTree, tracksMap, updateTrack, type Track } from '@mobdaw/shared'
import type * as Y from 'yjs'

/** One line of the timeline's track list. */
export type TreeRow = {
  id: string
  /** The effective parent: a bus id, or `MASTER_TRACK` for the roots. */
  parent: string
  /** Buses above it (0 for a root). */
  depth: number
  bus: boolean
  /** Direct children (buses only). */
  kids: number
  /** Every track below it, buses included. */
  below: number
  /** Some bus above it is collapsed: it is not shown. */
  hidden: boolean
  /** The buses it sits in, outermost first. */
  ancestors: string[]
}

/** Tracks and buses in list order: the master's children, each bus followed by its own children, depth first. */
export function treeRows(tracks: Pick<Track, 'id' | 'kind' | 'order' | 'parent' | 'name' | 'muted' | 'soloed'>[], collapsed: (id: string) => boolean = () => false): TreeRow[] {
  const tree = trackTree(tracks as Track[])
  const rows: TreeRow[] = []
  const walk = (parent: string, ancestors: string[], hidden: boolean): number => {
    let n = 0
    for (const t of tree.get(parent) ?? []) {
      const row: TreeRow = { id: t.id, parent, depth: ancestors.length, bus: t.kind === 'bus', kids: tree.get(t.id)?.length ?? 0, below: 0, hidden, ancestors }
      rows.push(row)
      if (row.bus) row.below = walk(t.id, [...ancestors, t.id], hidden || collapsed(t.id))
      n += 1 + row.below
    }
    return n
  }
  walk(MASTER_TRACK, [], false)
  return rows
}

/** `id` and everything below it. */
export function subtreeOf(rows: TreeRow[], id: string): Set<string> {
  return new Set(rows.filter((r) => r.id === id || r.ancestors.includes(id)).map((r) => r.id))
}

/** A place in the tree: under `parent` (a bus or `MASTER_TRACK`), in front of its child `before`, or last when null. */
export type Slot = { parent: string; before: string | null }
/** Where relative to a track a dragged one would go: in front of it, behind it, or into a bus (or the master) as its first / last child. */
export type Anchor = { id: string; at: 'before' | 'after' | 'start' | 'end' }

/**
 * The slot an anchor means for the track `dragId` (which is lifted out first, so it never counts as its own neighbour). Null when
 * it would put a track into itself or into its own subtree, or the anchor is not there.
 */
export function slotFor(tracks: Track[], dragId: string, a: Anchor): Slot | null {
  const rows = treeRows(tracks)
  if (a.id === MASTER_TRACK) return a.at === 'start' ? { parent: MASTER_TRACK, before: rows.find((r) => r.parent === MASTER_TRACK && r.id !== dragId)?.id ?? null } : a.at === 'end' ? { parent: MASTER_TRACK, before: null } : null
  const row = rows.find((r) => r.id === a.id)
  if (!row || a.id === dragId || row.ancestors.includes(dragId)) return null
  const sibs = (parent: string) => rows.filter((r) => r.parent === parent && r.id !== dragId).map((r) => r.id)
  if (a.at === 'before') return { parent: row.parent, before: a.id }
  if (a.at === 'after') return { parent: row.parent, before: sibs(row.parent)[sibs(row.parent).indexOf(a.id) + 1] ?? null }
  if (!row.bus) return null
  return { parent: a.id, before: a.at === 'start' ? sibs(a.id)[0] ?? null : null }
}

/** Whether the track already sits in this slot (so moving it changes nothing). */
export function isInSlot(tracks: Track[], id: string, slot: Slot): boolean {
  const rows = treeRows(tracks)
  const me = rows.find((r) => r.id === id)
  if (!me || me.parent !== slot.parent) return false
  const all = rows.filter((r) => r.parent === slot.parent)
  const next = all[all.findIndex((r) => r.id === id) + 1]?.id ?? null
  return next === slot.before
}

/**
 * Move a track, or a bus with everything under it, into a slot: it joins that parent and is ordered between its new neighbours.
 * One undo step. False (nothing written) when the move is not possible (a bus into itself or its own subtree, a parent that is not a bus).
 */
export function moveTrack(doc: Y.Doc, id: string, slot: Slot): boolean {
  const tracks = getTracks(doc)
  if (!tracks.some((t) => t.id === id)) return false
  const parent = slot.parent
  if (parent !== MASTER_TRACK && tracks.find((t) => t.id === parent)?.kind !== 'bus') return false
  if (isInSlot(tracks, id, slot)) return true
  const sibs = (trackTree(tracks).get(parent) ?? []).filter((t) => t.id !== id)
  const at = slot.before == null ? -1 : sibs.findIndex((t) => t.id === slot.before)
  const i = at < 0 ? sibs.length : at
  return setParent(doc, id, parent === MASTER_TRACK ? null : parent, orderBetween(sibs[i - 1]?.order, sibs[i]?.order))
}

/** The buses a track could move into: every bus except itself and the ones below it. The master is always possible and is not listed. */
export function busTargets(tracks: Track[], id: string): Track[] {
  const rows = treeRows(tracks)
  const below = subtreeOf(rows, id)
  return rows.filter((r) => r.bus && !below.has(r.id)).map((r) => tracks.find((t) => t.id === r.id)!)
}

/** A bus at the track's place in the list (same parent, same spot) with the track as its only child. One undo step; returns the bus id. */
export function newBusFrom(doc: Y.Doc, trackId: string): string | null {
  const tracks = getTracks(doc)
  const t = tracks.find((x) => x.id === trackId)
  if (!t) return null
  let bus = ''
  doc.transact(() => {
    const up = effectiveParent(tracks).get(trackId) ?? MASTER_TRACK
    bus = addBus(doc, `${t.name} bus`, t.order)
    updateTrack(doc, bus, { color: nextTrackColor(tracks) })
    if (up !== MASTER_TRACK) setParent(doc, bus, up)
    setParent(doc, trackId, bus, 1)
  })
  return bus
}

/** A new, empty bus at the end of the master's children (or of `parent`'s). */
export function newBus(doc: Y.Doc, parent: string = MASTER_TRACK): string {
  const tracks = getTracks(doc)
  let id = ''
  doc.transact(() => {
    id = addBus(doc, `bus ${tracks.filter((t) => t.kind === 'bus').length + 1}`, orderBetween((trackTree(tracks).get(parent) ?? []).at(-1)?.order))
    updateTrack(doc, id, { color: nextTrackColor(tracks) })
    if (parent !== MASTER_TRACK) setParent(doc, id, parent)
  })
  return id
}

/** Whether `id` names a track that is a bus (the doc, not the store). */
export const isBus = (doc: Y.Doc, id: string) => tracksMap(doc).get(id)?.get('kind') === 'bus'
