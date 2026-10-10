import type { Hono } from 'hono'
import type { Config } from '../config.ts'
import { LocalStorage } from './local.ts'
import { S3Storage } from './s3.ts'

// Every owner's upload is its own object, keyed `u<owner id>/<hash>`: identical files from two users are stored
// twice, and a username can change without touching storage.
export interface Storage {
  /** Where (and how) the client should PUT the bytes. */
  uploadUrl(owner: number, hash: string, size: number, mime: string): Promise<{ url: string; headers: Record<string, string> }>
  /** Signed GET url valid for 15 minutes. */
  downloadUrl(owner: number, hash: string): Promise<string>
  /** Size of the stored object, or null if missing. */
  size(owner: number, hash: string): Promise<number | null>
  /** Server-side copy of one owner's object to another owner. Throws if the source is missing. */
  copy(from: number, to: number, hash: string): Promise<void>
  /** Delete the stored object; no-op if missing. */
  delete(owner: number, hash: string): Promise<void>
  /** Every stored object (for the audit CLI). */
  list(): Promise<StoredObject[]>
  /**
   * One-time move from the older layouts to `u<owner id>/<hash>`: the very first one (one object per hash, copied to each of
   * its owners) and the one keyed by hex-encoded username. Safe to re-run; a failed move leaves the old object for next time.
   */
  migrateLayout(legacy: LegacyOwners): Promise<void>
  /** Extra routes (mounted at /api/storage) for drivers that serve bytes themselves. */
  routes?: Hono
}

export type StoredObject = { owner: number; hash: string }

export type LegacyOwners = {
  /** Ids of the users with an upload of this file (the old shared object has one copy per owner). */
  ownersOf(hash: string): number[]
  /** The id of the user with this username, if there still is one. */
  userId(username: string): number | undefined
}

export const isHash = (s: string) => /^[0-9a-f]{64}$/.test(s)

/** `u<owner id>/<hash>` */
export const objectKey = (owner: number, hash: string) => `u${owner}/${hash}`

/** Inverse of objectKey; null for anything else. */
export function parseKey(key: string): StoredObject | null {
  const m = /^u(\d+)\/([0-9a-f]{64})$/.exec(key)
  return m ? { owner: Number(m[1]), hash: m[2] } : null
}

/** The previous layout: `<hex(username)>/<hash>`. */
export function parseLegacyKey(key: string): { username: string; hash: string } | null {
  const m = /^((?:[0-9a-f]{2})+)\/([0-9a-f]{64})$/.exec(key)
  return m ? { username: Buffer.from(m[1], 'hex').toString(), hash: m[2] } : null
}

export function createStorage(config: Config, getMime: (owner: number, hash: string) => string | undefined): Storage {
  return config.storageDriver === 's3' ? new S3Storage(config) : new LocalStorage(config, getMime)
}
