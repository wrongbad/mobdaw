const MESSAGES: Record<string, string> = {
  quota_exceeded: 'Your storage is full. Delete some uploads to make room.',
  too_large: 'That file is over the 4 GiB upload limit.',
  account_read_only: 'Your subscription has ended, so your account is read-only.',
  project_frozen: "This project's owner's subscription has ended, so it is read-only.",
  forbidden: "You don't have permission to do that.",
  not_found: 'Not found.',
  wrong_password: 'Wrong password.',
  not_signed_in: 'Please sign in again.',
  sample_deleting: 'That file is still being deleted. Try again in a moment.',
  upload_expired: 'The upload took too long. Try again.',
}

/** A message fit for the screen from an API error (or any error). */
export const describeError = (e: unknown) => MESSAGES[(e as Error).message] ?? (e as Error).message ?? String(e)
