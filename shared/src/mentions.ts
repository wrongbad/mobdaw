// @mentions in chat. A handle is `@username`; an API participant ("k (api)") has the handle `@k(api)`. `(` can't appear in a
// username (USERNAME_RE), so the two never collide. Matching is against the known handles only, case-insensitive.

const API_SUFFIX = ' (api)'
/** The display name of the API identity of a user ("k" -> "k (api)"). */
export const apiName = (username: string) => `${username}${API_SUFFIX}`
export const isApiName = (name: string) => name.endsWith(API_SUFFIX)
/** The handle (with the `@`) that mentions a display name: "k" -> "@k", "k (api)" -> "@k(api)". */
export const mentionHandle = (displayName: string) => `@${isApiName(displayName) ? `${displayName.slice(0, -API_SUFFIX.length)}(api)` : displayName}`
/** The display name a handle (with or without the `@`) stands for: "@k(api)" -> "k (api)". */
export const handleName = (handle: string) => {
  const h = handle.replace(/^@/, '')
  return /\(api\)$/i.test(h) ? apiName(h.slice(0, -5)) : h
}

export type MentionSegment = { text: string; /** The display name mentioned, when this segment is a mention. */ mention?: string }

const NAME_CHAR = /[a-z0-9_]/i
const PREV_BLOCK = /[a-z0-9_.@-]/i // an `@` right after one of these is part of a word (an email), not a mention

/** The text cut into plain and mention segments. `handles` are the known handles, with or without the `@`. */
export function splitMentions(text: string, handles: string[]): MentionSegment[] {
  const known = [...new Set(handles.map((h) => h.replace(/^@/, '')))].filter(Boolean).sort((a, b) => b.length - a.length)
  const out: MentionSegment[] = []
  let plain = 0
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (i > 0 && PREV_BLOCK.test(text[i - 1])) continue
    const lower = text.slice(i + 1, i + 1 + 40).toLowerCase()
    const hit = known.find((h) => {
      if (!lower.startsWith(h.toLowerCase())) return false
      const next = text[i + 1 + h.length]
      if (next == null) return true
      if (NAME_CHAR.test(next)) return false
      // `.` or `-` followed by a name character continues a longer name ("@ann.smith"); at the end of a sentence it doesn't
      return !((next === '.' || next === '-') && NAME_CHAR.test(text[i + 2 + h.length] ?? ''))
    })
    if (!hit) continue
    if (i > plain) out.push({ text: text.slice(plain, i) })
    out.push({ text: text.slice(i, i + 1 + hit.length), mention: handleName(hit) })
    plain = i + 1 + hit.length
    i = plain - 1
  }
  if (plain < text.length) out.push({ text: text.slice(plain) })
  return out
}

/** The display names mentioned in `text` (once each, in order of appearance). */
export function parseMentions(text: string, handles: string[]): string[] {
  const names: string[] = []
  for (const s of splitMentions(text, handles)) if (s.mention && !names.includes(s.mention)) names.push(s.mention)
  return names
}
