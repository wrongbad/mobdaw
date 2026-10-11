// The list of projects on this device. Each project's document is persisted by y-indexeddb (see session.ts) and its audio
// by audio.ts. The list itself is small, so it lives in localStorage (with an in-memory fallback if that is blocked).
import { deleteProjectAudio } from './audio'
import { docDb, newLocalId } from './ids'

export type LocalProject = { id: string; name: string; createdAt: number; updatedAt: number }

const KEY = 'mobdaw.local.projects'
let memory: LocalProject[] = []

function read(): LocalProject[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as LocalProject[]
  } catch {}
  return memory
}

function write(all: LocalProject[]) {
  memory = all
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {}
}

export const listLocal = () => [...read()].sort((a, b) => b.updatedAt - a.updatedAt)
export const getLocal = (id: string) => read().find((p) => p.id === id)

export function createLocal(name: string): LocalProject {
  const now = Date.now()
  const p = { id: newLocalId(), name: name.trim() || 'untitled', createdAt: now, updatedAt: now }
  write([...read(), p])
  // Ask the browser not to evict this device's projects under storage pressure (best effort).
  void navigator.storage?.persist?.().catch(() => {})
  return p
}

export function renameLocal(id: string, name: string) {
  write(read().map((p) => (p.id === id ? { ...p, name: name.trim() || p.name, updatedAt: Date.now() } : p)))
}

export function touchLocal(id: string) {
  write(read().map((p) => (p.id === id ? { ...p, updatedAt: Date.now() } : p)))
}

/** Delete a local project and everything stored for it: its document and its audio. */
export async function removeLocal(id: string) {
  write(read().filter((p) => p.id !== id))
  await deleteProjectAudio(id).catch(() => {})
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(docDb(id))
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}
