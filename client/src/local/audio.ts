// Audio for local projects: the original file bytes, per project, in IndexedDB (browsers keep large Blobs on disk,
// not in memory). Content hash (SHA-256) is the key, as in the cloud, so a project's doc refers to audio the same way.

export type AudioRow = { project: string; hash: string; blob: Blob; mime: string; name: string; size: number }

const DB_NAME = 'mobdaw-local'
let dbp: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = (ev) => {
      if (ev.oldVersion < 1) {
        const store = req.result.createObjectStore('audio', { keyPath: ['project', 'hash'] })
        store.createIndex('project', 'project')
      }
      if (ev.oldVersion < 2) req.result.createObjectStore('takes', { keyPath: ['project', 'take', 'seq'] }).createIndex('project', 'project')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

const store = async (mode: IDBTransactionMode) => (await open()).transaction('audio', mode).objectStore('audio')

/** Turn a browser storage failure into something a person can act on. */
export function storageError(e: unknown): Error {
  const name = (e as DOMException)?.name
  if (name === 'QuotaExceededError') return new Error('Your browser has no room left for this file. Delete some local audio or free up disk space.')
  return e instanceof Error ? e : new Error(String(e))
}

export async function putAudio(row: AudioRow) {
  try {
    await done((await store('readwrite')).put(row))
  } catch (e) {
    throw storageError(e)
  }
}

export async function getAudio(project: string, hash: string): Promise<AudioRow | undefined> {
  return done((await store('readonly')).get([project, hash]))
}

export async function listAudio(project: string): Promise<AudioRow[]> {
  return done((await store('readonly')).index('project').getAll(project))
}

export async function deleteAudio(project: string, hash: string) {
  await done((await store('readwrite')).delete([project, hash]))
}

export async function deleteProjectAudio(project: string) {
  // Keys are [project, hash]: this range is every key whose first part is `project`.
  await done((await store('readwrite')).delete(IDBKeyRange.bound([project, ''], [project, '\uffff'])))
  // ...and its takes' backups ([project, take, seq]).
  await done((await takeStore('readwrite')).delete(IDBKeyRange.bound([project], [project, []])))
}

// --- takes being recorded: chunks are appended as they arrive, so a crashed tab can recover the take (docs/engine.md §9.2).
// seq -1 is the take's header; seq 0.. are consecutive chunks of interleaved 16-bit PCM.
export type TakeHeader = {
  project: string; take: string; seq: -1; at: number
  trackId: string; trackName: string; rate: number; channels: number
  /** Timeline sample of the first captured frame, and the input/output delay (samples) to move the clip back by. */
  startPos: number; latency: number
}
export type TakeChunk = { project: string; take: string; seq: number; at: number; pcm: ArrayBuffer }

const takeStore = async (mode: IDBTransactionMode) => (await open()).transaction('takes', mode).objectStore('takes')

export async function putTakeRow(row: TakeHeader | TakeChunk) {
  try {
    await done((await takeStore('readwrite')).put(row))
  } catch (e) {
    throw storageError(e)
  }
}

export async function listTakeRows(project: string): Promise<(TakeHeader | TakeChunk)[]> {
  return done((await takeStore('readonly')).index('project').getAll(project))
}

export async function deleteTake(project: string, take: string) {
  await done((await takeStore('readwrite')).delete(IDBKeyRange.bound([project, take, -1], [project, take, Infinity])))
}
