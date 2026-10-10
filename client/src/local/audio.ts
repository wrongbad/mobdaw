// Audio for local projects: the original file bytes, per project, in IndexedDB (browsers keep large Blobs on disk,
// not in memory). Content hash (SHA-256) is the key, as in the cloud, so a project's doc refers to audio the same way.

export type AudioRow = { project: string; hash: string; blob: Blob; mime: string; name: string; size: number }

const DB_NAME = 'mobdaw-local'
let dbp: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('audio', { keyPath: ['project', 'hash'] })
      store.createIndex('project', 'project')
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

export async function deleteProjectAudio(project: string) {
  // Keys are [project, hash]: this range is every key whose first part is `project`.
  await done((await store('readwrite')).delete(IDBKeyRange.bound([project, ''], [project, '\uffff'])))
}
