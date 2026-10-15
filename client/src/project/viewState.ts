// Local UI state of the timeline (never in the doc): which drawers are open, and what is selected.
// The clearing rules that used to be spread over the pointerdown / Escape / delete handlers live here.
import { createSignal, type Accessor, type Setter } from 'solid-js'

/** The drawers a track's header tabs open (global fx lives under MASTER_TRACK). */
export type TabName = 'source' | 'synth' | 'loopers' | 'fx' | 'auto' | 'presets'

const TABS: TabName[] = ['source', 'synth', 'loopers', 'fx', 'auto', 'presets']

/** A boolean per key that components can follow: reading it inside an effect or binding subscribes to that key only. */
function flags() {
  const sigs = new Map<string, [Accessor<boolean>, Setter<boolean>]>()
  const at = (k: string) => sigs.get(k) ?? sigs.set(k, createSignal(false)).get(k)!
  return { get: (k: string) => at(k)[0](), set: (k: string, v: boolean) => void (at(k)[0]() === v || at(k)[1](v)) }
}

/** Open drawers per track (or scope) id; all are closed by default. Reactive per (id, tab), so a header's tabs follow without a draw. */
export function createDrawers() {
  const open = flags()
  const key = (id: string, tab: TabName) => `${id}\0${tab}`
  return {
    isOpen: (id: string, tab: TabName) => open.get(key(id, tab)),
    /** Open it if shut, shut it if open; returns whether it is now open. */
    toggle(id: string, tab: TabName) {
      const now = !open.get(key(id, tab))
      open.set(key(id, tab), now)
      return now
    },
    open: (id: string, tab: TabName) => open.set(key(id, tab), true),
    closeAll: (id: string) => TABS.forEach((t) => open.set(key(id, t), false)),
  }
}

/**
 * Which optional tabs a header shows (the others always do): `auto` once the scope has a lane to open, `presets` once the
 * track has any. The draw sets them from the doc; the headers follow.
 */
export function createTabAvailability() {
  const f = flags()
  return {
    has: (id: string, tab: 'auto' | 'presets') => f.get(`${id}\0${tab}`),
    set: (id: string, tab: 'auto' | 'presets', v: boolean) => f.set(`${id}\0${tab}`, v),
  }
}

export type Drawers = ReturnType<typeof createDrawers>

/** What is selected or being edited. The fields are read directly; every change goes through a method. */
export function createSelection() {
  return {
    clips: [] as string[],
    editing: null as string | null, // MIDI clip zoomed into its note editor
    note: null as string | null,
    pad: null as string | null, // selected soundscape region
    armedLooper: null as string | null, // looper whose region is being drawn

    /** The clip selection changed (the caller publishes it). */
    selectClips(ids: string[]) { this.clips = ids },
    /** Pointer down on an empty MIDI / audio lane: everything but the armed looper is let go. */
    clickEmptyLane() { this.editing = this.note = this.pad = null; this.clips = [] },
    /** Pointer down on an empty soundscape lane. */
    clickEmptySource() { this.pad = null; this.clips = [] },
    /** Pointer down on a soundscape region. */
    selectPad(id: string) { this.editing = this.note = null; this.pad = id; this.clips = [] },
    /** Pointer down on a clip (the caller then selects it). */
    pressClip() { this.note = this.pad = null },
    /** A click on a MIDI clip zooms into its editor, or back out if it is the open one. */
    toggleEditing(id: string) { this.editing = this.editing === id ? null : id },
    selectNote(id: string | null) { this.note = id },
    toggleArm(id: string) { this.armedLooper = this.armedLooper === id ? null : id },
    /** Escape: leaves the editor, the armed looper, the pad and the note; returns whether it had anything to leave. */
    escape() {
      if (!(this.editing || this.armedLooper || this.pad)) return false
      this.editing = this.note = this.armedLooper = this.pad = null
      return true
    },
    /** Delete / backspace: a selected note goes first, then a pad (cleared here; the caller deletes it), else the clips. */
    takeDelete(): { note: string } | { pad: string } | null {
      const { note, pad } = this
      if (note) return this.note = null, { note }
      if (pad) return this.pad = null, { pad }
      return null
    },
    forgetPad(id: string) { if (this.pad === id) this.pad = null },
    forgetLooper(id: string) { if (this.armedLooper === id) this.armedLooper = null },
    /** The drawn region was set: the looper is no longer armed. */
    doneDrawing() { this.armedLooper = null },
    /** Drop whatever points at something that has gone from the doc (each is called where the draw notices). */
    pruneClips(has: (id: string) => boolean) { this.clips = this.clips.filter(has) },
    pruneEditing(isMidi: (id: string) => boolean) { if (this.editing && !isMidi(this.editing)) this.editing = null },
    prunePad(has: (id: string) => boolean) { if (this.pad && !has(this.pad)) this.pad = null },
    pruneNote(has: (id: string) => boolean) { if (this.note && !has(this.note)) this.note = null },
  }
}

export type Selection = ReturnType<typeof createSelection>

/** What a scope's mix device is driven to by its automation lanes at the playhead (null: not driven, the doc's value shows). */
export type MixDrive = { gain: number | null; pan: number | null }
const UNDRIVEN: MixDrive = { gain: null, pan: null }

/** The automation-driven fader and pan per scope, as signals: written every frame while a lane plays, read by the headers' bindings. */
export function createMixDrive() {
  const sigs = new Map<string, [Accessor<MixDrive>, Setter<MixDrive>]>()
  const at = (scope: string) => sigs.get(scope) ?? sigs.set(scope, createSignal(UNDRIVEN)).get(scope)!
  return {
    get: (scope: string) => at(scope)[0](),
    /** Only a change fires. */
    set(scope: string, drive: MixDrive) {
      const [get, set] = at(scope)
      if (get().gain !== drive.gain || get().pan !== drive.pan) set(drive)
    },
  }
}

/** What a param is driven to by its lane at the playhead (null `value`: the lane gives nothing, e.g. an LFO). */
export type AutoInfo = { on: boolean; value: number | null }
const NO_AUTO: ReadonlyMap<string, AutoInfo> = new Map()
const sameInfos = (a: ReadonlyMap<string, AutoInfo>, b: ReadonlyMap<string, AutoInfo>) =>
  a === b || (a.size === b.size && [...a].every(([k, v]) => b.get(k)?.on === v.on && b.get(k)?.value === v.value))

/**
 * What the automation lanes drive each device or looper's params to (owner id -> param -> info), as one signal per owner:
 * written every frame while a lane plays, read by the cards. Only a change fires, so a card whose lanes hold still stays quiet.
 */
export function createAutoValues() {
  const sigs = new Map<string, [Accessor<ReadonlyMap<string, AutoInfo>>, Setter<ReadonlyMap<string, AutoInfo>>]>()
  const at = (owner: string) => sigs.get(owner) ?? sigs.set(owner, createSignal(NO_AUTO)).get(owner)!
  return {
    get: (owner: string) => at(owner)[0](),
    /** The new reading of every driven owner; owners it leaves out go back to undriven. */
    publish(next: ReadonlyMap<string, ReadonlyMap<string, AutoInfo>>) {
      for (const [owner, [get, set]] of sigs) {
        const n = next.get(owner) ?? NO_AUTO
        if (!sameInfos(get(), n)) set(n)
      }
      for (const [owner, n] of next) if (!sigs.has(owner)) at(owner)[1](n)
    },
  }
}
export type AutoValues = ReturnType<typeof createAutoValues>
