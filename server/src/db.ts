import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as Y from 'yjs'

export type Db = DatabaseSync

// Append new migrations to the end; PRAGMA user_version tracks how many have run.
const migrations: (string | ((db: Db) => void))[] = [
  `CREATE TABLE users(email TEXT PRIMARY KEY, name TEXT, is_admin INTEGER NOT NULL DEFAULT 0, bytes_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
   CREATE TABLE invites(token TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER);
   CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_email TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE project_members(project_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor')), PRIMARY KEY(project_id,email));
   CREATE TABLE documents(name TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE samples(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0);`,
  // Pass 2: viewer role, sample state (replaces `complete`), project library links.
  `CREATE TABLE project_members_new(project_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(project_id,email));
   INSERT INTO project_members_new SELECT project_id, email, role FROM project_members;
   DROP TABLE project_members;
   ALTER TABLE project_members_new RENAME TO project_members;
   ALTER TABLE samples ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','deleting'));
   UPDATE samples SET state = CASE WHEN complete = 1 THEN 'complete' ELSE 'pending' END;
   ALTER TABLE samples DROP COLUMN complete;
   CREATE TABLE project_samples(project_id TEXT NOT NULL, hash TEXT NOT NULL, added_by TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY(project_id,hash));
   CREATE INDEX project_samples_hash ON project_samples(hash);`,
  // Backfill library links from the hashes each stored doc references (its 'samples' map and clips).
  (db) => {
    const docs = db.prepare("SELECT name, data, updated_at FROM documents WHERE name LIKE 'project:%'").all() as
      { name: string; data: Uint8Array; updated_at: number }[]
    const link = db.prepare(
      `INSERT OR IGNORE INTO project_samples(project_id, hash, added_by, added_at)
       SELECT p.id, s.hash, s.uploaded_by, ? FROM projects p, samples s WHERE p.id = ? AND s.hash = ? AND s.state = 'complete'`,
    )
    for (const d of docs) {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array(d.data))
      const hashes = new Set(doc.getMap('samples').keys())
      for (const clip of doc.getMap('clips').values()) {
        const h = clip instanceof Y.Map && clip.get('sampleHash')
        if (typeof h === 'string') hashes.add(h)
      }
      for (const h of hashes) link.run(d.updated_at, d.name.slice('project:'.length), h)
    }
  },
  // Own auth (username + password) replaces Google email identities: rename the identity columns.
  // Pre-existing users have no password until an admin sets one (`npm run admin -- passwd <username>`).
  `ALTER TABLE users RENAME COLUMN email TO username;
   ALTER TABLE users DROP COLUMN name;
   ALTER TABLE users ADD COLUMN password_hash TEXT;
   ALTER TABLE projects RENAME COLUMN owner_email TO owner_username;
   ALTER TABLE project_members RENAME COLUMN email TO username;`,
  // Account role: 'dev' marks the passwordless account used by DEV_NO_AUTH (only honoured while that mode is on).
  `ALTER TABLE users ADD COLUMN account_role TEXT NOT NULL DEFAULT 'user' CHECK(account_role IN ('user','dev'));`,
]

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = user_version; v < migrations.length; v++) {
    db.exec('BEGIN')
    try {
      const m = migrations[v]
      if (typeof m === 'string') db.exec(m)
      else m(db)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return db
}

/** Run fn inside a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
