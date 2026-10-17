import { HocuspocusProvider } from '@hocuspocus/provider'
import { docName, undoScope, userColor, type AwarenessState } from '@mobdaw/shared'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { api, getToken } from '../api'

/** What the editor needs from a project, whether it is synced with the cloud, a snapshot of one, or lives on this device. */
export type Session = {
  projectId: string
  doc: Y.Doc
  /** The collaboration connection; null when nothing is synced (a project on this device, or a snapshot). */
  provider: HocuspocusProvider | null
  /** A project on this device: saved to IndexedDB. */
  local: boolean
  /**
   * A snapshot of a cloud project that this user cannot edit live (a viewer, a public visitor, a frozen project or a
   * read-only account). Edits stay on this page, nothing is sent and no updates arrive; the visitor can save a copy to
   * this device. No uploads or recording.
   */
  snapshot: boolean
  awareness: Awareness
  undo: Y.UndoManager
  user: AwarenessState['user']
  /** The signed-in account's id; null for a signed-out visitor and in a project on this device. */
  userId: number | null
  /** Resolves once the document is loaded (from the server, or from this device). */
  synced: Promise<void>
  setLocal(patch: Partial<Omit<AwarenessState, 'user'>>): void
  remoteStates(): AwarenessState[]
  destroy(): void
}

/** Y.Doc + provider + awareness + undo for a project the user edits live. Call destroy() on route leave. */
export function openSession(projectId: string, me: { id: number; username: string }): Session {
  const doc = new Y.Doc()
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const provider = new HocuspocusProvider({
    url: `${proto}//${location.host}${import.meta.env.BASE_URL}collab`,
    name: docName(projectId),
    document: doc,
    token: getToken(),
  })
  const awareness = provider.awareness!
  const user: AwarenessState['user'] = { username: me.username, color: userColor(me.username) }
  awareness.setLocalStateField('user', user)
  // Local edits have origin null (tracked by default); remote updates carry the provider as origin.
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  const synced = new Promise<void>((resolve) => (provider.synced ? resolve() : provider.on('synced', () => resolve())))
  return {
    projectId, doc, provider, local: false, snapshot: false, awareness, undo, user, userId: me.id, synced,
    setLocal: (patch) => {
      for (const [k, v] of Object.entries(patch)) awareness.setLocalStateField(k, v)
    },
    remoteStates: () =>
      [...awareness.getStates()].filter(([id]) => id !== doc.clientID).map(([, s]) => s as AwarenessState).filter((s) => s.user),
    destroy() {
      undo.destroy()
      provider.destroy()
      doc.destroy()
    },
  }
}

/** The document of a cloud project as it is now, without a connection (`me` is null for a signed-out visitor). */
export async function fetchSnapshot(projectId: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await api.projectSnapshot(projectId), 'snapshot') // (an origin the undo manager does not track)
  return doc
}

/** A cloud project the user cannot edit live: its document as of now, edited only in this page. Call destroy() on route leave. */
export function openSnapshotSession(projectId: string, me: { id: number; username: string } | null): Session {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalState(null) // no presence: no one is told about us
  const user: AwarenessState['user'] = { username: me?.username ?? 'guest', color: userColor(me?.username ?? 'guest') }
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  const synced = api.projectSnapshot(projectId).then((state) => Y.applyUpdate(doc, state, 'snapshot'))
  return {
    projectId, doc, provider: null, local: false, snapshot: true, awareness, undo, user, userId: me?.id ?? null, synced,
    setLocal: () => {},
    remoteStates: () => [],
    destroy() {
      undo.destroy()
      awareness.destroy()
      doc.destroy()
    },
  }
}
