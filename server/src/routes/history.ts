import { Hono, type Context } from 'hono'
import type { HistoryItem, HistoryResult } from '@mobdaw/shared'
import { projectRole, requireSignedInOrPublic, writeBlock, type Ctx, type Env } from '../auth.ts'
import type { Collab } from '../collab.ts'
import { listHistory, restoreTo, revertEntry } from '../history.ts'

/** Project change log routes, mounted at /projects/:id/history. Owners and editors only (the log shows everyone's work). */
export function historyRoutes(ctx: Ctx, collab: Collab) {
  const r = new Hono<Env>()
  r.use('*', requireSignedInOrPublic(ctx))
  r.use('/*', async (c, next) => {
    const id = c.req.param('id')!, me = c.var.session?.id ?? null
    const role = projectRole(ctx, id, me)
    if (!role) return c.json({ error: 'not_found' }, 404)
    if (role === 'viewer' || me === null) return c.json({ error: 'forbidden' }, 403)
    if (c.req.method !== 'GET') {
      const blocked = writeBlock(ctx, id, me)
      if (blocked) return c.json({ error: blocked }, 403)
    }
    await next()
  })

  r.get('/', (c) => {
    const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d)
    return c.json<HistoryItem[]>(listHistory(ctx, c.req.param('id')!, num(c.req.query('since'), 0), num(c.req.query('limit'), 200)))
  })

  const who = (c: Context<Env>) => ({ userId: c.var.session!.id, username: c.var.session!.username, via: 'ui' })
  const act = (run: typeof revertEntry) => async (c: Context<Env>) => {
    const seq = Number(c.req.param('seq'))
    if (!Number.isInteger(seq)) return c.json({ error: 'bad_request' }, 400)
    const res = await run(ctx, collab, c.req.param('id')!, seq, who(c))
    return res ? c.json<HistoryResult>(res) : c.json({ error: 'not_found' }, 404)
  }
  r.post('/:seq/revert', act(revertEntry))
  r.post('/:seq/restore', act(restoreTo))
  return r
}
