// The Yjs maps as Solid stores: one `createStore` per map, keyed by id, patched from that map's observeDeep with only the
// entities that changed, so every other entity keeps its object (and its subscribers stay quiet).
// Components read the derived accessors; the doc stays the single source of truth (all writes go through the schema mutators).
import {
  MIX, type AwarenessState, type Clip, type Device, type Lane, type Looper, type Note, type Pad, type Point, type SampleMeta, type Track,
  clipsMap, devicesMap, lanesMap, loopersMap, notesMap, padsMap, pointsMap, samplesMap, tracksMap,
} from '@mobdaw/shared'
import { batch, createMemo, createRoot, createSignal, getOwner, runWithOwner, type Accessor } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

type Entity = { id: string }
type YM = Y.Map<unknown>

const EMPTY: never[] = []
const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** One map mirrored into a store. `keep` drops entities the schema getters drop (a half-made clip, a lane with no owner). */
function mirror<T extends Entity>(map: Y.Map<any>, keep: (v: T) => boolean = () => true) {
  const [store, set] = createStore<Record<string, T>>({})
  const read = (id: string): T | undefined => {
    const v = map.get(id)
    if (v == null) return undefined
    const j = (typeof v === 'object' && 'toJSON' in v ? (v as YM).toJSON() : structuredClone(v)) as T
    return keep(j) ? j : undefined
  }
  const sync = (ids: Iterable<string>) => batch(() => {
    for (const id of ids) {
      const v = read(id)
      if (v === undefined) {
        if (id in store) set(id, undefined as never) // (setting undefined deletes the key)
      } else set(id, reconcile(v, { merge: true }))
    }
  })
  sync(map.keys())
  /** observeDeep: a change to the map itself names the ids; a change inside an entity has the id first in its path. */
  const observer = (events: Y.YEvent<any>[]) => {
    const ids = new Set<string>()
    for (const e of events) {
      if (e.target === map) for (const k of e.keys.keys()) ids.add(k)
      else if (typeof e.path[0] === 'string') ids.add(e.path[0])
    }
    sync(ids)
  }
  map.observeDeep(observer)
  return { store, off: () => map.unobserveDeep(observer) }
}

export type ProjectStore = ReturnType<typeof createProjectStore>

/** `s`: the doc and its awareness (the peers' states are read through `remoteStates`, which leaves our own out). */
export function createProjectStore(s: { doc: Y.Doc; awareness: Pick<Awareness, 'on' | 'off'>; remoteStates(): AwarenessState[] }) {
  const { doc } = s
  return createRoot((disposeRoot) => {
    const owner = getOwner()!
    const tracks_ = mirror<Track>(tracksMap(doc))
    const clips_ = mirror<Clip>(clipsMap(doc), (c) => c.kind === 'audio' || c.kind === 'midi')
    const notes_ = mirror<Note>(notesMap(doc))
    const devices_ = mirror<Device>(devicesMap(doc))
    const loopers_ = mirror<Looper>(loopersMap(doc))
    const pads_ = mirror<Pad>(padsMap(doc))
    const lanes_ = mirror<Lane>(lanesMap(doc), (l) => l.owner != null)
    const points_ = mirror<Point>(pointsMap(doc))
    const samples_ = mirror<SampleMeta & Entity>(samplesMap(doc) as Y.Map<any>)
    const mirrors = [tracks_, clips_, notes_, devices_, loopers_, pads_, lanes_, points_, samples_]

    /** The entities in a given order; the list only changes when its members or their order do. */
    const list = <T extends Entity>(store: Record<string, T>, cmp?: (a: T, b: T) => number) =>
      createMemo(() => {
        const all = Object.values(store)
        return cmp ? all.sort(cmp) : all
      }, EMPTY as T[], { equals: sameList })

    const tracks = list(tracks_.store, (a, b) => a.order - b.order)
    const clips = list(clips_.store)
    const notes = list(notes_.store)
    const devices = list(devices_.store, (a, b) => a.order - b.order)
    const loopers = list(loopers_.store, (a, b) => a.slot - b.slot)
    const pads = list(pads_.store, (a, b) => a.start - b.start)
    const lanes = list(lanes_.store, (a, b) => a.order - b.order)
    const points = list(points_.store)

    /** A group of a list by a key, as one memo per key (made on first use) that only fires when that group's members change. */
    const grouped = <T extends Entity>(all: Accessor<T[]>, key: (x: T) => string) => {
      const groups = createMemo(() => {
        const m = new Map<string, T[]>()
        for (const x of all()) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x)
        return m
      })
      const memos = new Map<string, Accessor<T[]>>()
      return (id: string) => {
        let m = memos.get(id)
        if (!m) memos.set(id, (m = runWithOwner(owner, () => createMemo(() => groups().get(id) ?? (EMPTY as T[]), undefined, { equals: sameList }))!))
        return m
      }
    }
    const devicesByTrack = grouped(devices, (d) => d.trackId)
    const clipsByTrack = grouped(clips, (c) => c.trackId)
    const notesByClip = grouped(notes, (n) => n.clipId)
    const pointsByLane = grouped(points, (p) => p.laneId)

    // the peers' awareness states (not ours): set on every change, so readers see playheads, drags and recordings as they come
    const [remote, setRemote] = createSignal<AwarenessState[]>(s.remoteStates(), { equals: false })
    const onAware = () => setRemote(s.remoteStates())
    s.awareness.on('change', onAware)
    /** Who is recording on which track (someone else): track id -> username. */
    const locks = createMemo(() => new Map(remote().flatMap((r) => (r.recording ? [[r.recording.trackId, r.user.username] as [string, string]] : []))),
      undefined, { equals: (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v) })

    /** The peers' in-progress knob drags: what goes to the engine as overrides (only fires when a drag changes), and per device, param -> value. */
    type Drag = { deviceId: string; paramId: number; value: number }
    const overrides = createMemo(() => remote().flatMap((r) => [r.dragging ?? []].flat()) as Drag[], [] as Drag[],
      { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
    const dragsByDevice = createMemo(() => {
      const m = new Map<string, Map<number, number>>()
      for (const d of overrides()) (m.get(d.deviceId) ?? m.set(d.deviceId, new Map()).get(d.deviceId)!).set(d.paramId, d.value)
      return m
    })
    const dragMemos = new Map<string, Accessor<Map<number, number>>>()
    const NO_DRAGS = new Map<number, number>()
    const sameDrags = (a: Map<number, number>, b: Map<number, number>) => a === b || (a.size === b.size && [...a].every(([k, v]) => b.get(k) === v))
    const drags = (deviceId: string) => {
      let m = dragMemos.get(deviceId)
      if (!m) dragMemos.set(deviceId, (m = runWithOwner(owner, () => createMemo(() => dragsByDevice().get(deviceId) ?? NO_DRAGS, undefined, { equals: sameDrags }))!))
      return m
    }

    return {
      overrides, drags,
      /** The entities by id (stores: read inside an effect or memo to follow one field). */
      trackById: tracks_.store, clipById: clips_.store, noteById: notes_.store, deviceById: devices_.store, looperById: loopers_.store,
      padById: pads_.store, laneById: lanes_.store, pointById: points_.store, samples: samples_.store as Record<string, SampleMeta>,
      /** Sorted as the schema getters sort them. */
      tracks, clips, notes, devices, loopers, pads, lanes, points,
      devicesByTrack, clipsByTrack, notesByClip, pointsByLane,
      /** A track's mix device (its fader and pan), or the master bus's. */
      mixDevice: (scope: string) => devicesByTrack(scope)().find((d) => d.type === MIX),
      remote, locks,
      dispose() {
        s.awareness.off('change', onAware)
        mirrors.forEach((m) => m.off())
        disposeRoot()
      },
    }
  })
}
