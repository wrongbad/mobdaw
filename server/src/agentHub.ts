// What the server keeps for agents working in a project (docs/agent-api.md): their presence and the event feed.
//
// While an agent (an API token) is active in a project (a request in the last `idleMs`, or an open `events` wait) the hub holds a
// direct connection to the project's document, so it stays loaded, and publishes the agent's presence into the document's
// awareness under its own client id, as `{user: {username: "k (api)", color}, api: true}`; Hocuspocus broadcasts it like any other
// state. The same connection feeds a per-project event buffer (new chat, new history entries, people joining and leaving) that
// `events` long-polls over by cursor. Both go away when the last agent in a project has been idle for `idleMs`.
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import {
  apiName, chatLog, docName, historyLog, mentionHandle, parseMentions, userColor, type AwarenessState, type ChatMessage, type HistoryEntry,
} from '@mobdaw/shared'
import type { Collab } from './history.ts'
import type { Db } from './db.ts'

/** Who is acting: a user, through one token (`key`: the token's hash, or `s:<id>` for a session). */
export type AgentUser = { id: number; username: string; key: string }

export type AgentEvent =
  | { type: 'chat'; message: ChatMessage; mentionsMe: boolean }
  | { type: 'history'; entry: HistoryEntry }
  | { type: 'presence'; joined?: string; left?: string }
type Raw = { cursor: number; ev: { type: 'chat'; message: ChatMessage } | { type: 'history'; entry: HistoryEntry } | { type: 'presence'; joined?: string; left?: string } }

export type EventsResult = { cursor: number; events: AgentEvent[]; /** Events before your cursor were not kept (the project had no agent for a while): re-read state and chat. */ gap?: boolean }

const AGENT_ORIGIN = { source: 'local', context: { via: 'agent-presence' } } as const
export const EVENT_BUFFER = 500
export const WAIT_MAX_S = 25

type Session = {
  user: AgentUser
  projectId: string
  awareness: Awareness
  timer?: NodeJS.Timeout
  /** Open `events` waits: the agent is active while any is open. */
  waiting: number
}
type DirectConnection = Awaited<ReturnType<Collab['hocuspocus']['openDirectConnection']>>
type Feed = {
  projectId: string
  conn: DirectConnection
  doc: Y.Doc & { awareness: Awareness }
  events: Raw[]
  /** Events with a cursor above this were observed by the feed. */
  first: number
  waiters: Set<() => void>
  /** Presence names -> client ids, to tell a first join and a last leave from a second tab. */
  names: Map<string, Set<number>>
  clients: Map<number, string>
  off: (() => void)[]
  sessions: Set<Session>
}

export type AgentHub = ReturnType<typeof createAgentHub>
const hubs = new WeakMap<object, AgentHub>()
/** The hub of a server (so account code that only has the collab handle can end agent presence). */
export const hubOf = (collab: object) => hubs.get(collab)

export function createAgentHub(db: Db, collab: Collab & object, idleMs = 60_000) {
  let counter = 0
  const feeds = new Map<string, Feed>()
  const opening = new Map<string, Promise<Feed>>()
  const sessions = new Map<string, Session>() // `${projectId}\n${user.key}`
  let closed = false

  const push = (f: Feed, ev: Raw['ev']) => {
    f.events.push({ cursor: ++counter, ev })
    if (f.events.length > EVENT_BUFFER) f.events.splice(0, f.events.length - EVENT_BUFFER)
    for (const w of [...f.waiters]) w()
  }

  async function openFeed(projectId: string): Promise<Feed> {
    const conn = await collab.hocuspocus.openDirectConnection(docName(projectId), { userId: null, username: 'mobdaw', via: 'system' })
    const doc = conn.document as unknown as Feed['doc']
    const f: Feed = { projectId, conn, doc, events: [], first: counter, waiters: new Set(), names: new Map(), clients: new Map(), off: [], sessions: new Set() }
    const aw = doc.awareness
    const note = (id: number, name: string | undefined, join: boolean) => {
      if (join && name) {
        f.clients.set(id, name)
        const set = f.names.get(name) ?? f.names.set(name, new Set()).get(name)!
        set.add(id)
        return set.size === 1
      }
      const was = f.clients.get(id)
      if (!was) return false
      f.clients.delete(id)
      const set = f.names.get(was)
      set?.delete(id)
      if (set && !set.size) return !!f.names.delete(was)
      return false
    }
    for (const [id, s] of aw.getStates()) note(id, (s as AwarenessState).user?.username, true)
    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      for (const id of [...added, ...updated]) {
        const name = (aw.getStates().get(id) as AwarenessState | undefined)?.user?.username
        if (!name || f.clients.get(id) === name) continue
        if (f.clients.has(id)) note(id, undefined, false) && push(f, { type: 'presence', left: f.clients.get(id) })
        if (note(id, name, true)) push(f, { type: 'presence', joined: name })
      }
      for (const id of removed) {
        const name = f.clients.get(id)
        if (note(id, undefined, false) && name) push(f, { type: 'presence', left: name })
      }
    }
    aw.on('change', onAwareness)
    f.off.push(() => aw.off('change', onAwareness))
    const chat = chatLog(doc), hist = historyLog(doc)
    const onChat = (e: Y.YArrayEvent<ChatMessage>) => {
      for (const d of e.changes.delta) if (d.insert) for (const m of d.insert as ChatMessage[]) push(f, { type: 'chat', message: m })
    }
    const onHist = (e: Y.YArrayEvent<HistoryEntry>) => {
      for (const d of e.changes.delta) if (d.insert) for (const m of d.insert as HistoryEntry[]) push(f, { type: 'history', entry: m })
    }
    chat.observe(onChat)
    hist.observe(onHist)
    f.off.push(() => chat.unobserve(onChat), () => hist.unobserve(onHist))
    return f
  }

  const feedOf = async (projectId: string) => {
    const have = feeds.get(projectId)
    if (have) return have
    let p = opening.get(projectId)
    if (!p) {
      p = openFeed(projectId).then((f) => (feeds.set(projectId, f), f)).finally(() => opening.delete(projectId))
      opening.set(projectId, p)
    }
    return p
  }

  function publish(f: Feed, s: Session) {
    const name = apiName(s.user.username)
    const aw = new Awareness(new Y.Doc())
    s.awareness = aw
    const forward = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const ids = [...added, ...updated, ...removed]
      if (ids.length) applyAwarenessUpdate((f.doc as unknown as { awareness: Awareness }).awareness, encodeAwarenessUpdate(aw, ids), AGENT_ORIGIN)
    }
    aw.on('update', forward) // (also the periodic renewal that keeps the state from timing out)
    aw.setLocalState({ user: { username: name, color: userColor(name) }, api: true } satisfies AwarenessState)
  }

  async function release(s: Session) {
    clearTimeout(s.timer)
    sessions.delete(`${s.projectId}\n${s.user.key}`)
    s.awareness.setLocalState(null) // (forwarded: the dot disappears)
    s.awareness.destroy()
    const f = feeds.get(s.projectId)
    if (!f) return
    f.sessions.delete(s)
    if (f.sessions.size) return
    feeds.delete(s.projectId)
    f.off.forEach((o) => o())
    for (const w of [...f.waiters]) w()
    await f.conn.disconnect().catch((e: unknown) => console.error('closing agent connection failed', e))
  }

  const arm = (s: Session) => {
    clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      if (s.waiting > 0 || closed) return arm(s)
      void release(s)
    }, idleMs)
    s.timer.unref()
  }

  /** The agent is doing something in the project: show it as present and keep the document loaded. */
  async function touchFeed(projectId: string, user: AgentUser): Promise<Feed> {
    const k = `${projectId}\n${user.key}`
    const f = await feedOf(projectId)
    let s = sessions.get(k)
    if (!s) {
      s = { user, projectId, awareness: undefined as unknown as Awareness, waiting: 0 }
      sessions.set(k, s)
      f.sessions.add(s)
      publish(f, s)
    }
    arm(s)
    return f
  }

  const cursor = () => counter

  /** The names of who is in the project right now (browsers and agents), from the document's awareness. */
  function present(projectId: string): string[] {
    const f = feeds.get(projectId)
    const doc = (f?.doc ?? (collab.hocuspocus.documents.get(docName(projectId)) as unknown as (Y.Doc & { awareness: Awareness }) | undefined))
    if (!doc) return []
    return [...new Set([...doc.awareness.getStates().values()].map((s) => (s as AwarenessState).user?.username).filter((n): n is string => !!n))]
  }

  /** The mention handles that count in a chat message: the project's members plus whoever is present. */
  function handles(projectId: string): string[] {
    const members = (db.prepare('SELECT u.username FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?').all(projectId) as { username: string }[]).map((r) => r.username)
    return [...members, ...present(projectId).map(mentionHandle)]
  }

  const view = (raw: Raw, me: string): AgentEvent | null => {
    const ev = raw.ev
    if (ev.type === 'chat') {
      if (ev.message.username === me) return null
      const mentioned = (ev.message.mentions ?? []).includes(me) || parseMentions(ev.message.text, [mentionHandle(me)]).includes(me)
      return { type: 'chat', message: ev.message, mentionsMe: mentioned }
    }
    if (ev.type === 'history') return ev.entry.username === me ? null : ev
    return ev.joined === me || ev.left === me ? null : ev
  }

  /**
   * Long-poll: events after `since` (the cursor of a previous call; omitted: from now) that this agent didn't cause. Returns at once if
   * there are some, else after `waitS` seconds (max 25) or when the first arrives. `signal` ends the wait early (client gone).
   */
  async function events(projectId: string, user: AgentUser, since: number | undefined, waitS: number, signal?: AbortSignal): Promise<EventsResult> {
    const f = await touchFeed(projectId, user)
    const s = sessions.get(`${projectId}\n${user.key}`)!
    const me = apiName(user.username)
    const from = since === undefined || since > counter ? counter : since
    const gap = since !== undefined && since < f.first ? true : undefined
    const collect = () => {
      const out = f.events.filter((e) => e.cursor > from).map((e) => view(e, me)).filter((e): e is AgentEvent => !!e)
      return out
    }
    let out = collect()
    const wait = Math.max(0, Math.min(WAIT_MAX_S, waitS))
    if (!out.length && wait > 0 && !signal?.aborted) {
      s.waiting++
      try {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(t)
            f.waiters.delete(check)
            signal?.removeEventListener('abort', done)
            resolve()
          }
          const check = () => (collect().length || closed || !feeds.has(projectId) ? done() : undefined)
          const t = setTimeout(done, wait * 1000)
          f.waiters.add(check)
          signal?.addEventListener('abort', done)
        })
      } finally {
        s.waiting--
        arm(s)
      }
      out = collect()
    }
    return { cursor: f.events.at(-1)?.cursor ?? Math.max(from, f.first), events: out, ...(gap ? { gap } : {}) }
  }

  /** End the presence of every session of a token (or, with `userId`, of a user) at once. */
  async function drop(match: (u: AgentUser) => boolean) {
    await Promise.all([...sessions.values()].filter((s) => match(s.user)).map(release))
  }

  const hub = {
    /** Mark the agent active in the project (present, document loaded); returns the live document. */
    touch: async (projectId: string, user: AgentUser) => (await touchFeed(projectId, user)).doc,
    events, present, handles, cursor, drop,
    dropToken: (key: string) => drop((u) => u.key === key),
    dropUser: (id: number) => drop((u) => u.id === id),
    /** Sessions of tokens that no longer exist (a revoke made by another process, the admin CLI). */
    sweepRevoked: () => drop((u) => !u.key.startsWith('s:') && !db.prepare('SELECT 1 FROM api_tokens WHERE token_hash = ?').get(u.key)),
    /** Number of agents currently shown as present (tests). */
    active: (projectId?: string) => [...sessions.values()].filter((s) => !projectId || s.projectId === projectId).length,
    async close() {
      closed = true
      await Promise.all([...sessions.values()].map(release))
    },
  }
  hubs.set(collab, hub)
  return hub
}
