import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// Stored as `scrypt$N$r$p$salt$hash` (base64url), so the cost can be raised later without breaking old hashes.
const N = 2 ** 16, R = 8, P = 1, KEYLEN = 64
const MAXMEM = 256 * 1024 * 1024

const derive = (password: string, salt: Buffer, n: number, r: number, p: number, keylen: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (e, key) => (e ? reject(e) : resolve(key))),
  )

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, N, R, P, KEYLEN)
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$')
}

/** Resolves false (never throws) for a wrong password or a malformed stored hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  try {
    const want = Buffer.from(hash, 'base64url')
    const got = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p), want.length)
    return want.length === got.length && timingSafeEqual(want, got)
  } catch {
    return false
  }
}

// Verified against when the username doesn't exist, so a miss costs the same as a wrong password.
let dummy: Promise<string> | undefined
export const burnPasswordCheck = async (password: string) => void (await verifyPassword(password, await (dummy ??= hashPassword('dummy'))))

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 200 // scrypt time is independent of length, but don't hash megabytes
export const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/
