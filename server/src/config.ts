import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')

export type Config = {
  port: number
  publicUrl: string
  authMode: 'dev' | 'google'
  googleClientId: string | null
  sessionSecret: string
  adminEmails: string[]
  dbPath: string
  storageDriver: 'local' | 's3'
  storageDir: string
  s3Bucket: string
  s3Region: string
  maxUploadBytes: number
  userQuotaBytes: number
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const authMode = (env.AUTH_MODE ?? 'dev') as Config['authMode']
  if (authMode !== 'dev' && authMode !== 'google') throw new Error('AUTH_MODE must be dev or google')
  const storageDriver = (env.STORAGE_DRIVER ?? 'local') as Config['storageDriver']
  if (storageDriver !== 'local' && storageDriver !== 's3') throw new Error('STORAGE_DRIVER must be local or s3')
  if (authMode === 'google' && !env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is required')
  // Dev mode trusts any email: never let it run behind a public URL.
  const host = new URL(env.PUBLIC_URL ?? 'http://localhost:5173').hostname
  if (authMode === 'dev' && !['localhost', '127.0.0.1', '[::1]'].includes(host))
    throw new Error(`AUTH_MODE=dev is only allowed when PUBLIC_URL is localhost (got ${host})`)
  if (authMode !== 'dev' && !env.SESSION_SECRET) throw new Error('SESSION_SECRET is required outside dev mode')
  if (storageDriver === 's3' && !(env.S3_BUCKET && env.S3_REGION)) throw new Error('S3_BUCKET and S3_REGION are required')
  return {
    port: Number(env.PORT ?? 8787),
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
    authMode,
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    adminEmails: (env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    dbPath: resolve(repoRoot, env.DB_PATH ?? './data/mobdaw.db'),
    storageDriver,
    storageDir: resolve(repoRoot, env.STORAGE_DIR ?? './data/samples'),
    s3Bucket: env.S3_BUCKET ?? '',
    s3Region: env.S3_REGION ?? '',
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 4294967296),
    userQuotaBytes: Number(env.USER_QUOTA_BYTES ?? 107374182400),
  }
}
