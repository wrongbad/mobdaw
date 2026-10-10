import { HocuspocusProvider } from '@hocuspocus/provider'
import { docName, undoScope, userColor, type AwarenessState, type Me } from '@mobdaw/shared'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { getToken } from '../api'

/** What the editor needs from a project, whether it is synced with the cloud or lives on this device. */
export type Session = {
  projectId: string
  doc: Y.Doc
  /** The collaboration connection; null for a project on this device (nothing to sync, no one to collaborate with). */
  provider: HocuspocusProvider | null
  local: boolean
  awareness: Awareness
  undo: Y.UndoManager
  user: AwarenessState['user']
  /** Resolves once the document is loaded (from the server, or from this device). */
  synced: Promise<void>
  setLocal(patch: Partial<Omit<AwarenessState, 'user'>>): void
  remoteStates(): AwarenessState[]
  destroy(): void
}

/** Y.Doc + provider + awareness + undo for one project. Call destroy() on route leave. */
export function openSession(projectId: string, me: Pick<Me, 'username'>): Session {
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
    projectId, doc, provider, local: false, awareness, undo, user, synced,
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
