// Request/response types for the HTTP API (all routes live under /api).
// Errors are `{ error: string }` with a suitable HTTP status.

export type ApiError = { error: string }
// Known codes: not_signed_in(401) not_invited(403) forbidden(403) quota_exceeded(403)
// not_admitted(400) invite_used(410) invite_expired(410) not_found(404) too_large(413)
// hash_mismatch(400) bad_request(400) sample_deleting(409) owner_cannot_leave(400) upload_expired(410)

export type ConfigResponse = { authMode: 'dev' | 'google'; googleClientId: string | null }

export type LoginRequest = { email: string; name?: string } | { idToken: string }
export type LoginResponse = { token: string; me: Me }

export type Me = {
  email: string
  name: string
  admitted: boolean
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

export type UserInfo = { email: string; name: string }

export type Role = 'owner' | 'editor' | 'viewer'
export type ProjectSummary = { id: string; name: string; ownerEmail: string; createdAt: number; role: Role }
export type Member = { email: string; name: string; role: Role }
export type ProjectDetail = ProjectSummary & { members: Member[] }
export type CreateProjectRequest = { name: string }
export type AddMemberRequest = { email: string; role?: 'editor' | 'viewer' }
export type RenameProjectRequest = { name: string }
export type CopyProjectRequest = { name?: string }
export type LibrarySample = { hash: string; size: number; mime: string; addedBy: string; addedAt: number }

export type UploadUrlRequest = { hash: string; size: number; mime: string }
export type UploadUrlResponse =
  | { exists: true }
  | { exists: false; url: string; method: 'PUT'; headers: Record<string, string> }
export type UrlResponse = { url: string }
export type OkResponse = { ok: true }
