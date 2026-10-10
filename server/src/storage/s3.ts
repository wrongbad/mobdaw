import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Config } from '../config.ts'
import { isHash, objectKey, parseKey, parseLegacyKey, type LegacyOwners, type Storage, type StoredObject } from './index.ts'

export class S3Storage implements Storage {
  private s3: S3Client
  private bucket: string

  constructor(config: Config) {
    this.bucket = config.s3Bucket
    // Credentials come from the default AWS chain (e.g. EC2 instance role).
    // WHEN_REQUIRED stops the SDK adding its own default CRC32 checksum to presigned URLs.
    this.s3 = new S3Client({ region: config.s3Region, requestChecksumCalculation: 'WHEN_REQUIRED' })
  }

  private key = (owner: number, hash: string) => `samples/${objectKey(owner, hash)}`

  async uploadUrl(owner: number, hash: string, size: number, mime: string) {
    const checksum = Buffer.from(hash, 'hex').toString('base64')
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(owner, hash),
        ContentLength: size,
        ContentType: mime,
        ChecksumSHA256: checksum,
      }),
      {
        expiresIn: 900,
        signableHeaders: new Set(['content-type', 'content-length']),
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      },
    )
    // Content-Length is set by the browser automatically.
    return { url, headers: { 'Content-Type': mime, 'x-amz-checksum-sha256': checksum } }
  }

  downloadUrl(owner: number, hash: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: this.key(owner, hash) }), { expiresIn: 900 })
  }

  async size(owner: number, hash: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(owner, hash) }))
      return r.ContentLength ?? null
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound' || (e as any).$metadata?.httpStatusCode === 404) return null
      throw e
    }
  }

  async copy(from: number, to: number, hash: string) {
    await this.copyKey(this.key(from, hash), this.key(to, hash))
  }

  // Keys are hex digits, 'u' and '/', so CopySource needs no escaping. The content type is copied along.
  private async copyKey(from: string, to: string) {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${from}`, Key: to }))
  }

  /** Every key under samples/, without the prefix. */
  private async keys() {
    const keys: string[] = []
    let token: string | undefined
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: 'samples/', ContinuationToken: token }))
      for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key.slice('samples/'.length))
      token = r.NextContinuationToken
    } while (token)
    return keys
  }

  async list() {
    return (await this.keys()).map(parseKey).filter((o): o is StoredObject => !!o)
  }

  async delete(owner: number, hash: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(owner, hash) }))
  }

  async migrateLayout(legacy: LegacyOwners) {
    for (const key of await this.keys()) {
      try {
        if (isHash(key)) {
          // Oldest layout: samples/<hash>, one copy per owner. (Old proofs/ objects are left to the bucket's lifecycle rule.)
          for (const owner of legacy.ownersOf(key)) await this.copyKey(`samples/${key}`, this.key(owner, key))
        } else {
          // Previous layout: samples/<hex(username)>/<hash>.
          const old = parseLegacyKey(key)
          const id = old ? legacy.userId(old.username) : undefined
          if (!old || id === undefined) continue // gone user: left for `audit` to report
          await this.copyKey(`samples/${key}`, this.key(id, old.hash))
        }
        await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: `samples/${key}` }))
      } catch (e) {
        console.error(`storage migration: ${key}`, e)
      }
    }
  }
}
