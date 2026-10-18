import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCAL_KEEP, backupDb } from '../src/backup.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'

const DAY = 86400000

describe('backupDb (local)', () => {
  it('writes a readable snapshot and keeps only the newest LOCAL_KEEP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mobdaw-backup-'))
    try {
      const config = loadConfig({ DB_PATH: join(dir, 'mobdaw.db') })
      const db = openDb(config.dbPath)
      db.prepare("INSERT INTO settings(key, value) VALUES('probe', 'x')").run()
      const start = Date.UTC(2026, 0, 1)
      let out = ''
      for (let d = 0; d < LOCAL_KEEP + 3; d++) out = await backupDb(config, db, start + d * DAY)
      await backupDb(config, db, start + (LOCAL_KEEP + 2) * DAY) // same day again: replaced, not an error

      const files = readdirSync(join(dir, 'backups')).sort()
      expect(files).toHaveLength(LOCAL_KEEP)
      expect(files.at(-1)).toBe('mobdaw-2026-01-10.db')
      expect(existsSync(out)).toBe(true)
      const copy = new DatabaseSync(out, { readOnly: true })
      expect(copy.prepare("SELECT value FROM settings WHERE key = 'probe'").get()).toEqual({ value: 'x' })
      copy.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
