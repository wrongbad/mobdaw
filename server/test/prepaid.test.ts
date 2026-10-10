import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMonths } from '@mobdaw/shared'
import { endExpiredSubscriptions, giftMonths } from '../src/accounts.ts'
import { ADMIN, client, login, pw, startTest, type Client, userId } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client
const DAY = 86_400_000
const near = (actual: number, expected: number) => Math.abs(actual - expected) < 60_000
const register = (invite: string, username: string) => client(t.base).post('/api/auth/register', { username, password: pw(username), invite })
const uid = (username: string) => userId(t.ctx.db, username)
const row = (username: string) => t.ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any

beforeAll(async () => {
  t = await startTest()
  admin = await login(t.base, ADMIN)
})
afterAll(() => t.cleanup())

describe('invites gift pre-paid months', () => {
  it('the new account starts with the months its invite carries (default 1)', async () => {
    const dflt = (await admin.post('/api/invites')).body.token
    const three = (await admin.post('/api/invites', { giftMonths: 3 })).body.token
    const none = (await admin.post('/api/invites', { giftMonths: 0 })).body.token

    const a = await register(dflt, 'gina'), b = await register(three, 'hal'), c = await register(none, 'ivy')
    expect(near(a.body.me.paidThrough, addMonths(Date.now(), 1))).toBe(true)
    expect(near(b.body.me.paidThrough, addMonths(Date.now(), 3))).toBe(true)
    expect(a.body.me.planStatus).toBe('active')
    expect(c.body.me.paidThrough).toBeLessThanOrEqual(Date.now()) // nothing gifted: nothing paid
    expect((await admin.get('/api/invites')).body.map((i: any) => [i.giftMonths, i.redeemedBy]).sort()).toEqual([[0, 'ivy'], [1, 'gina'], [3, 'hal']])
  })

  it('rejects gifts that are not whole months from 0 to 999', async () => {
    for (const giftMonths of [-1, 1000, 1.5, '3'])
      expect((await admin.post('/api/invites', { giftMonths })).status).toBe(400)
    expect((await admin.post('/api/invites', { giftMonths: 999 })).status).toBe(200)
  })

  it('/me reports when the account is paid through', async () => {
    const me = (await admin.get('/api/me')).body
    expect(near(me.paidThrough, addMonths(Date.now(), 999))).toBe(true) // the bootstrap admin is created with 999 months
  })
})

describe('when pre-paid time runs out', () => {
  it('ends the subscription (read-only + retention), and gifting months brings the account back', async () => {
    const token = (await admin.post('/api/invites', { giftMonths: 1 })).body.token
    const jo = (await register(token, 'joey')).body
    const joC = client(t.base, jo.token)
    expect(endExpiredSubscriptions(t.ctx, t.collab)).toEqual([uid('ivy')]) // joey is still paid; ivy was gifted nothing

    const lapsed = Date.now() - DAY
    t.ctx.db.prepare('UPDATE users SET paid_through = ? WHERE username = ?').run(lapsed, 'joey')
    expect(endExpiredSubscriptions(t.ctx, t.collab)).toEqual([uid('joey')])
    expect(endExpiredSubscriptions(t.ctx, t.collab)).toEqual([]) // only once
    const me = (await joC.get('/api/me')).body
    expect(me.planStatus).toBe('read_only')
    expect(near(me.retentionEndsAt, Date.now() + 30 * DAY)).toBe(true)
    expect((await joC.post('/api/projects', { name: 'x' })).body.error).toBe('account_read_only')

    // a gift that doesn't reach the future leaves it read-only; one that does restores it
    const until = giftMonths(t.ctx, t.collab, uid('joey'), 2)!
    expect(near(until, addMonths(Date.now(), 2))).toBe(true) // time lost while lapsed isn't carried: it counts from now
    expect((await joC.get('/api/me')).body).toMatchObject({ planStatus: 'active', retentionEndsAt: null, paidThrough: until })
    expect((await joC.post('/api/projects', { name: 'x' })).status).toBe(201)
  })

  it('gifted months stack on the time that is left', async () => {
    const before = row(ADMIN).paid_through
    expect(giftMonths(t.ctx, null, uid(ADMIN), 12)).toBe(addMonths(before, 12))
    expect(giftMonths(t.ctx, null, 99999, 1)).toBeNull()
  })

  it('never ends the dev account, and never touches accounts that are paid', async () => {
    t.ctx.db.prepare("INSERT INTO users(username, password_hash, account_role, created_at, paid_through) VALUES('devacct2', '', 'dev', 1, 0)").run()
    expect(endExpiredSubscriptions(t.ctx, t.collab)).not.toContain(uid('devacct2'))
    expect(row(ADMIN).plan_status).toBe('active')
  })
})
