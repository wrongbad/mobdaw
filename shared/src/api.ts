// Request/response types for the HTTP API (all routes live under /api).
// Errors are `{ error: string }` with a suitable HTTP status.

export type ApiError = { error: string }
// Known codes: not_signed_in(401) invalid_credentials(401) too_many_attempts(429) forbidden(403) quota_exceeded(403)
// bad_username(400) bad_password(400) username_taken(409) invite_invalid(400) invite_used(410) invite_expired(410)
// not_admitted(400, unknown user) not_found(404) too_large(413)
// hash_mismatch(400) bad_request(400) sample_deleting(409) owner_cannot_leave(400) upload_expired(410)
// account_read_only(403) project_frozen(403) wrong_password(403)
// proof_required(409, re-request the upload URL and upload again)

export type LoginRequest = { username: string; password: string }
export type RegisterRequest = { username: string; password: string; invite: string }
export type LoginResponse = { token: string; me: Me }

export type Me = {
  username: string
  isAdmin: boolean
  bytesUsed: number
  quotaBytes: number
  /**
   * 'read_only' once the subscription has ended: play, download and delete only, until `retentionEndsAt`, when the cloud
   * data is deleted. 'lapsed' after that: the account remains, empty and read-only, until time is added.
   */
  planStatus: 'active' | 'read_only' | 'lapsed'
  retentionEndsAt: number | null
  /** Pre-paid time: the account stays active until this (ms). When it passes, the subscription ends. */
  paidThrough: number
}

/** `giftMonths`: pre-paid months the new account starts with (0-999, default 1). */
export type CreateInviteRequest = { expiresInDays?: number; giftMonths?: number }
export type CreateInviteResponse = { token: string; url: string }
export type InviteInfo = {
  token: string
  createdBy: string
  createdAt: number
  expiresAt: number | null
  redeemedBy: string | null
  redeemedAt: number | null
  giftMonths: number
}

export type UserInfo = { username: string }

export type Role = 'owner' | 'editor' | 'viewer'
export type ProjectSummary = {
  id: string; name: string; ownerUsername: string; createdAt: number; role: Role
  /** The owner's subscription has ended: nobody can edit until they resubscribe, and it is deleted at `retentionEndsAt`. */
  frozen: boolean
  retentionEndsAt: number | null
}
export type Member = { username: string; role: Role }
export type ProjectDetail = ProjectSummary & { members: Member[] }
export type CreateProjectRequest = { name: string }
export type AddMemberRequest = { username: string; role?: 'editor' | 'viewer' }
export type RenameProjectRequest = { name: string }
export type CopyProjectRequest = { name?: string }
/** An audio file in a project's library. `owner` is the user who uploaded it (and can delete it). */
export type LibrarySample = { hash: string; size: number; mime: string; owner: string; addedAt: number }

/** One of the caller's own uploads, with the projects that use it. */
export type UploadInfo = {
  hash: string
  name: string
  size: number
  mime: string
  createdAt: number
  projects: { id: string; name: string }[]
  /** Projects using it that the caller can no longer see (e.g. after leaving). */
  otherProjects: number
}

export type UploadUrlRequest = { hash: string; size: number; mime: string; name?: string }
export type UploadUrlResponse =
  | { exists: true }
  | { exists: false; url: string; method: 'PUT'; headers: Record<string, string> }
export type UrlResponse = { url: string }
export type OkResponse = { ok: true }
