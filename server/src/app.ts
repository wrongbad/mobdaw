import { Hono } from 'hono'
import type { Collab } from './collab.ts'
import { sessionMiddleware, type Ctx, type Env } from './auth.ts'
import { authRoutes } from './routes/auth.ts'
import { inviteRoutes } from './routes/invites.ts'
import { projectRoutes } from './routes/projects.ts'
import { sampleRoutes } from './routes/samples.ts'
import { uploadRoutes } from './routes/uploads.ts'
import type { Storage } from './storage/index.ts'

export function createApp(ctx: Ctx, storage: Storage, collab: Collab) {
  const api = new Hono<Env>()
  api.use(sessionMiddleware(ctx))
  api.route('/', authRoutes(ctx))
  api.route('/', inviteRoutes(ctx))
  api.route('/projects', projectRoutes(ctx, collab))
  api.route('/projects/:id/samples', sampleRoutes(ctx, storage))
  api.route('/uploads', uploadRoutes(ctx, storage))
  if (storage.routes) api.route('/storage', storage.routes) // local driver; signature-authorized
  api.notFound((c) => c.json({ error: 'not_found' }, 404))
  api.onError((e, c) => {
    console.error(e)
    return c.json({ error: 'internal' }, 500)
  })
  return new Hono().route('/api', api)
}
