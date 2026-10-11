// Recorded takes in the document (docs/engine.md §9): finishing a take, crash recovery, and the incoming-take actions.
import { addAudioClip, addSample, addTrack, discardSample, getClips, getSamples, newId, samplesMap, setSampleStatus, tracksMap, type SampleMeta } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { analyzeAudio, peaksToBase64 } from './audio/probe'
import type { Captured } from './audio/recording'
import { encodeWav, placeTake } from './audio/wav'
import { deleteAudio, deleteTake, getAudio, listTakeRows, putAudio, putTakeRow, type TakeChunk, type TakeHeader } from './local/audio'
import { isLocalId } from './local/ids'
import { importFile, sha256Hex, uploadToProject } from './samples'

/** `me`: the signed-in account (null in a project on this device, where takes are never incoming). */
export type TakeCtx = { doc: Y.Doc; projectId: string; me: { id: number; name: string } | null; rate: number }
/** Origin for edits kept out of undo (the undo manager only tracks origin null). */
const UNDOABLE_NOT = 'takes'

export type TakeInfo = Pick<TakeHeader, 'trackId' | 'trackName'>

// A take's backup is locked (Web Locks) by the tab writing it, from the first chunk until it's saved or the tab goes away,
// so recovery (in this or another tab) only takes over backups nobody is writing.
const lockName = (take: string) => `mobdaw-take:${take}`
const locks = (): LockManager | undefined => (navigator as { locks?: LockManager }).locks

/**
 * Appends a take's header and chunks to on-device storage as they arrive (crash recovery). Failures only warn: recording
 * goes on. Call `release()` once the take is saved or abandoned.
 */
export function takeJournal(projectId: string, info: TakeInfo, rate: number, channels: number) {
  const take = newId()
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  void locks()?.request(lockName(take), () => held)
  let tail: Promise<void> = Promise.resolve()
  const put = (row: TakeHeader | TakeChunk) => void (tail = tail.then(() => putTakeRow(row)).catch((e) => console.warn('take backup:', e)))
  const base = { project: projectId, take, at: 0 }
  return {
    take,
    /** Once the first frame's timeline position is known. */
    header: (startPos: number, latency: number) => put({ ...base, seq: -1, at: Date.now(), ...info, rate, channels, startPos, latency }),
    chunk: (pcm: Int16Array, seq: number) => put({ ...base, seq, at: Date.now(), pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer }),
    discard: () => void (tail = tail.then(() => deleteTake(projectId, take)).catch(() => {})),
    settled: () => tail,
    release: () => release(),
  }
}

export type Finished = { hash: string; trackId: string; clipId: string }

/**
 * Turn a captured take into a clip on its track, as one undo step: placed by the latency formula, on a new track with the
 * same name if the track was deleted meanwhile. Local projects import it like any file; cloud projects stage it on this
 * device as an `incoming` sample (uploaded when the recorder chooses).
 */
export async function finishTake(c: TakeCtx, t: Pick<Captured, 'pcm' | 'channels' | 'startPos' | 'latency' | 'frames'> & TakeInfo, name = takeName()): Promise<Finished> {
  const { doc, projectId, rate } = c
  const wav = encodeWav(t.pcm, t.channels, rate)
  const file = new File([wav], `${name}.wav`, { type: 'audio/wav' })
  const place = placeTake(t.startPos, t.latency, t.frames)
  if (place.length <= 0) throw new Error('the take ended before the project start')
  let hash: string
  let meta: SampleMeta | null = null
  if (isLocalId(projectId)) hash = (await importFile(projectId, doc, file)).hash
  else {
    hash = await sha256Hex(file)
    await putAudio({ project: projectId, hash, blob: file, mime: file.type, name: file.name, size: file.size })
    const peaks = peaksToBase64((await analyzeAudio(file)).peaks)
    if (!c.me) throw new Error('sign in to record into a cloud project')
    meta = { hash, name, duration: t.frames / rate, size: file.size, mime: file.type, status: 'incoming', by: c.me.id, byName: c.me.name, peaks }
  }
  let trackId = t.trackId, clipId = ''
  doc.transact(() => {
    if (meta) addSample(doc, meta)
    if (!tracksMap(doc).has(trackId)) trackId = addTrack(doc, t.trackName)
    clipId = addAudioClip(doc, { trackId, sourceHash: hash, start: place.start, length: place.length, sourceOffset: place.sourceOffset })
  })
  return { hash, trackId, clipId }
}

const takeName = () => `take ${new Date().toLocaleTimeString([], { hour12: false })}`

/** Without Web Locks, a backup idle for this long is taken to be abandoned (a live take writes every second). */
const STALE_MS = 10_000

/** Run `fn` holding the take's lock, or don't run it (returns false) when another tab holds it. */
async function withTakeLock(take: string, rows: { at: number }[], fn: () => Promise<void>): Promise<boolean> {
  const lm = locks()
  if (!lm) {
    if (Date.now() - Math.max(...rows.map((r) => r.at)) < STALE_MS) return false
    await fn()
    return true
  }
  return lm.request(lockName(take), { ifAvailable: true }, async (lock) => !!lock && (await fn(), true))
}

/** Finish takes abandoned by a crash. Returns how many were recovered. */
export async function recoverTakes(c: TakeCtx): Promise<number> {
  const takes = new Map<string, { at: number }[]>()
  for (const r of await listTakeRows(c.projectId)) (takes.get(r.take) ?? takes.set(r.take, []).get(r.take)!).push(r)
  let n = 0
  for (const [take, seen] of takes) {
    await withTakeLock(take, seen, async () => {
      // Read again under the lock: the tab that wrote it may have added chunks since.
      const list = (await listTakeRows(c.projectId)).filter((r) => r.take === take)
      const head = list.find((r): r is TakeHeader => r.seq === -1)
      const chunks = list.filter((r): r is TakeChunk => r.seq >= 0).sort((a, b) => a.seq - b.seq)
      if (head && chunks.length && head.rate === c.rate) {
        const pcm = chunks.map((r) => new Int16Array(r.pcm))
        const frames = pcm.reduce((s, p) => s + p.length, 0) / head.channels
        try {
          await finishTake(c, { pcm, frames, channels: head.channels, startPos: head.startPos, latency: head.latency, trackId: head.trackId, trackName: head.trackName }, 'recovered take')
          n++
        } catch (e) {
          console.warn('take recovery:', e)
          return // keep the rows; try again next time
        }
      }
      await deleteTake(c.projectId, take)
    })
  }
  return n
}

/**
 * Drop our incoming takes that no clip plays any more (recorded, then undone). Only safe when this session has no undo
 * history that could bring them back: run it when the project opens.
 */
export function sweepUnusedTakes(c: TakeCtx) {
  const used = new Set(getClips(c.doc).flatMap((x) => (x.kind === 'audio' ? [x.sourceHash] : [])))
  for (const m of Object.values(getSamples(c.doc))) {
    if (!isMine(c, m) || used.has(m.hash)) continue
    c.doc.transact(() => samplesMap(c.doc).delete(m.hash), UNDOABLE_NOT)
    void deleteAudio(c.projectId, m.hash).catch(() => {})
  }
}


export const isMine = (c: TakeCtx, m: SampleMeta | undefined) => m?.status === 'incoming' && !!c.me && m.by === c.me.id
/** Whether this device still has the audio of an incoming take. */
export const hasStaged = async (projectId: string, hash: string) => !!(await getAudio(projectId, hash).catch(() => undefined))

/** Upload a staged take, then clear its `incoming` status so every engine fetches it. Throws 'not on this device' when it is gone. */
export async function uploadTake(c: TakeCtx, hash: string) {
  const row = await getAudio(c.projectId, hash)
  if (!row) throw new Error('this take is not on this device')
  await uploadToProject(c.projectId, row.blob, hash, row.mime, row.name)
  setSampleStatus(c.doc, hash, undefined)
  void deleteAudio(c.projectId, hash).catch(() => {}) // the cloud has it now
}

/** Our incoming takes that some clip plays (an undone take's sample lingers until the next open: never upload it). */
export function myTakes(c: TakeCtx) {
  const used = new Set(getClips(c.doc).flatMap((x) => (x.kind === 'audio' ? [x.sourceHash] : [])))
  return Object.values(getSamples(c.doc)).filter((m) => isMine(c, m) && used.has(m.hash))
}

/** Upload every take of mine that is still incoming. Returns how many went up and how many were not on this device. */
export async function uploadAll(c: TakeCtx) {
  let up = 0, gone = 0
  for (const m of myTakes(c)) {
    try {
      await uploadTake(c, m.hash)
      up++
    } catch (e) {
      if (!(await hasStaged(c.projectId, m.hash))) gone++
      else throw e
    }
  }
  return { up, gone }
}

/** Delete the sample and every clip using it (anyone may; confirm first), and the staged copy if it is here. Not undoable. */
export function discardTake(c: TakeCtx, hash: string) {
  discardSample(c.doc, hash, UNDOABLE_NOT)
  void deleteAudio(c.projectId, hash).catch(() => {})
}
