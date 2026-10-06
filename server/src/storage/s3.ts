import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Config } from '../config.ts'
import { isHash, type Storage } from './index.ts'

export class S3Storage implements Storage {
  private s3: S3Client
  private bucket: string

  constructor(config: Config) {
    this.bucket = config.s3Bucket
    // Credentials come from the default AWS chain (e.g. EC2 instance role).
    // WHEN_REQUIRED stops the SDK adding its own default CRC32 checksum to presigned URLs.
    this.s3 = new S3Client({ region: config.s3Region, requestChecksumCalculation: 'WHEN_REQUIRED' })
  }

  private key = (hash: string, proof?: string) => (proof ? `proofs/${hash}/${proof}` : `samples/${hash}`)

  async uploadUrl(hash: string, size: number, mime: string, proof?: string) {
    const checksum = Buffer.from(hash, 'hex').toString('base64')
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(hash, proof),
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

  downloadUrl(hash: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }), { expiresIn: 900 })
  }

  async size(hash: string, proof?: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(hash, proof) }))
      return r.ContentLength ?? null
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound' || (e as any).$metadata?.httpStatusCode === 404) return null
      throw e
    }
  }

  async list() {
    const hashes: string[] = []
    let token: string | undefined
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: 'samples/', ContinuationToken: token }))
      for (const o of r.Contents ?? []) if (o.Key && isHash(o.Key.slice(8))) hashes.push(o.Key.slice(8))
      token = r.NextContinuationToken
    } while (token)
    return hashes
  }

  async delete(hash: string, proof?: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(hash, proof) }))
  }
}
