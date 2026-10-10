import { audit, isClean } from '../src/audit.ts'
import { RETENTION_MS, endExpiredSubscriptions, endSubscription, giftMonths, purgeExpiredData, resumeSubscription } from '../src/accounts.ts'
import { createUser, findUser, getUser } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { DEFAULT_GIFT_MONTHS, createInvite, listInvites, validGiftMonths } from '../src/routes/invites.ts'
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_RE, hashPassword } from '../src/password.ts'
import { createStorage } from '../src/storage/index.ts'

const [cmd, ...args] = process.argv.slice(2)
const config = loadConfig()
const ctx = { config, db: openDb(config.dbPath) }

/** Read a password from the terminal without echoing it (or from MOBDAW_PASSWORD, for scripts). */
async function askPassword(): Promise<string> {
  if (process.env.MOBDAW_PASSWORD) return process.env.MOBDAW_PASSWORD
  const { createInterface } = await import('node:readline')
  const muted = new (await import('node:stream')).Writable({ write: (_c, _e, cb) => cb() })
  const ask = (q: string) =>
    new Promise<string>((resolve) => {
      process.stdout.write(q)
      const rl = createInterface({ input: process.stdin, output: muted, terminal: true })
      rl.question('', (a) => (rl.close(), process.stdout.write('\n'), resolve(a)))
    })
  const pw = await ask('password: ')
  if (pw !== (await ask('again: '))) throw new Error('passwords do not match')
  if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) throw new Error(`password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`)
  return pw
}
/** The account named on the command line (usernames are lowercase). */
const needUser = (name?: string) => {
  const username = name?.trim().toLowerCase() ?? ''
  if (!username) throw new Error('username required')
  const user = findUser(ctx.db, username)
  if (!user) throw new Error(`no such user: ${username}`)
  return user
}
const usernameArg = (name?: string) => {
  const username = name?.trim().toLowerCase() ?? ''
  if (!username) throw new Error('username required')
  return username
}

if (cmd === 'create-invite') {
  const i = args.indexOf('--days')
  const days = i >= 0 ? Number(args[i + 1]) : undefined
  if (i >= 0 && !(days! > 0)) throw new Error('--days needs a positive number')
  const m = args.indexOf('--months')
  const months = m >= 0 ? Number(args[m + 1]) : DEFAULT_GIFT_MONTHS
  if (!validGiftMonths(months)) throw new Error('--months needs a whole number from 0 to 999')
  console.log(createInvite(ctx, 'cli', days, months).url)
} else if (cmd === 'list-invites') {
  for (const i of listInvites(ctx)) {
    const status = i.redeemedBy ? `redeemed by ${i.redeemedBy}` : i.expiresAt && i.expiresAt < Date.now() ? 'expired' : 'open'
    console.log(`${i.token}  ${new Date(i.createdAt).toISOString()}  ${i.giftMonths} months  ${status}`)
  }
} else if (cmd === 'create-user') {
  const username = usernameArg(args[0])
  if (!USERNAME_RE.test(username)) throw new Error('username must be 3-32 chars of a-z 0-9 _ . - (starting with a letter or digit)')
  if (findUser(ctx.db, username)) throw new Error(`${username} already exists`)
  const m = args.indexOf('--months')
  const months = m >= 0 ? Number(args[m + 1]) : undefined
  if (months !== undefined && !validGiftMonths(months)) throw new Error('--months needs a whole number from 0 to 999')
  const id = await createUser(ctx, username, await askPassword(), args.includes('--admin'), months)
  console.log(`created ${username} (id ${id})${args.includes('--admin') ? ' (admin)' : ''}`)
} else if (cmd === 'passwd') {
  const user = needUser(args[0])
  ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(await askPassword()), user.id)
  console.log(`password updated for ${user.username}`)
} else if (cmd === 'make-admin') {
  const user = needUser(args[0])
  ctx.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id)
  console.log(`${user.username} is now an admin`)
} else if (cmd === 'gift') {
  // Add pre-paid months to an account (also restores one that ran out, if it is still within its retention window).
  const user = needUser(args[0])
  const months = Number(args[1])
  if (!validGiftMonths(months) || months < 1) throw new Error('usage: gift <username> <months, 1-999>')
  const until = giftMonths(ctx, null, user.id, months)!
  console.log(`${user.username} is now paid through ${new Date(until).toISOString().slice(0, 10)}`)
} else if (cmd === 'set-plan') {
  // Until a payment provider is wired in, this is how a subscription is ended or restored.
  const { id, username } = needUser(args[0])
  if (args[1] === 'ended') {
    if (!endSubscription(ctx, null, id)) throw new Error(`${username} is not an active account`)
    console.log(`${username} is read-only; their cloud data is deleted in ${RETENTION_MS / 86400_000} days unless time is added (a running server enforces read-only within a minute)`)
  } else if (args[1] === 'active') {
    console.log(resumeSubscription(ctx, null, id) ? `${username} is active again` : `${username} was already active`)
    const { paid_through } = getUser(ctx.db, id)!
    if (paid_through <= Date.now()) console.log(`warning: ${username}'s pre-paid time has run out, so the next sweep ends the subscription again; use \`gift\` to add months`)
  } else throw new Error('usage: set-plan <username> active|ended')
} else if (cmd === 'purge-expired') {
  const ended = endExpiredSubscriptions(ctx, null)
  const names = (ids: number[]) => ids.map((id) => getUser(ctx.db, id)?.username ?? `#${id}`).join(', ')
  if (ended.length) console.log(`subscription ended (pre-paid time ran out): ${names(ended)}`)
  const purged = await purgeExpiredData(ctx, createStorage(config, () => undefined), null)
  console.log(purged.length ? `cloud data deleted for: ${names(purged)} (their accounts remain)` : 'nothing to purge')
} else if (cmd === 'tree') {
  const q = <T>(sql: string, ...p: (string | number)[]) => ctx.db.prepare(sql).all(...p) as T[]
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
  const users = q<{ id: number; username: string; is_admin: number; bytes_used: number; plan_status: string; retention_ends_at: number | null; paid_through: number }>('SELECT * FROM users ORDER BY username')
  console.log('users')
  for (const u of users) console.log(`  ${u.id}  ${u.username}${u.is_admin ? ' (admin)' : ''}${u.plan_status === 'read_only' ? (u.retention_ends_at ? ` (read-only, cloud data deleted ${new Date(u.retention_ends_at).toISOString().slice(0, 10)})` : ' (lapsed: cloud data deleted)') : ''}  ${kb(u.bytes_used)} used, paid through ${new Date(u.paid_through).toISOString().slice(0, 10)}`)
  console.log('projects')
  for (const u of users) {
    const projects = q<{ id: string; name: string }>('SELECT id, name FROM projects WHERE owner_id = ? ORDER BY created_at', u.id)
    if (!projects.length) continue
    console.log(`  ${u.username}`)
    for (const p of projects) {
      const members = q<{ username: string; role: string }>(
        "SELECT u.username, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND m.role != 'owner' ORDER BY u.username", p.id)
      console.log(`    ${p.name} [${p.id}]  members: ${members.map((m) => `${m.username} (${m.role})`).join(', ') || 'none'}`)
      const lib = q<{ hash: string; size: number; owner: string }>(
        `SELECT u.hash, u.size, o.username AS owner FROM project_samples ps JOIN uploads u ON u.hash = ps.hash AND u.owner_id = ps.owner_id
         JOIN users o ON o.id = ps.owner_id WHERE ps.project_id = ? ORDER BY ps.added_at`, p.id)
      for (const s of lib) console.log(`      ${s.hash.slice(0, 8)}  ${kb(s.size)}  owned by ${s.owner}`)
    }
  }
  const [t] = q<{ users: number; projects: number; uploads: number; bytes: number }>(
    `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM projects) AS projects,
            (SELECT COUNT(*) FROM uploads) AS uploads, (SELECT COALESCE(SUM(size), 0) FROM uploads) AS bytes`)
  console.log(`totals: ${t.users} users, ${t.projects} projects, ${t.uploads} uploads, ${kb(t.bytes)} owned`)
} else if (cmd === 'audit') {
  const fix = args.includes('--fix')
  const storage = createStorage(config, () => undefined)
  const r = await audit(ctx, storage, fix)
  const show = (label: string, items: string[]) => items.length && console.log(`${label}:\n${items.map((i) => `  ${i}`).join('\n')}`)
  show('leaked objects (no upload row)', r.leaked)
  show('broken (complete upload, no object)', r.broken)
  show('orphan library links (project:hash:owner id, upload not complete)', r.orphanLinks)
  show('bytes_used drift', r.drift.map((d) => `${d.username}: recorded ${d.recorded}, expected ${d.expected}`))
  if (isClean(r)) console.log('audit: clean')
  else if (fix) console.log('fixed: leaked objects deleted, bytes_used recomputed (broken/orphan links need a human)')
  // --fix repairs leaks and drift; only broken/orphan-link findings remain a failure.
  process.exit(isClean(fix ? { ...r, leaked: [], drift: [] } : r) ? 0 : 1)
} else {
  console.error('usage: npm run admin -- create-invite [--days N] [--months N] | list-invites | create-user <username> [--admin] [--months N] | gift <username> <months> | passwd <username> | make-admin <username> | set-plan <username> active|ended | purge-expired | tree | audit [--fix]')
  process.exit(1)
}
