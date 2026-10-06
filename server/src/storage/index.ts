import type { Hono } from 'hono'
import type { Config } from '../config.ts'
import { LocalStorage } from './local.ts'
import { S3Storage } from './s3.ts'

export interface Storage {
  // `proof`: a per-requester token; the object then lives at proofs/<hash>/<proof>, outside samples/.
  /** Where (and how) the client should PUT the bytes. */
  uploadUrl(hash: string, size: number, mime: string, proof?: string): Promise<{ url: string; headers: Record<string, string> }>
  /** Signed GET url valid for 15 minutes. */
  downloadUrl(hash: string): Promise<string>
  /** Size of the stored object, or null if missing. */
  size(hash: string, proof?: string): Promise<number | null>
  /** Delete the stored object; no-op if missing. */
  delete(hash: string, proof?: string): Promise<void>
  /** Drop abandoned proof objects older than `ms` (local only; S3 uses a bucket lifecycle rule on proofs/). */
  expireProofs?(ms: number): Promise<void>
  /** Hashes of every stored object (for the audit CLI). */
  list(): Promise<string[]>
  /** Extra routes (mounted at /api/storage) for drivers that serve bytes themselves. */
  routes?: Hono
}

export const isHash = (s: string) => /^[0-9a-f]{64}$/.test(s)

export function createStorage(config: Config, getMime: (hash: string) => string | undefined): Storage {
  return config.storageDriver === 's3' ? new S3Storage(config) : new LocalStorage(config, getMime)
}
