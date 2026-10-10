import { undoScope, userColor, type AwarenessState } from '@mobdaw/shared'
import { Awareness } from 'y-protocols/awareness'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import type { Session } from '../project/session'
import { docDb } from './ids'
import { touchLocal } from './projects'

/** Open a project that lives on this device: same shape as a cloud session, but the document is saved to IndexedDB. */
export function openLocalSession(projectId: string): Session {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(docDb(projectId), doc)
  const awareness = new Awareness(doc)
  const user: AwarenessState['user'] = { username: 'you', color: userColor('you') }
  awareness.setLocalStateField('user', user)
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  let touched = 0
  const onUpdate = () => {
    clearTimeout(touched)
    touched = window.setTimeout(() => touchLocal(projectId), 2000) // "last edited", for sorting the list
  }
  doc.on('update', onUpdate)
  return {
    projectId, doc, provider: null, local: true, awareness, undo, user,
    synced: persistence.whenSynced.then(() => {}),
    setLocal: (patch) => {
      for (const [k, v] of Object.entries(patch)) awareness.setLocalStateField(k, v)
    },
    remoteStates: () => [],
    destroy() {
      clearTimeout(touched)
      touchLocal(projectId)
      doc.off('update', onUpdate)
      undo.destroy()
      awareness.destroy()
      void persistence.destroy()
      doc.destroy()
    },
  }
}

/** A local project's document state, without opening an editor. */
export async function readLocalState(projectId: string): Promise<Uint8Array> {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(docDb(projectId), doc)
  await persistence.whenSynced
  const state = Y.encodeStateAsUpdate(doc)
  await persistence.destroy()
  doc.destroy()
  return state
}

/** Write a document state as a local project's saved document. */
export async function writeLocalState(projectId: string, state: Uint8Array) {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(docDb(projectId), doc)
  await persistence.whenSynced
  Y.applyUpdate(doc, state)
  await persistence.destroy() // flushes pending writes
  doc.destroy()
}
