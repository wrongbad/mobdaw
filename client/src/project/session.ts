import { HocuspocusProvider } from '@hocuspocus/provider'
import { docName, undoScope, userColor, type AwarenessState, type Me } from '@mobdaw/shared'
import * as Y from 'yjs'
import { getToken } from '../api'

/** Y.Doc + provider + awareness + undo for one project. Call destroy() on route leave. */
export function openSession(projectId: string, me: Me) {
  const doc = new Y.Doc()
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const provider = new HocuspocusProvider({
    url: `${proto}//${location.host}/collab`,
    name: docName(projectId),
    document: doc,
    token: getToken(),
  })
  const awareness = provider.awareness!
  const user: AwarenessState['user'] = { email: me.email, name: me.name || me.email, color: userColor(me.email) }
  awareness.setLocalStateField('user', user)
  // Local edits have origin null (tracked by default); remote updates carry the provider as origin.
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  return {
    projectId, doc, provider, awareness, undo, user,
    setLocal: (patch: Partial<Omit<AwarenessState, 'user'>>) => {
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
export type Session = ReturnType<typeof openSession>
