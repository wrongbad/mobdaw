// The `.mobdaw` project file: one project with its audio, so it can be backed up, moved between devices, or
// moved between "on this device" and the cloud.
//
//   "MOBDAWP1"  8 bytes magic + format version
//   u32 LE      length of the manifest
//   manifest    UTF-8 JSON (below)
//   data        the document state, then each audio file's original bytes, back to back
//
// Audio is addressed by byte ranges and written with Blob parts, so a project of several GB is never held in memory.

const MAGIC = 'MOBDAWP1'
const HEADER = MAGIC.length + 4
const MAX_MANIFEST = 16 * 1024 * 1024

export type ProjectAudio = { hash: string; mime: string; name: string; blob: Blob }
export type ProjectContents = {
  name: string
  /** `Y.encodeStateAsUpdate` of the project's document. */
  state: Uint8Array
  audio: ProjectAudio[]
}

type Manifest = {
  app: 'mobdaw'
  name: string
  doc: { offset: number; length: number }
  audio: { hash: string; mime: string; name: string; size: number; offset: number }[]
}

export const PROJECT_FILE_EXT = '.mobdaw'

export function writeProjectFile({ name, state, audio }: ProjectContents): Blob {
  let offset = state.byteLength
  const manifest: Manifest = {
    app: 'mobdaw', name, doc: { offset: 0, length: state.byteLength },
    audio: audio.map((a) => {
      const entry = { hash: a.hash, mime: a.mime, name: a.name, size: a.blob.size, offset }
      offset += a.blob.size
      return entry
    }),
  }
  const json = new TextEncoder().encode(JSON.stringify(manifest))
  const head = new Uint8Array(HEADER)
  head.set(new TextEncoder().encode(MAGIC))
  new DataView(head.buffer).setUint32(MAGIC.length, json.byteLength, true)
  return new Blob([head, json, state as BlobPart, ...audio.map((a) => a.blob)], { type: 'application/x-mobdaw-project' })
}

export class ProjectFileError extends Error {}

const isHash = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
const isRange = (o: unknown, max: number) => {
  const r = o as { offset?: unknown; length?: unknown } | null
  return !!r && Number.isInteger(r.offset) && Number.isInteger(r.length) && (r.offset as number) >= 0 && (r.length as number) >= 0 && (r.offset as number) + (r.length as number) <= max
}

export async function readProjectFile(file: Blob): Promise<ProjectContents> {
  const bad = (why: string) => new ProjectFileError(`Not a valid mobdaw project file (${why}).`)
  if (file.size < HEADER) throw bad('too small')
  const head = new Uint8Array(await file.slice(0, HEADER).arrayBuffer())
  if (new TextDecoder().decode(head.subarray(0, MAGIC.length)) !== MAGIC) throw bad('wrong header')
  const manifestLength = new DataView(head.buffer).getUint32(MAGIC.length, true)
  if (manifestLength > MAX_MANIFEST || HEADER + manifestLength > file.size) throw bad('bad manifest size')
  let m: Manifest
  try {
    m = JSON.parse(new TextDecoder().decode(await file.slice(HEADER, HEADER + manifestLength).arrayBuffer()))
  } catch {
    throw bad('unreadable manifest')
  }
  const base = HEADER + manifestLength
  const dataSize = file.size - base
  if (m?.app !== 'mobdaw' || typeof m.name !== 'string' || !isRange(m.doc, dataSize) || !Array.isArray(m.audio)) throw bad('bad manifest')
  const state = new Uint8Array(await file.slice(base + m.doc.offset, base + m.doc.offset + m.doc.length).arrayBuffer())
  const audio = m.audio.map((a) => {
    if (!isHash(a?.hash) || typeof a.mime !== 'string' || !isRange({ offset: a.offset, length: a.size }, dataSize)) throw bad('bad audio entry')
    return { hash: a.hash, mime: a.mime, name: typeof a.name === 'string' ? a.name : '', blob: file.slice(base + a.offset, base + a.offset + a.size, a.mime) }
  })
  return { name: m.name, state, audio }
}
