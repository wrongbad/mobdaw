import { audit, isClean } from '../src/audit.ts'
import { upsertUser } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { createInvite, listInvites } from '../src/routes/invites.ts'
import { createStorage } from '../src/storage/index.ts'

const [cmd, ...args] = process.argv.slice(2)
const config = loadConfig()
const ctx = { config, db: openDb(config.dbPath) }

if (cmd === 'create-invite') {
  const i = args.indexOf('--days')
  const days = i >= 0 ? Number(args[i + 1]) : undefined
  if (i >= 0 && !(days! > 0)) throw new Error('--days needs a positive number')
  const createdBy = config.adminEmails[0] ?? 'cli'
  console.log(createInvite(ctx, createdBy, days).url)
} else if (cmd === 'list-invites') {
  for (const i of listInvites(ctx)) {
    const status = i.redeemedBy ? `redeemed by ${i.redeemedBy}` : i.expiresAt && i.expiresAt < Date.now() ? 'expired' : 'open'
    console.log(`${i.token}  ${new Date(i.createdAt).toISOString()}  ${status}`)
  }
} else if (cmd === 'add-user' && args[0]) {
  upsertUser(ctx, args[0].toLowerCase(), '')
  console.log(`added ${args[0].toLowerCase()}`)
} else if (cmd === 'tree') {
  const q = <T>(sql: string, ...p: string[]) => ctx.db.prepare(sql).all(...p) as T[]
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
  const users = q<{ email: string; is_admin: number; bytes_used: number }>('SELECT * FROM users ORDER BY email')
  console.log('users')
  for (const u of users) console.log(`  ${u.email}${u.is_admin ? ' (admin)' : ''}  ${kb(u.bytes_used)} used`)
  console.log('projects')
  for (const u of users) {
    const projects = q<{ id: string; name: string }>('SELECT id, name FROM projects WHERE owner_email = ? ORDER BY created_at', u.email)
    if (!projects.length) continue
    console.log(`  ${u.email}`)
    for (const p of projects) {
      const members = q<{ email: string; role: string }>("SELECT email, role FROM project_members WHERE project_id = ? AND role != 'owner' ORDER BY email", p.id)
      console.log(`    ${p.name} [${p.id}]  members: ${members.map((m) => `${m.email} (${m.role})`).join(', ') || 'none'}`)
      const lib = q<{ hash: string; size: number; uploaded_by: string }>(
        'SELECT s.hash, s.size, s.uploaded_by FROM project_samples ps JOIN samples s ON s.hash = ps.hash WHERE ps.project_id = ? ORDER BY ps.added_at', p.id)
      for (const s of lib) console.log(`      ${s.hash.slice(0, 8)}  ${kb(s.size)}  by ${s.uploaded_by}`)
    }
  }
  const [t] = q<{ users: number; projects: number; samples: number; bytes: number }>(
    `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM projects) AS projects,
            (SELECT COUNT(*) FROM samples) AS samples, (SELECT COALESCE(SUM(size), 0) FROM samples) AS bytes`)
  console.log(`totals: ${t.users} users, ${t.projects} projects, ${t.samples} samples, ${kb(t.bytes)} stored`)
} else if (cmd === 'audit') {
  const fix = args.includes('--fix')
  const storage = createStorage(config, () => undefined)
  const r = await audit(ctx, storage, fix)
  const show = (label: string, items: string[]) => items.length && console.log(`${label}:\n${items.map((i) => `  ${i}`).join('\n')}`)
  show('leaked objects (no samples row)', r.leaked)
  show('broken (complete row, no object)', r.broken)
  show('unreferenced (complete, no project links)', r.unreferenced)
  show('bytes_used drift', r.drift.map((d) => `${d.email}: recorded ${d.recorded}, expected ${d.expected}`))
  if (isClean(r)) console.log('audit: clean')
  else if (fix) console.log('fixed: leaked objects deleted, bytes_used recomputed (broken/unreferenced need a human)')
  // --fix repairs leaks and drift; only broken/unreferenced findings remain a failure.
  process.exit(isClean(fix ? { ...r, leaked: [], drift: [] } : r) ? 0 : 1)
} else {
  console.error('usage: npm run admin -- create-invite [--days N] | list-invites | add-user <email> | tree | audit [--fix]')
  process.exit(1)
}
