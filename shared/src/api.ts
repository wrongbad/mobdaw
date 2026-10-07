// Request/response types for the HTTP API (all routes live under /api).
// Errors are `{ error: string }` with a suitable HTTP status.

export type ApiError = { error: string }
// Known codes: not_signed_in(401) invalid_credentials(401) too_many_attempts(429) forbidden(403) quota_exceeded(403)
// bad_username(400) bad_password(400) username_taken(409) invite_invalid(400) invite_used(410) invite_expired(410)
// not_admitted(400, unknown user) not_found(404) too_large(413)
// hash_mismatch(400) bad_request(400) sample_deleting(409) owner_cannot_leave(400) upload_expired(410)

export type LoginRequest = { username: string; password: string }
export type RegisterRequest = { username: string; password: string; invite: string }
export type LoginResponse = { token: string; me: Me }

export type Me = {
  username: string
  isAdmin: boolean
  bytesUsed: number
  quotaBytes: number
}

export type CreateInviteRequest = { expiresInDays?: number }
export type CreateInviteResponse = { token: string; url: string }
export type InviteInfo = {
  token: string
  createdBy: string
  createdAt: number
  expiresAt: number | null
  redeemedBy: string | null
  redeemedAt: number | null
}

export type UserInfo = { username: string }

export type Role = 'owner' | 'editor' | 'viewer'
export type ProjectSummary = { id: string; name: string; ownerUsername: string; createdAt: number; role: Role }
export type Member = { username: string; role: Role }
export type ProjectDetail = ProjectSummary & { members: Member[] }
export type CreateProjectRequest = { name: string }
export type AddMemberRequest = { username: string; role?: 'editor' | 'viewer' }
export type RenameProjectRequest = { name: string }
export type CopyProjectRequest = { name?: string }
export type LibrarySample = { hash: string; size: number; mime: string; addedBy: string; addedAt: number }

export type UploadUrlRequest = { hash: string; size: number; mime: string }
export type UploadUrlResponse =
  | { exists: true }
  | { exists: false; url: string; method: 'PUT'; headers: Record<string, string> }
export type UrlResponse = { url: string }
export type OkResponse = { ok: true }
