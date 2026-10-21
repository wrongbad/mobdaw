// Put a WAV into a cloud project as an audio clip, the way the client does when a user records a take (client/src/samples.ts
// `uploadToProject`, client/src/takes.ts): sign in with a password, upload the file through the session routes (upload-url, PUT,
// complete), then join the project's collab document and run the shared `addSample` + `addAudioClip`. For end-to-end tests of
// anything that listens to a take (agent/tests/e2e_audio_live.py); there is deliberately no agent route that does this.
//
//   MOBDAW_PASSWORD=... npx tsx tools/seed-take.ts --user e2e --project <id> --wav take.wav [--track Guitar] [--bar 1] [--incoming [ms]]
//   MOBDAW_PASSWORD=... npx tsx tools/seed-take.ts --user e2e --new-project "E2E" --wav take.wav --mint-token
//   MOBDAW_PASSWORD=... npx tsx tools/seed-take.ts --user e2e --project <id> --chat "@e2e(api) bass for Guitar"
//
// --url         server base (default $MOBDAW_URL or http://localhost:8787)
// --user        account to sign in as (password from $MOBDAW_PASSWORD, or --password); the clip is attributed to it
// --project     project id, or --new-project NAME to create one first
// --wav         the file to upload; any WAV with a PCM/float header is read for its duration (other formats: pass --duration)
// --track       audio track to put the clip on (found by name, else created; default "Audio")
// --bar         where the clip starts, in project bars (default 1; fractional bars interpolate); converted with the project's time map
// --length-bars clip length (default: the whole sample)
// --incoming    add the sample with status 'incoming' first (as a recorded take that is still on the recorder's device), clear it
//               after MS (default 3000), and only then exit: exercises the `sample` agent event
// --chat        post this text in the project's chat as the signed-in user (as a browser does); --wav is then optional, and with
//               both the take goes first. The message is what an agent sees as a chat event (mentionsMe if it names its handle)
// --mint-token  also create an API token for the user and print it (use it as MOBDAW_TOKEN)
// Prints one JSON object: {project, track, clipId, hash, token?}.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { addAudioClip, addChatMessage, addSample, addTrack, apiName, docName, getSampleRate, getTimeMap, getTracks, mentionHandle, setSampleStatus, type SampleMeta } from '../shared/src/index.ts'

const { values: a } = parseArgs({
  options: {
    url: { type: 'string' }, user: { type: 'string' }, password: { type: 'string' }, project: { type: 'string' }, 'new-project': { type: 'string' },
    wav: { type: 'string' }, track: { type: 'string', default: 'Audio' }, bar: { type: 'string', default: '1' }, 'length-bars': { type: 'string' },
    duration: { type: 'string' }, chat: { type: 'string' }, incoming: { type: 'string' }, 'mint-token': { type: 'boolean' },
  },
  allowPositionals: false,
})
const die = (msg: string): never => (console.error(`seed-take: ${msg}`), process.exit(1))
const base = (a.url ?? process.env.MOBDAW_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const password = a.password ?? process.env.MOBDAW_PASSWORD
if (!a.user || !password) die('--user and a password (MOBDAW_PASSWORD or --password) are required')
if (!a.wav && !a.chat) die('--wav (or --chat) is required')
if (!a.project && !a['new-project']) die('--project or --new-project is required')
const incoming = a.incoming !== undefined
const incomingMs = Number(a.incoming || 3000)

let token = ''
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) die(`${method} ${path}: http ${res.status} ${JSON.stringify(data)}`)
  return data as T
}

/** Seconds of audio in a RIFF/WAVE file, from its fmt and data chunks. */
function wavSeconds(bytes: Buffer): number {
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return die('not a WAV file (pass --duration SECONDS for other formats)')
  let rate = 0, frameBytes = 0
  for (let p = 12; p + 8 <= bytes.length; ) {
    const id = bytes.toString('latin1', p, p + 4), size = bytes.readUInt32LE(p + 4)
    if (id === 'fmt ') (rate = bytes.readUInt32LE(p + 12), frameBytes = bytes.readUInt16LE(p + 20))
    else if (id === 'data') return rate && frameBytes ? Math.min(size, bytes.length - p - 8) / frameBytes / rate : die('WAV data chunk before fmt chunk')
    p += 8 + size + (size & 1)
  }
  return die('WAV has no data chunk')
}

const bytes = a.wav ? readFileSync(a.wav) : Buffer.alloc(0)
const hash = createHash('sha256').update(bytes).digest('hex')
const duration = !a.wav ? 0 : a.duration ? Number(a.duration) : wavSeconds(bytes)
const name = basename(a.wav ?? '').replace(/\.[^.]+$/, '')
const mime = /\.wav$/i.test(a.wav ?? '') ? 'audio/wav' : 'application/octet-stream'

// sign in
const login = await call<{ token: string; me: { id: number; username: string } }>('POST', '/auth/login', { username: a.user, password })
token = login.token
const pid = a.project ?? (await call<{ id: string }>('POST', '/projects', { name: a['new-project'] })).id

// the document: the same helpers the client calls
const doc = new Y.Doc()
const provider = new HocuspocusProvider({
  url: `${base.replace(/^http/, 'ws')}/collab`, name: docName(pid), document: doc, token,
  // WebSocketPolyfill is forwarded to the socket but missing from the provider's config type.
  ...({ WebSocketPolyfill: WebSocket } as object),
})
const until = async (ok: () => boolean, what: string, ms = 10_000) => {
  for (const t = Date.now(); !ok(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() - t > ms) die(`timed out waiting for ${what}`)
}
await until(() => provider.synced, 'the collab document to sync')
const flushed = () => until(() => provider.unsyncedChanges === 0, 'the server to accept the edit')

let clipId = '', trackId = ''
if (a.wav) {
  // upload through the real session routes (mirrors client/src/samples.ts uploadToProject)
  const up = await call<{ exists: true } | { exists: false; url: string; method: string; headers: Record<string, string> }>(
    'POST', `/projects/${pid}/samples/upload-url`, { hash, size: bytes.length, mime, name: basename(a.wav!) })
  if (!up.exists) {
    const res = await fetch(new URL(up.url, base + '/'), { method: up.method, headers: up.headers, body: bytes })
    if (!res.ok) die(`upload failed (http ${res.status})`)
    await call('POST', `/projects/${pid}/samples/${hash}/complete`)
  }

  const rate = getSampleRate(doc)
  const map = getTimeMap(doc)
  const trackName = a.track!
  trackId = getTracks(doc).find((t) => t.kind === 'audio' && t.name === trackName)?.id ?? addTrack(doc, trackName, 'audio')
  const start = map.barStartSample(Number(a.bar))
  const length = a['length-bars'] ? map.barStartSample(Number(a.bar) + Number(a['length-bars'])) - start : Math.round(duration * rate)
  const meta: SampleMeta = {
    hash, name, duration, size: bytes.length, mime,
    ...(incoming ? { status: 'incoming' as const, by: login.me.id, byName: login.me.username } : {}),
  }
  // a recorded take adds its sample and its clip together (client/src/takes.ts)
  doc.transact(() => {
    addSample(doc, meta)
    clipId = addAudioClip(doc, { trackId, sourceHash: hash, start, length })
  })
  await flushed()
  if (incoming) {
    await new Promise((r) => setTimeout(r, incomingMs))
    setSampleStatus(doc, hash, undefined) // "uploaded"
    await flushed()
  }
}
if (a.chat) {
  // a person's chat message, as the client posts it (the agent sees it as a chat event, mentionsMe if it names its handle)
  addChatMessage(doc, { username: login.me.username, color: '#888888' }, a.chat, [mentionHandle(apiName(login.me.username))])
  await flushed()
}
provider.destroy()
doc.destroy()
console.log(JSON.stringify({ project: pid, track: trackId, clipId, hash, ...(a['mint-token'] ? { token: (await call<{ token: string }>('POST', '/me/api-tokens', { name: 'seed-take' })).token } : {}) }))
process.exit(0)
