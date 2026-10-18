import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'
import type { Db } from './db.ts'

/** Local backups kept next to the DB (s3 backups expire by a bucket lifecycle rule instead). */
export const LOCAL_KEEP = 7

/**
 * Snapshot the database (VACUUM INTO: consistent while the server keeps writing) and store it as
 * `mobdaw-YYYY-MM-DD.db`: under `backups/` in the bucket with STORAGE_DRIVER=s3, else in `backups/` next to
 * the DB, keeping the newest LOCAL_KEEP. Returns where it went.
 */
export async function backupDb(config: Config, db: Db, now = Date.now()): Promise<string> {
  const name = `mobdaw-${new Date(now).toISOString().slice(0, 10)}.db`
  if (config.storageDriver === 's3') {
    const tmp = join(tmpdir(), `${name}.${process.pid}`)
    try {
      db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`)
      const s3 = new S3Client({ region: config.s3Region })
      await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: `backups/${name}`, Body: readFileSync(tmp) }))
      return `s3://${config.s3Bucket}/backups/${name}`
    } finally {
      rmSync(tmp, { force: true })
    }
  }
  const dir = join(dirname(config.dbPath), 'backups')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, name)
  rmSync(out, { force: true }) // VACUUM INTO refuses to overwrite (a second run on the same day)
  db.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`)
  const old = readdirSync(dir).filter((f) => /^mobdaw-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -LOCAL_KEEP)
  for (const f of old) rmSync(join(dir, f))
  return out
}
