// Nightly DB snapshot (src/backup.ts). The box runs it via deploy/backup; also fine by hand.
import { backupDb } from '../src/backup.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'

const config = loadConfig()
console.log(`backed up to ${await backupDb(config, openDb(config.dbPath))}`)
