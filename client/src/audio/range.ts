// What an export covers: the audible part of the timeline.
import { clipLength, clipStart, getClips, getPads, getTimeMap, getTracks } from '@mobdaw/shared'
import type * as Y from 'yjs'

/**
 * The tracks that can be heard: not muted, and, when any track is soloed, soloed or a click track (the metronome ignores
 * solo, but its own mute counts). Soundscape source clips live in their own time, so only their pads place them on the timeline.
 */
function audibleBlocks(doc: Y.Doc) {
  const map = getTimeMap(doc) // MIDI clips sit in musical time: their samples come from the project's tempo map
  const tracks = getTracks(doc)
  const anySolo = tracks.some((t) => t.soloed)
  const audible = new Set(tracks.filter((t) => !t.muted && (!anySolo || t.soloed || t.role === 'click')).map((t) => t.id))
  const scapes = new Set(tracks.filter((t) => t.kind === 'soundscape').map((t) => t.id))
  return [
    ...getClips(doc).filter((c) => audible.has(c.trackId) && !scapes.has(c.trackId)).map((c) => ({ start: clipStart(c, map), end: clipStart(c, map) + clipLength(c, map) })),
    ...getPads(doc).filter((p) => audible.has(p.trackId)).map((p) => ({ start: p.start, end: p.start + p.length })),
  ]
}

/** Where the audible sound ends (samples): the end of the last clip or pad on an audible track. A looping MIDI clip counts in full. */
export const contentEnd = (doc: Y.Doc, _rate?: number) => Math.max(0, ...audibleBlocks(doc).map((b) => b.end))

/** Where the audible sound starts (samples): the earliest clip or pad start on an audible track (0 when there is none). */
export function contentStart(doc: Y.Doc, _rate?: number) {
  const blocks = audibleBlocks(doc)
  return blocks.length ? Math.max(0, Math.min(...blocks.map((b) => b.start))) : 0
}
