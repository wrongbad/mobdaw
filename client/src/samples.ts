import { addSample, type SampleMeta, type UploadUrlRequest } from '@mobdaw/shared'
import { createSHA256 } from 'hash-wasm'
import type * as Y from 'yjs'
import { api, ApiError } from './api'
import { getCtx } from './audio/context'
import { analyzeAudio, peaksToBase64 } from './audio/probe'
import { getAudio, putAudio } from './local/audio'
import { isLocalId } from './local/ids'

const mem = new Map<string, AudioBuffer>()
const inflight = new Map<string, Promise<AudioBuffer>>()
const CACHE = 'mobdaw-samples'
const key = (hash: string) => new Request(`/sample/${hash}`)
const memKey = (hash: string, rate: number) => `${rate}:${hash}`

async function cacheOpen() {
  return typeof caches !== 'undefined' ? caches.open(CACHE).catch(() => null) : null
}

// decodeAudioData resamples to the context's rate, so decoding on the project-rate context
// yields buffers at the project rate (temporary path until the milestone-3 import pipeline).
async function decode(bytes: ArrayBuffer, hash: string, rate: number) {
  const buf = await getCtx(rate).decodeAudioData(bytes)
  mem.set(memKey(hash, rate), buf)
  return buf
}

/** `staged`: an incoming take, which is only in this device's store, even in a cloud project. */
export function getSampleBuffer(projectId: string, hash: string, rate: number, staged = false): Promise<AudioBuffer> {
  const mk = memKey(hash, rate)
  const hit = mem.get(mk)
  if (hit) return Promise.resolve(hit)
  let p = inflight.get(mk)
  if (!p) {
    p = (async () => {
      if (staged || isLocalId(projectId)) {
        const row = await getAudio(projectId, hash)
        if (!row) throw new Error(`sample ${hash.slice(0, 8)}: missing from this device`)
        return decode(await row.blob.arrayBuffer(), hash, rate)
      }
      const cache = await cacheOpen()
      let res = await cache?.match(key(hash))
      if (!res) {
        const { url } = await api.sampleUrl(projectId, hash)
        res = await fetch(url)
        if (!res.ok) throw new Error(`sample ${hash.slice(0, 8)}: HTTP ${res.status}`)
        await cache?.put(key(hash), res.clone()).catch(() => {})
      }
      return decode(await res.arrayBuffer(), hash, rate)
    })().finally(() => inflight.delete(mk))
    inflight.set(mk, p)
  }
  return p
}

/**
 * Playback decodes a whole sample into memory (~1.3 GB per hour of 44.1k stereo), so long
 * recordings can be imported and shared but not played until the engine streams.
 */
export const PLAYBACK_MAX_BYTES = 200 * 1024 * 1024
export const playable = (m: Pick<SampleMeta, 'size'>) => m.size <= PLAYBACK_MAX_BYTES

/** Incremental SHA-256: files can be GBs, so never hold the whole thing in memory. */
export async function sha256Hex(file: Blob) {
  const h = await createSHA256()
  const CHUNK = 16 * 1024 * 1024
  for (let i = 0; i < file.size; i += CHUNK) h.update(new Uint8Array(await file.slice(i, i + CHUNK).arrayBuffer()))
  return h.digest('hex')
}

/** Duration from the container header via a media element; no full decode. */
function probeDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const a = new Audio()
    const done = () => URL.revokeObjectURL(url)
    a.preload = 'metadata'
    a.onloadedmetadata = () => (done(), Number.isFinite(a.duration) ? resolve(a.duration) : reject(new Error('unknown duration')))
    a.onerror = () => (done(), reject(new Error('unsupported audio file')))
    a.src = url
  })
}

/** A hash being deleted answers 409 until its bytes are gone: retry a few times. */
async function requestUpload(projectId: string, req: UploadUrlRequest) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.uploadUrl(projectId, req)
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'sample_deleting') || attempt >= 3) throw e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

/**
 * Make sure `blob` is in the cloud project's library, uploading it only if the server needs the bytes. Every user
 * owns their own upload of a file, so this also records it under the signed-in account (and charges their storage).
 */
export async function uploadToProject(projectId: string, blob: Blob, hash: string, mime: string, name: string) {
  const up = await requestUpload(projectId, { hash, size: blob.size, mime, name })
  if (up.exists) return
  // Passing the Blob lets the browser stream it from disk.
  const res = await fetch(up.url, { method: up.method, headers: up.headers, body: blob })
  if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`)
  await api.completeSample(projectId, hash) // also links it into this project's library
  void saveAnalysis(hash, blob)
}

/** Measure a file and cache the result on its upload (shown on the uploads page). Best effort: the page does it later if this fails. */
export async function saveAnalysis(hash: string, blob: Blob) {
  try {
    const a = await analyzeAudio(blob)
    await api.saveAnalysis(hash, { info: a.info, peaks: peaksToBase64(a.peaks) })
  } catch {}
}

export const sampleName = (file: { name: string }) => file.name.replace(/\.[^.]+$/, '')

/** Hash it, store it (on this device, or in the cloud), and record its metadata in the doc. Returns the sample meta. */
export async function importFile(projectId: string, doc: Y.Doc, file: File): Promise<SampleMeta> {
  const duration = await probeDuration(file) // fail fast on non-audio, before uploading
  const hash = await sha256Hex(file)
  const mime = file.type || 'application/octet-stream'
  if (isLocalId(projectId)) {
    await putAudio({ project: projectId, hash, blob: file, mime, name: file.name, size: file.size })
  } else {
    await uploadToProject(projectId, file, hash, mime, file.name)
    if (playable(file)) {
      const cache = await cacheOpen()
      await cache?.put(key(hash), new Response(file, { headers: { 'content-type': mime } })).catch(() => {})
    }
  }
  const meta: SampleMeta = { hash, name: sampleName(file), duration, size: file.size, mime }
  addSample(doc, meta)
  return meta
}
