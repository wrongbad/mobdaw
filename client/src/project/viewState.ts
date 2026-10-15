// Local UI state of the timeline (never in the doc): which drawers are open, and what is selected.
// The clearing rules that used to be spread over the pointerdown / Escape / delete handlers live here.

/** The drawers a track's header tabs open (global fx lives under MASTER_TRACK). */
export type TabName = 'source' | 'synth' | 'loopers' | 'fx' | 'auto' | 'presets'

/** Open drawers per track (or scope) id; all are closed by default. */
export function createDrawers() {
  const open = new Map<string, Set<TabName>>()
  return {
    isOpen: (id: string, tab: TabName) => open.get(id)?.has(tab) ?? false,
    /** Open it if shut, shut it if open; returns whether it is now open. */
    toggle(id: string, tab: TabName) {
      const set = open.get(id) ?? open.set(id, new Set()).get(id)!
      if (set.delete(tab)) return false
      set.add(tab)
      return true
    },
    open(id: string, tab: TabName) {
      if (!open.has(id)) open.set(id, new Set())
      open.get(id)!.add(tab)
    },
    closeAll: (id: string) => void open.delete(id),
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
