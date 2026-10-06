import { addSample, type SampleMeta, type UploadUrlRequest } from '@mobdaw/shared'
import { createSHA256 } from 'hash-wasm'
import type * as Y from 'yjs'
import { api, ApiError } from './api'
import { getCtx } from './audio/engine'

const mem = new Map<string, AudioBuffer>()
const inflight = new Map<string, Promise<AudioBuffer>>()
const CACHE = 'mobdaw-samples'
const key = (hash: string) => new Request(`/sample/${hash}`)

export const peekBuffer = (hash: string) => mem.get(hash)

async function cacheOpen() {
  return typeof caches !== 'undefined' ? caches.open(CACHE).catch(() => null) : null
}

async function decode(bytes: ArrayBuffer, hash: string) {
  const buf = await getCtx().decodeAudioData(bytes)
  mem.set(hash, buf)
  return buf
}

export function getSampleBuffer(projectId: string, hash: string): Promise<AudioBuffer> {
  const hit = mem.get(hash)
  if (hit) return Promise.resolve(hit)
  let p = inflight.get(hash)
  if (!p) {
    p = (async () => {
      const cache = await cacheOpen()
      let res = await cache?.match(key(hash))
      if (!res) {
        const { url } = await api.sampleUrl(projectId, hash)
        res = await fetch(url)
        if (!res.ok) throw new Error(`sample ${hash.slice(0, 8)}: HTTP ${res.status}`)
        await cache?.put(key(hash), res.clone()).catch(() => {})
      }
      return decode(await res.arrayBuffer(), hash)
    })().finally(() => inflight.delete(hash))
    inflight.set(hash, p)
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
async function sha256Hex(file: File) {
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

/** A hash being garbage-collected answers 409 until its object is gone: retry a few times. */
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

/** Hash, upload if needed, and record metadata in the doc. Returns the sample meta. */
export async function importFile(projectId: string, doc: Y.Doc, file: File): Promise<SampleMeta> {
  const duration = await probeDuration(file) // fail fast on non-audio, before uploading
  const hash = await sha256Hex(file)
  const mime = file.type || 'application/octet-stream'
  const up = await requestUpload(projectId, { hash, size: file.size, mime })
  if (!up.exists) {
    // Passing the File lets the browser stream it from disk.
    const res = await fetch(up.url, { method: up.method, headers: up.headers, body: file })
    if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`)
    await api.completeSample(projectId, hash) // also links it into this project's library
  }
  if (playable(file)) {
    const cache = await cacheOpen()
    await cache?.put(key(hash), new Response(file, { headers: { 'content-type': mime } })).catch(() => {})
  }
  const meta: SampleMeta = { hash, name: file.name.replace(/\.[^.]+$/, ''), duration, size: file.size, mime }
  addSample(doc, meta)
  return meta
}
