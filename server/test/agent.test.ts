import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  addMidiClip, addNote, addTrack, chatLog, getClips, getNotes, getTracks, historyLog, getDevices, getRegions, addChatMessage, type AwarenessState,
} from '@mobdaw/shared'
import { endSubscription } from '../src/accounts.ts'
import { ADMIN, admit, client, connect, login, startTest, until, userId, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client, alice: Client, viewer: Client, agent: Client
let token = ''
let projectId = ''
let a: ReturnType<typeof connect>, b: ReturnType<typeof connect>
const base = () => `/api/agent/projects/${projectId}`
const states = (c = a) => [...c.provider.awareness!.getStates().values()] as AwarenessState[]
const apiDots = (c = a) => states(c).filter((s) => s.api).map((s) => s.user.username)

beforeAll(async () => {
  t = await startTest({ AGENT_IDLE_MS: '1500' })
  admin = await login(t.base, ADMIN)
  alice = await admit(t.base, admin, 'alice')
  viewer = await admit(t.base, admin, 'viewer')
  projectId = (await admin.post('/api/projects', { name: 'P' })).body.id
  await admin.post(`/api/projects/${projectId}/members`, { username: 'alice' })
  await admin.post(`/api/projects/${projectId}/members`, { username: 'viewer', role: 'viewer' })
  const made = await admin.post('/api/me/api-tokens', { name: 'test' })
  token = made.body.token
  agent = client(t.base, token)
  a = connect(t.port, projectId, admin.token!)
  b = connect(t.port, projectId, alice.token!)
  await until(() => a.provider.synced && b.provider.synced)
})
afterAll(async () => {
  a.provider.destroy(); b.provider.destroy()
  await t.cleanup()
})

describe('api tokens', () => {
  it('are created (shown once), listed without the secret, and only work on the agent surface', async () => {
    const list = (await admin.get('/api/me/api-tokens')).body
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'test', lastUsedAt: null })
    expect(list[0].token).toBeUndefined()
    expect(token).toMatch(/^mdw_/)
    expect((await agent.get('/api/agent/projects')).body).toEqual([{ id: projectId, name: 'P', role: 'owner', canEdit: true }])
    expect((await admin.get('/api/me/api-tokens')).body[0].lastUsedAt).toBeTypeOf('number')
    // not an account credential: it can't read or make tokens, or see /me
    expect((await agent.get('/api/me')).status).toBe(401)
    expect((await agent.post('/api/me/api-tokens', {})).status).toBe(401)
    expect((await client(t.base).get('/api/agent/projects')).status).toBe(401)
    expect((await client(t.base, 'mdw_nope').get('/api/agent/projects')).status).toBe(401)
  })

  it('give viewers and non-members nothing', async () => {
    const vt = (await viewer.post('/api/me/api-tokens', {})).body.token
    expect((await client(t.base, vt).get(`${base()}/state`)).status).toBe(403)
    expect((await client(t.base, vt).get('/api/agent/projects')).body).toEqual([])
    const bt = (await alice.post('/api/me/api-tokens', {})).body.token
    expect((await client(t.base, bt).get('/api/agent/projects/nope/state')).status).toBe(404)
  })
})

describe('state', () => {
  it('shows tracks, clips, notes, devices and the timeline as json and text', async () => {
    const tr = addTrack(a.doc, 'Bass', 'midi')
    const clip = addMidiClip(a.doc, { trackId: tr, startTick: 0, lengthTicks: 3840 })
    addNote(a.doc, { clipId: clip, tick: 0, durTicks: 480, pitch: 36, velocity: 100 / 127 })
    await until(() => historyLog(b.doc).length >= 3)
    const j = (await agent.get(`${base()}/state`)).body
    expect(j.rev).toBeGreaterThanOrEqual(3)
    expect(j.meta).toMatchObject({ ppq: 960 })
    expect(j.regions[0]).toMatchObject({ bar: 1, bpm: 120, meter: '4/4', beatTicks: 960, barTicks: 3840 })
    const track = j.tracks.find((x: any) => x.id === tr)
    expect(track).toMatchObject({ name: 'Bass', kind: 'midi', muted: false })
    expect(track.devices.map((d: any) => d.type)).toContain('mix')
    expect(track.clips[0]).toMatchObject({ id: clip, start: '1.1.0', startTick: 0, lengthTicks: 3840, length: '1 bar' })
    expect(track.clips[0].notes[0]).toMatchObject({ p: 'C2', pitch: 36, t: 0, d: 480, v: 100 })
    const text = await fetch(t.base + `${base()}/state?format=text`, { headers: { authorization: `Bearer ${token}` } })
    expect(text.headers.get('content-type')).toContain('text/plain')
    const body = await text.text()
    expect(body).toContain('track "Bass"')
    expect(body).toContain('C2 0+480 v100')
    expect((await agent.get(`${base()}/state?format=xml`)).status).toBe(400)
  })

  it('narrows to tracks and bars', async () => {
    const tr = addTrack(a.doc, 'Lead', 'midi')
    const clip = addMidiClip(a.doc, { trackId: tr, startTick: 0, lengthTicks: 3840 * 4 })
    for (const bar of [0, 1, 2, 3]) addNote(a.doc, { clipId: clip, tick: bar * 3840, durTicks: 480, pitch: 60 + bar, velocity: 1 })
    await until(() => historyLog(b.doc).length >= 4)
    const j = (await agent.get(`${base()}/state?tracks=lead&fromBar=2&toBar=3`)).body
    expect(j.tracks.map((x: any) => x.name)).toEqual(['Lead'])
    expect(j.tracks[0].clips[0].notes.map((n: any) => n.pitch)).toEqual([61, 62])
    const text = await (await fetch(t.base + `${base()}/state?format=text&tracks=Lead&fromBar=4`, { headers: { authorization: `Bearer ${token}` } })).text()
    expect(text).toContain('(filtered:')
    expect(text).toContain('D#4')
    expect(text).not.toContain('C4 ')
    expect((await agent.get(`${base()}/state?fromBar=0`)).status).toBe(400)
  })
})

describe('ops', () => {
  it('apply as one labelled history entry attributed to "<user> (api)", with $n references', async () => {
    const before = historyLog(a.doc).length
    const r = await agent.post(`${base()}/ops`, {
      label: 'drum loop',
      ops: [
        { op: 'addTrack', name: 'Drums', preset: 'finnwave' },
        { op: 'addMidiClip', trackId: '$0', start: '2', length: '2 bars', loop: '1 bar', view: 'drums' },
        { op: 'addNotes', clipId: '$1', notes: [{ p: 'C2', t: 0, d: 240, v: 110 }, { pitch: 38, t: '2 beats', d: '1 beat' }] },
        { op: 'addDevice', trackId: '$0', type: 'reverb', params: { mix: 0.4 } },
        { op: 'setParam', deviceId: '$3', param: 'size', value: 0.8 },
        { op: 'addRegion', bar: 3, bpm: 90, meter: '7/8' },
        { op: 'addMarker', bar: 2, label: 'Verse' },
        { op: 'setKey', key: 'D minor' },
      ],
    })
    expect(r.status).toBe(200)
    expect(r.body.ids).toHaveLength(8)
    expect(r.body.seq).toBeTypeOf('number')
    await until(() => historyLog(a.doc).length === before + 1)
    expect(historyLog(a.doc).toArray().at(-1)).toMatchObject({ text: 'drum loop', username: `${ADMIN} (api)`, api: true, seq: r.body.seq })
    const clip = getClips(a.doc).find((c) => c.id === r.body.ids[1])!
    expect(clip).toMatchObject({ kind: 'midi', startTick: 3840, lengthTicks: 7680, loopTicks: 3840, view: 'drums' })
    const notes = getNotes(a.doc).filter((n) => n.clipId === clip.id).sort((x, y) => x.tick - y.tick)
    expect(notes.map((n) => [n.pitch, n.tick, n.durTicks])).toEqual([[36, 0, 240], [38, 1920, 960]])
    expect(r.body.ids[2]).toEqual(notes.map((n) => n.id).sort((x, y) => (x === r.body.ids[2][0] ? -1 : y === r.body.ids[2][0] ? 1 : 0)))
    const rev = getDevices(a.doc).find((d) => d.id === r.body.ids[3])!
    expect(rev.params['0']).toBe(0.4)
    expect(rev.params['1']).toBe(0.8)
    expect(getRegions(a.doc).find((x) => x.bar === 3)).toMatchObject({ bpm: 90, num: 7, den: 8 })
    expect(getDevices(a.doc).filter((d) => d.trackId === r.body.ids[0]).map((d) => d.type).sort((x, y) => x - y)).toEqual([2, 3, 9])
  })

  it('are all-or-nothing: a bad op writes nothing and names itself', async () => {
    const tracks = getTracks(a.doc).length
    const entries = historyLog(a.doc).length
    const r = await agent.post(`${base()}/ops`, { ops: [{ op: 'addTrack', name: 'Ghost' }, { op: 'addNotes', clipId: 'nope', notes: [{ p: 'C4', t: 0, d: 10 }] }] })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'bad_ops', op: 1 })
    expect(r.body.message).toContain('no clip')
    await new Promise((res) => setTimeout(res, 150))
    expect(getTracks(a.doc)).toHaveLength(tracks)
    expect(historyLog(a.doc)).toHaveLength(entries)
    for (const bad of [
      [{ op: 'nope' }], [{ op: 'addTrack' }], [{ op: 'addTrack', name: 'x', typo: 1 }], [], 'x',
      [{ op: 'addMidiClip', trackId: 'zz', start: '1', length: '1 bar' }],
      [{ op: 'addTrack', name: 'x' }, { op: 'addMidiClip', trackId: '$5', start: '1', length: '1 bar' }],
      [{ op: 'addTrack', name: 'x' }, { op: 'addMidiClip', trackId: '$0', start: '1.9', length: '1 bar' }],
      [{ op: 'setParam', deviceId: getDevices(a.doc)[0].id, param: 'nope', value: 1 }],
    ]) expect((await agent.post(`${base()}/ops`, { ops: bad })).status, JSON.stringify(bad)).toBe(400)
    expect(getTracks(a.doc)).toHaveLength(tracks)
  })

  it('are refused for a read-only account, while reading still works', async () => {
    const carol = await admit(t.base, admin, 'carol')
    await admin.post(`/api/projects/${projectId}/members`, { username: 'carol' })
    const tok = (await carol.post('/api/me/api-tokens', {})).body.token
    endSubscription(t.ctx, t.collab, userId(t.ctx.db, 'carol'))
    const c = client(t.base, tok)
    const r = await c.post(`${base()}/ops`, { ops: [{ op: 'setKey', key: 'C major' }] })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('account_read_only')
    expect((await c.get(`${base()}/state`)).status).toBe(200)
    expect((await c.post(`${base()}/chat`, { text: 'x' })).status).toBe(403)
    expect((await c.get('/api/agent/projects')).body[0].canEdit).toBe(false)
  })
})

describe('chat, history and events', () => {
  it('posts chat as the api identity, parsing mentions against members', async () => {
    const r = await agent.post(`${base()}/chat`, { text: 'hello @alice and @nobody' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ username: `${ADMIN} (api)`, mentions: ['alice'] })
    await until(() => chatLog(b.doc).length === 1)
    expect(chatLog(b.doc).get(0).text).toBe('hello @alice and @nobody')
    const got = (await agent.get(`${base()}/chat`)).body
    expect(got.messages).toHaveLength(1)
    expect((await agent.post(`${base()}/chat`, { text: '  ' })).status).toBe(400)
  })

  it('lists, reverts and restores history as the api identity', async () => {
    const list = (await agent.get(`${base()}/history`)).body
    const drum = list.find((e: any) => e.text === 'drum loop')
    expect(drum).toMatchObject({ api: true, via: 'api' })
    const r = await agent.post(`${base()}/history/${drum.seq}/revert`)
    expect(r.status).toBe(200)
    expect(r.body.applied).toBeGreaterThan(0)
    await until(() => !getTracks(a.doc).some((x) => x.name === 'Drums'))
    expect(historyLog(a.doc).toArray().at(-1)).toMatchObject({ api: true, username: `${ADMIN} (api)` })
    expect((await agent.post(`${base()}/history/99999/revert`)).status).toBe(404)
  })

  it('wakes a long-poll on a human @mention of the agent, and skips its own doings', async () => {
    const first = (await agent.get(`${base()}/events`)).body
    expect(first.events).toEqual([])
    const waiting = agent.get(`${base()}/events?since=${first.cursor}&wait=10`)
    await new Promise((res) => setTimeout(res, 100))
    addChatMessage(b.doc, { username: 'alice', color: '#fff' }, 'hey @admin(api) add a bass', [`@${ADMIN}(api)`])
    const r = await waiting
    expect(r.status).toBe(200)
    expect(r.body.events).toHaveLength(1)
    expect(r.body.events[0]).toMatchObject({ type: 'chat', mentionsMe: true })
    expect(r.body.events[0].message).toMatchObject({ username: 'alice', text: 'hey @admin(api) add a bass' })
    // another's edit is a history event; the agent's own is not
    await agent.post(`${base()}/ops`, { ops: [{ op: 'setKey', key: 'A minor' }] })
    addTrack(b.doc, 'Pad', 'midi')
    const next = (await agent.get(`${base()}/events?since=${r.body.cursor}&wait=5`)).body
    expect(next.events.map((e: any) => e.type === 'history' && e.entry.username)).toEqual(['alice'])
    // no news: returns empty after the wait
    const t0 = Date.now()
    const none = (await agent.get(`${base()}/events?since=${next.cursor}&wait=1`)).body
    expect(none.events).toEqual([])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
  })

  it('reports people joining and leaving', async () => {
    const cur = (await agent.get(`${base()}/events`)).body.cursor
    const c = connect(t.port, projectId, alice.token!)
    c.provider.setAwarenessField('user', { username: 'alice2', color: '#abc' })
    const r = (await agent.get(`${base()}/events?since=${cur}&wait=5`)).body
    expect(r.events).toContainEqual({ type: 'presence', joined: 'alice2' })
    c.provider.destroy()
    const l = (await agent.get(`${base()}/events?since=${r.cursor}&wait=5`)).body
    expect(l.events).toContainEqual({ type: 'presence', left: 'alice2' })
  })
})

describe('presence', () => {
  it('shows an active agent as "<user> (api)" and removes it when idle', async () => {
    await until(() => apiDots().length === 1) // (from the requests above)
    expect(apiDots()).toEqual([`${ADMIN} (api)`])
    const st = states().find((s) => s.api)!
    expect(st.user.color).toMatch(/^hsl/)
    expect(apiDots(b)).toEqual([`${ADMIN} (api)`])
    await until(() => apiDots().length === 0, 6000) // AGENT_IDLE_MS = 1.5 s
    expect(t.collab.hocuspocus.documents.get(`project:${projectId}`)).toBeDefined() // (humans are still connected)
    await agent.get(`${base()}/state`)
    await until(() => apiDots().length === 1)
  })

  it('stays while an events wait is open, and ends at once when the token is revoked', async () => {
    const tok = (await admin.post('/api/me/api-tokens', { name: 'second' })).body
    const other = client(t.base, tok.token)
    await other.get(`${base()}/state`)
    await until(() => apiDots().length === 2)
    // revoking: access ends and the dot goes immediately
    expect((await admin.del(`/api/me/api-tokens/${tok.id}`)).status).toBe(200)
    expect((await other.get(`${base()}/state`)).status).toBe(401)
    await until(() => apiDots().length === 1)
    expect((await admin.del(`/api/me/api-tokens/${tok.id}`)).status).toBe(404)
  })

  it('revoking the token in use removes the agent and its websocket connection', async () => {
    const list = (await admin.get('/api/me/api-tokens')).body
    const first = list.find((x: any) => x.name === 'test')
    const ws = connect(t.port, projectId, token) // an API token may connect live, as "<user> (api)"
    await until(() => ws.provider.synced)
    let closed = false
    ws.provider.on('close', () => (closed = true))
    expect((await admin.del(`/api/me/api-tokens/${first.id}`)).status).toBe(200)
    expect((await agent.get(`${base()}/state`)).status).toBe(401)
    await until(() => closed)
    await until(() => apiDots().length === 0)
    ws.provider.destroy()
  })
})

describe('mcp', () => {
  it('lists the tools and runs get_state and apply_ops through the SDK client', async () => {
    const tok = (await admin.post('/api/me/api-tokens', { name: 'mcp' })).body.token
    const mcp = new McpClient({ name: 'test', version: '0' })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }))
    const tools = (await mcp.listTools()).tools.map((x) => x.name)
    expect(tools).toEqual(expect.arrayContaining(['list_projects', 'get_state', 'apply_ops', 'send_chat', 'wait_for_events', 'get_history', 'revert', 'restore']))
    const text = (r: any) => r.content[0].text as string
    expect(JSON.parse(text(await mcp.callTool({ name: 'list_projects', arguments: {} })))[0].id).toBe(projectId)
    const ops = await mcp.callTool({ name: 'apply_ops', arguments: { projectId, label: 'via mcp', ops: [{ op: 'addTrack', name: 'Mcp', kind: 'audio' }] } })
    expect(ops.isError).toBeFalsy()
    const { ids, seq } = JSON.parse(text(ops))
    await until(() => getTracks(a.doc).some((x) => x.id === ids[0]))
    const st = await mcp.callTool({ name: 'get_state', arguments: { projectId, format: 'text' } })
    expect(text(st)).toContain('track "Mcp"')
    expect(text(st)).toContain(`rev ${seq}`)
    const bad = await mcp.callTool({ name: 'apply_ops', arguments: { projectId, ops: [{ op: 'removeTrack', id: 'nope' }] } })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('no track')
    const chat = await mcp.callTool({ name: 'send_chat', arguments: { projectId, text: 'hi from mcp' } })
    expect(JSON.parse(text(chat)).text).toBe('hi from mcp')
    const ev = await mcp.callTool({ name: 'wait_for_events', arguments: { projectId, wait: 0 } })
    expect(JSON.parse(text(ev))).toHaveProperty('cursor')
    await mcp.close()
    expect((await fetch(`${t.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await fetch(`${t.base}/mcp`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(405)
  })
})
