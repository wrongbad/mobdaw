import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  REVERB, addDevice, addMidiClip, addNote, addTrack, deleteClip, deleteDevice, getClips, getDevices, getNotes, getTracks, historyLog,
  setParam, updateTrack, type HistoryItem, type HistoryResult,
} from '@mobdaw/shared'
import { ADMIN, admit, connect, login, startTest, until, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client, alice: Client, viewer: Client
let projectId: string
let a: ReturnType<typeof connect>, b: ReturnType<typeof connect>

beforeAll(async () => {
  t = await startTest()
  admin = await login(t.base, ADMIN)
  alice = await admit(t.base, admin, 'alice')
  viewer = await admit(t.base, admin, 'viewer')
  projectId = (await admin.post('/api/projects', { name: 'P' })).body.id
  await admin.post(`/api/projects/${projectId}/members`, { username: 'alice' })
  await admin.post(`/api/projects/${projectId}/members`, { username: 'viewer', role: 'viewer' })
  a = connect(t.port, projectId, admin.token!)
  b = connect(t.port, projectId, alice.token!)
  await until(() => a.provider.synced && b.provider.synced)
})
afterAll(async () => {
  a.provider.destroy(); b.provider.destroy()
  await t.cleanup()
})

const log = (doc = a.doc) => historyLog(doc).toArray()
/** Wait until both clients have `n` entries in their log; returns the last one. */
const entries = async (n: number) => {
  await until(() => log(a.doc).length === n && log(b.doc).length === n)
  return log(a.doc).at(-1)!
}
const url = (p: string) => `/api/projects/${projectId}/history${p}`

describe('history', () => {
  let bass = ''
  it('logs each transaction as one entry, attributed to whoever made it', async () => {
    bass = addTrack(a.doc, 'Bass', 'midi') // (a track, its mix device: one transaction)
    const e1 = await entries(1)
    expect(e1).toMatchObject({ username: 'admin', text: 'added track Bass', seq: 1 })
    const mix = getDevices(b.doc).find((d) => d.trackId === bass)!
    setParam(b.doc, mix.id, 0, 0.5)
    const e2 = await entries(2)
    expect(e2.username).toBe('alice')
    expect(e2.seq).toBe(2)
    expect(e2.text).toBe('Bass volume 1.00→0.50')
    // an edit that changes nothing, and chat, make no entry
    updateTrack(a.doc, bass, { name: 'Bass' })
    await new Promise((r) => setTimeout(r, 150))
    expect(log()).toHaveLength(2)
    for (const e of log()) expect(e.text.length).toBeLessThanOrEqual(40)
  })

  it('serves the log over HTTP to editors only', async () => {
    const r = await admin.get(url(''))
    expect(r.status).toBe(200)
    expect((r.body as HistoryItem[]).map((x) => [x.seq, x.username, x.text])).toEqual([[1, 'admin', 'added track Bass'], [2, 'alice', 'Bass volume 1.00→0.50']])
    expect((await admin.get(url('?since=1'))).body).toHaveLength(1)
    expect((await viewer.get(url(''))).status).toBe(403)
    expect((await viewer.post(url('/1/revert'))).status).toBe(403)
    expect((await admin.post(url('/999/revert'))).status).toBe(404)
  })

  it('revert skips fields that changed since', async () => {
    updateTrack(a.doc, bass, { muted: true, name: 'X' })
    const e = await entries(3)
    expect(e.text).toBe('edited track X')
    updateTrack(b.doc, bass, { name: 'Y' })
    await entries(4)
    const r = await admin.post(url(`/${e.seq}/revert`))
    const res = r.body as HistoryResult
    expect(res.applied).toBe(1) // muted goes back
    expect(res.skipped).toEqual([{ coll: 'tracks', id: bass, field: 'name' }])
    await until(() => getTracks(a.doc)[0].muted === false)
    expect(getTracks(a.doc)[0].name).toBe('Y')
    const last = await entries(5)
    expect(last).toMatchObject({ seq: res.seq, username: 'admin' })
    expect(last.text).toBe('reverted: edited track X')
  })

  it('restore rolls back later entries from both users', async () => {
    const keep = (await entries(5)).seq
    const clip = addMidiClip(a.doc, { trackId: bass, startTick: 0 })
    addNote(a.doc, { clipId: clip, tick: 0, durTicks: 100, pitch: 60, velocity: 90 })
    await entries(7)
    const other = addTrack(b.doc, 'Keys')
    await entries(8)
    expect(getTracks(a.doc)).toHaveLength(2)
    expect(other).toBeTruthy()
    const r = await alice.post(url(`/${keep}/restore`))
    expect(r.status).toBe(200)
    await until(() => getTracks(a.doc).length === 1 && getClips(a.doc).length === 0 && getNotes(a.doc).length === 0)
    expect(getDevices(a.doc).filter((d) => d.trackId === other)).toHaveLength(0)
    const last = await entries(9)
    expect(last.username).toBe('alice')
    expect(last.text).toMatch(/^restored to \d\d:\d\d UTC$/)
  })

  it('a deleted clip with its notes and a deleted device with its params come back', async () => {
    const clip = addMidiClip(a.doc, { trackId: bass, startTick: 480, lengthTicks: 1920, loopTicks: 960 })
    for (let i = 0; i < 3; i++) addNote(a.doc, { clipId: clip, tick: i * 100, durTicks: 50, pitch: 60 + i, velocity: 80 })
    await entries(13)
    const dev = addDevice(a.doc, bass, REVERB, {}, { 0: 0.77 })
    await entries(14)
    const before = { clip: getClips(a.doc), notes: getNotes(a.doc).sort((x, y) => x.tick - y.tick), dev: getDevices(a.doc).find((d) => d.id === dev) }
    expect(before.dev!.params[0]).toBe(0.77)

    deleteClip(a.doc, clip) // (the clip and its notes: one transaction)
    const del = await entries(15)
    expect(del.text).toBe('deleted clip from Y')
    await until(() => getClips(b.doc).length === 0 && getNotes(b.doc).length === 0)
    const r1 = (await admin.post(url(`/${del.seq}/revert`))).body as HistoryResult
    expect(r1.skipped).toEqual([])
    expect(r1.applied).toBe(4)
    await until(() => getClips(b.doc).length === 1 && getNotes(b.doc).length === 3)
    expect(getClips(b.doc)).toEqual(before.clip)
    expect(getNotes(b.doc).sort((x, y) => x.tick - y.tick)).toEqual(before.notes)

    await entries(16)
    deleteDevice(a.doc, dev)
    const delDev = await entries(17)
    await until(() => !getDevices(b.doc).some((d) => d.id === dev))
    await admin.post(url(`/${delDev.seq}/revert`))
    await until(() => getDevices(b.doc).some((d) => d.id === dev))
    expect(getDevices(b.doc).find((d) => d.id === dev)).toEqual(before.dev)
    // the recreated device is a real nested map: its params stay editable
    setParam(b.doc, dev, 0, 0.1)
    await until(() => getDevices(a.doc).find((d) => d.id === dev)!.params[0] === 0.1)
  })

  it('survives a restart: the mirror is rebuilt and the log goes on', async () => {
    const n = log().length
    await until(() => a.provider.unsyncedChanges === 0 && b.provider.unsyncedChanges === 0)
    const before = (t.ctx.db.prepare('SELECT MAX(seq) AS m FROM history WHERE project_id = ?').get(projectId) as { m: number }).m
    expect(before).toBeGreaterThanOrEqual(n)
    a.provider.destroy(); b.provider.destroy()
    await t.close()
    const t2 = await startTest({}, t.dir)
    try {
      const c = connect(t2.port, projectId, admin.token!)
      await until(() => c.provider.synced)
      expect(historyLog(c.doc).length).toBe(n)
      addTrack(c.doc, 'After')
      await until(() => historyLog(c.doc).length === n + 1)
      expect(historyLog(c.doc).get(n)).toMatchObject({ seq: before + 1, text: 'added track After' })
      c.provider.destroy()
    } finally {
      await t2.close()
    }
  })
})
