// Yjs document schema for a project. Times are in seconds.
//   meta    Y.Map  { bpm }
//   tracks  Y.Map  trackId -> Y.Map { id, name, order, gain, muted }
//   clips   Y.Map  clipId  -> Y.Map { id, trackId, sampleHash, start, offset, duration, gain }
//   samples Y.Map  hash    -> plain object SampleMeta
import * as Y from 'yjs'

export type Track = { id: string; name: string; order: number; gain: number; muted: boolean }
export type Clip = {
  id: string
  trackId: string
  sampleHash: string
  start: number
  offset: number
  duration: number
  gain: number
}
export type SampleMeta = { hash: string; name: string; duration: number; size: number; mime: string }

export type AwarenessState = {
  user: { email: string; name: string; color: string }
  playhead?: number | null
  selection?: string[]
}

export const DEFAULT_BPM = 120

export const docName = (projectId: string) => `project:${projectId}`

export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9))
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_') // 12 url-safe chars
}

export function userColor(email: string): string {
  let h = 0
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 65% 62%)`
}

export const metaMap = (doc: Y.Doc) => doc.getMap<unknown>('meta')
export const tracksMap = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('tracks')
export const clipsMap = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('clips')
export const samplesMap = (doc: Y.Doc) => doc.getMap<SampleMeta>('samples')

/** Types to pass to `new Y.UndoManager(undoScope(doc), { trackedOrigins })`. */
export const undoScope = (doc: Y.Doc) => [metaMap(doc), tracksMap(doc), clipsMap(doc)]

const toObj = <T>(m: Y.Map<unknown>) => m.toJSON() as T

export function getTracks(doc: Y.Doc): Track[] {
  return [...tracksMap(doc).values()].map((m) => toObj<Track>(m)).sort((a, b) => a.order - b.order)
}
export function getClips(doc: Y.Doc): Clip[] {
  return [...clipsMap(doc).values()].map((m) => toObj<Clip>(m))
}
export const getSamples = (doc: Y.Doc): Record<string, SampleMeta> => samplesMap(doc).toJSON()
export const getBpm = (doc: Y.Doc): number => (metaMap(doc).get('bpm') as number | undefined) ?? DEFAULT_BPM
export const setBpm = (doc: Y.Doc, bpm: number) => metaMap(doc).set('bpm', bpm)

/** Fractional order value that sorts between `before` and `after` (either may be undefined). */
export function orderBetween(before?: number, after?: number): number {
  if (before == null && after == null) return 1
  if (before == null) return after! - 1
  if (after == null) return before + 1
  return (before + after) / 2
}

export function addTrack(doc: Y.Doc, name: string, order?: number): string {
  const id = newId()
  const tracks = getTracks(doc)
  const t: Track = { id, name, order: order ?? orderBetween(tracks.at(-1)?.order), gain: 1, muted: false }
  doc.transact(() => tracksMap(doc).set(id, new Y.Map(Object.entries(t))))
  return id
}

export function updateTrack(doc: Y.Doc, id: string, patch: Partial<Omit<Track, 'id'>>) {
  const m = tracksMap(doc).get(id)
  if (!m) return
  doc.transact(() => Object.entries(patch).forEach(([k, v]) => m.set(k, v)))
}

export function deleteTrack(doc: Y.Doc, id: string) {
  doc.transact(() => {
    for (const c of getClips(doc)) if (c.trackId === id) clipsMap(doc).delete(c.id)
    tracksMap(doc).delete(id)
  })
}

export function addSample(doc: Y.Doc, s: SampleMeta) {
  samplesMap(doc).set(s.hash, s)
}

export function addClip(
  doc: Y.Doc,
  c: Pick<Clip, 'trackId' | 'sampleHash' | 'start' | 'duration'> & Partial<Pick<Clip, 'offset' | 'gain'>>,
): string {
  const id = newId()
  const clip: Clip = { id, offset: 0, gain: 1, ...c }
  doc.transact(() => clipsMap(doc).set(id, new Y.Map(Object.entries(clip))))
  return id
}

export function updateClip(doc: Y.Doc, id: string, patch: Partial<Omit<Clip, 'id'>>) {
  const m = clipsMap(doc).get(id)
  if (!m) return
  doc.transact(() => Object.entries(patch).forEach(([k, v]) => m.set(k, v)))
}

/** Move a clip in time and optionally to another track. */
export function moveClip(doc: Y.Doc, id: string, start: number, trackId?: string) {
  updateClip(doc, id, trackId ? { start, trackId } : { start })
}

/** Change the clip's duration (right-edge trim) and optionally its source offset. */
export function trimClip(doc: Y.Doc, id: string, duration: number, offset?: number) {
  updateClip(doc, id, offset == null ? { duration } : { duration, offset })
}

export function deleteClip(doc: Y.Doc, id: string) {
  clipsMap(doc).delete(id)
}
