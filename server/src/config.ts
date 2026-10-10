import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')

export type Config = {
  port: number
  publicUrl: string
  /** Path the app is served under (from PUBLIC_URL), e.g. '/mobdaw'; '' at the root. The proxy strips it. */
  basePath: string
  sessionSecret: string
  dbPath: string
  storageDriver: 'local' | 's3'
  storageDir: string
  s3Bucket: string
  s3Region: string
  maxUploadBytes: number
  userQuotaBytes: number
  /** Dev only (DEV_NO_AUTH): every request is signed in as the account with role 'dev'; no login. Localhost only. */
  devNoAuth: boolean
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const storageDriver = (env.STORAGE_DRIVER ?? 'local') as Config['storageDriver']
  if (storageDriver !== 'local' && storageDriver !== 's3') throw new Error('STORAGE_DRIVER must be local or s3')
  // A random per-boot secret is only acceptable locally (it logs everyone out on restart).
  const host = new URL(env.PUBLIC_URL ?? 'http://localhost:5173').hostname
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(host)
  if (!local && !env.SESSION_SECRET) throw new Error('SESSION_SECRET is required when PUBLIC_URL is not localhost')
  if (storageDriver === 's3' && !(env.S3_BUCKET && env.S3_REGION)) throw new Error('S3_BUCKET and S3_REGION are required')
  const devNoAuth = !!env.DEV_NO_AUTH && env.DEV_NO_AUTH !== '0'
  if (devNoAuth && !local) throw new Error('DEV_NO_AUTH is only allowed when PUBLIC_URL is localhost')
  return {
    port: Number(env.PORT ?? 8787),
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
    basePath: new URL(env.PUBLIC_URL ?? 'http://localhost:5173').pathname.replace(/\/$/, ''),
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    dbPath: resolve(repoRoot, env.DB_PATH ?? './data/mobdaw.db'),
    storageDriver,
    storageDir: resolve(repoRoot, env.STORAGE_DIR ?? './data/samples'),
    s3Bucket: env.S3_BUCKET ?? '',
    s3Region: env.S3_REGION ?? '',
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 4294967296),
    userQuotaBytes: Number(env.USER_QUOTA_BYTES ?? 42949672960),
    devNoAuth,
  }
}
