const MESSAGES: Record<string, string> = {
  quota_exceeded: 'your storage is full. delete some uploads to make room.',
  too_large: 'that file is over the 4 gib upload limit.',
  account_read_only: 'your subscription has ended, so your account is read-only.',
  project_frozen: "this project's owner's subscription has ended, so it is read-only.",
  forbidden: "you don't have permission to do that.",
  not_found: 'not found.',
  wrong_password: 'wrong password.',
  not_signed_in: 'please sign in again.',
  sample_deleting: 'that file is still being deleted. try again in a moment.',
  upload_expired: 'the upload took too long. try again.',
}

/** A message fit for the screen from an API error (or any error). */
export const describeError = (e: unknown) => MESSAGES[(e as Error).message] ?? (e as Error).message ?? String(e)
