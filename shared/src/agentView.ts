// The project as an agent reads it (docs/agent-api.md): `agentView(doc)` is plain JSON with positions as "bar.beat.tick" next to
// ticks, notes as {p:"C4", t, d, v}, device params by name; `agentText(doc)` is the same as a compact outline for prompts.
// The position helpers (`formatPosition`, `parsePosition`, `parseDuration`) are what the ops layer (server/src/agentOps.ts) reads
// positions with, so what the view prints is what the ops accept.
import type * as Y from 'yjs'
import { DEVICES, MIX, type DeviceDef, type ParamDef } from './devices.ts'
import { noteName } from './noteName.ts'
import {
  MASTER_TRACK, getClips, getDevices, getKey, getMarkers, getNotes, getPpq, getRegions, getSampleRate, getSamples, getTimeMap, getTracks,
  type Device, type Region, type SampleStatus,
} from './schema.ts'
import type { TimeMap } from './timemap.ts'

const r3 = (n: number) => Math.round(n * 1000) / 1000

// --- positions

/** "bar.beat.tick" of a timeline tick: bar and beat 1-based, tick within the beat (a beat is a `1/den` note). In a free bar: "bar.1.0". */
export function formatPosition(map: TimeMap, tick: number): string {
  const p = map.position(tick)
  if (p.free) return `${p.bar}.1.0`
  const beatTicks = map.meterAt(p.bar).beatTicks
  const beat = Math.min(Math.floor((p.tickInBar + 1e-6) / beatTicks), Math.ceil(map.meterAt(p.bar).barTicks / beatTicks) - 1)
  return `${p.bar}.${beat + 1}.${r3(p.tickInBar - beat * beatTicks)}`
}

export class PositionError extends Error {}

const POS = /^(\d+)(?:\.(\d+)(?:\.(\d+(?:\.\d+)?))?)?$/
/**
 * A timeline tick from a position: a number (ticks from bar 1 beat 1) or "bar", "bar.beat", "bar.beat.tick" (1-based bar and beat,
 * tick within the beat, may be fractional: "3.2.240"). Throws PositionError.
 */
export function parsePosition(map: TimeMap, v: unknown): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new PositionError(`bad position ${v}: ticks must be >= 0`)
    return v
  }
  const m = typeof v === 'string' ? POS.exec(v.trim()) : null
  if (!m) throw new PositionError(`bad position ${JSON.stringify(v)}: use "bar.beat.tick" (e.g. "5.1" or "5.3.240") or a tick number`)
  const bar = Number(m[1]), beat = m[2] === undefined ? 1 : Number(m[2]), tick = m[3] === undefined ? 0 : Number(m[3])
  if (bar < 1) throw new PositionError(`bad position "${v}": bars start at 1`)
  if (beat < 1) throw new PositionError(`bad position "${v}": beats start at 1`)
  const meter = map.meterAt(bar)
  const beats = Math.ceil(meter.barTicks / meter.beatTicks - 1e-9)
  if (!meter.free && beat > beats) throw new PositionError(`bad position "${v}": bar ${bar} has ${beats} beats`)
  if (meter.free && (beat !== 1 || tick !== 0)) throw new PositionError(`bad position "${v}": bar ${bar} is a free (unmetered) bar, use "${bar}.1.0"`)
  return map.barStart(bar) + (beat - 1) * meter.beatTicks + tick
}

/**
 * A length in ticks from a number (ticks) or text of units: "4 bars", "1 bar 2 beats", "3 beats", "240 ticks" (units add up;
 * "bars" are counted from the bar `fromTick` is in, "beats" are that bar's beats). Throws PositionError.
 */
export function parseDuration(map: TimeMap, fromTick: number, v: unknown): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new PositionError(`bad length ${v}: ticks must be >= 0`)
    return v
  }
  if (typeof v !== 'string') throw new PositionError(`bad length ${JSON.stringify(v)}: use ticks or text like "4 bars", "2 beats", "240 ticks"`)
  const parts = [...v.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*(bars?|beats?|ticks?|t)\b/g)]
  if (!parts.length || parts.map((p) => p[0]).join('').replace(/\s/g, '') !== v.toLowerCase().replace(/[\s,]/g, '').replace(/and/g, '')) {
    throw new PositionError(`bad length ${JSON.stringify(v)}: use ticks or text like "4 bars", "2 beats", "1 bar 2 beats", "240 ticks"`)
  }
  const bar = map.position(fromTick).bar
  const meter = map.meterAt(bar)
  let ticks = 0
  for (const [, n, unit] of parts) {
    const x = Number(n)
    if (unit.startsWith('bar')) ticks += map.barStart(bar + x) - map.barStart(bar)
    else if (unit.startsWith('beat')) ticks += x * meter.beatTicks
    else ticks += x
  }
  return ticks
}

/** A length in ticks as text: "2 bars", "1 bar 2 beats", "3 beats 120 ticks" (from `fromTick`, which sets the bar and its beat size). */
export function formatDuration(map: TimeMap, fromTick: number, ticks: number): string {
  if (ticks <= 0) return '0 ticks'
  const bar = map.position(fromTick).bar
  const parts: string[] = []
  let left = ticks, b = bar
  let bars = 0
  while (map.barStart(b + 1) - map.barStart(b) <= left + 1e-6 && map.barStart(b + 1) > map.barStart(b)) {
    left -= map.barStart(b + 1) - map.barStart(b)
    b++
    bars++
    if (bars > 10000) break
  }
  if (bars) parts.push(`${bars} bar${bars > 1 ? 's' : ''}`)
  const beatTicks = map.meterAt(b).beatTicks
  const beats = Math.floor((left + 1e-6) / beatTicks)
  if (beats) (parts.push(`${beats} beat${beats > 1 ? 's' : ''}`), (left -= beats * beatTicks))
  if (left > 1e-6) parts.push(`${r3(left)} ticks`)
  return parts.join(' ') || '0 ticks'
}

// --- the view

export type AgentParams = Record<string, number>
export type AgentDevice = { id: string; type: string; typeId: number; name?: string; bypass?: boolean; key?: number; keyLo?: number; keyHi?: number; params: AgentParams }
export type AgentNote = { id: string; p: string; pitch: number; t: number; d: number; v: number }
export type AgentMidiClip = {
  id: string; kind: 'midi'; start: string; startTick: number; lengthTicks: number; length: string; end: string
  loopTicks?: number; forever?: boolean; view?: 'drums'; notes: AgentNote[]
}
export type AgentAudioClip = {
  id: string; kind: 'audio'; start: string; startSeconds: number; lengthSeconds: number; sample?: string; sourceHash: string
  /** Where in the sample the clip starts reading. */
  sourceOffsetSeconds: number; loopSeconds?: number
  /** Where in the loop pass the clip's start falls (only when looping and non-zero): the clip plays pass position `(t + loopPhaseSeconds) mod loopSeconds`. */
  loopPhaseSeconds?: number; gain: number
}
/** A sample an audio clip plays; `status: 'incoming'` means the take is still on the recorder's device (not downloadable yet). */
export type AgentSample = { name: string; duration: number; mime: string; status?: SampleStatus }
export type AgentTrack = {
  id: string; name: string; kind: string; muted: boolean; soloed: boolean; color?: number
  devices: AgentDevice[]; clips: (AgentMidiClip | AgentAudioClip)[]
}
export type AgentRegion =
  | { id: string; bar: number; kind: 'metered'; bpm: number; meter: string; groups?: number[]; rampTo?: number; beatTicks: number; barTicks: number }
  | { id: string; bar: number; kind: 'free'; seconds: number }
export type AgentView = {
  /** The latest history seq (set by the server). */
  rev?: number
  meta: { ppq: number; sampleRate: number; key?: string }
  regions: AgentRegion[]
  markers: { id: string; bar: number; label: string; text?: string }[]
  /** The samples the audio clips in this view play, by hash (`sourceHash`). */
  samples: Record<string, AgentSample>
  tracks: AgentTrack[]
  master: { devices: AgentDevice[] }
}

/** The device type a name or number stands for: "reverb", "lofi drum", 3. */
export function deviceType(v: unknown): DeviceDef | undefined {
  if (typeof v === 'number') return DEVICES[v]
  if (typeof v !== 'string') return undefined
  const k = v.trim().toLowerCase()
  if (/^\d+$/.test(k)) return DEVICES[Number(k)]
  return Object.values(DEVICES).find((d) => d.name.toLowerCase() === k || d.name.toLowerCase().replace(/[^a-z0-9]/g, '') === k.replace(/[^a-z0-9]/g, ''))
}

/** A device's param by name (case-insensitive), id, or option label. */
export function paramOf(def: DeviceDef, v: unknown): ParamDef | undefined {
  if (typeof v === 'number') return def.params.find((p) => p.id === v)
  if (typeof v !== 'string') return undefined
  const k = v.trim().toLowerCase()
  return def.params.find((p) => p.name.toLowerCase() === k) ?? (/^\d+$/.test(k) ? def.params.find((p) => p.id === Number(k)) : undefined)
}

const deviceView = (d: Device): AgentDevice => {
  const def = DEVICES[d.type]
  const params: AgentParams = {}
  for (const p of def?.params ?? []) params[p.name] = r3(d.params?.[String(p.id)] ?? p.def)
  const drum = d.keyLo != null && d.keyLo === d.keyHi
  return {
    id: d.id, type: def?.name ?? `type ${d.type}`, typeId: d.type,
    ...(d.name ? { name: d.name } : {}), ...(d.bypass ? { bypass: true } : {}),
    ...(drum ? { key: d.keyLo } : { ...(d.keyLo != null ? { keyLo: d.keyLo } : {}), ...(d.keyHi != null ? { keyHi: d.keyHi } : {}) }),
    params,
  }
}

/** Narrow a read: only these tracks (ids or names, case-insensitive) and only the notes/clips that touch bars `fromBar`..`toBar` (inclusive). */
export type ViewFilter = { tracks?: string[]; fromBar?: number; toBar?: number }

export function agentView(doc: Y.Doc, rev?: number, filter: ViewFilter = {}): AgentView {
  const map = getTimeMap(doc)
  const wanted = filter.tracks?.map((x) => x.trim().toLowerCase())
  const lo = filter.fromBar != null ? map.barStart(Math.max(1, filter.fromBar)) : -Infinity
  const hi = filter.toBar != null ? map.barStart(Math.max(1, filter.toBar) + 1) : Infinity
  const rate = getSampleRate(doc), ppq = getPpq(doc)
  const samples = getSamples(doc)
  const notes = new Map<string, ReturnType<typeof getNotes>>()
  for (const n of getNotes(doc)) (notes.get(n.clipId) ?? notes.set(n.clipId, []).get(n.clipId)!).push(n)
  const devices = getDevices(doc)
  const clips = getClips(doc).sort((a, b) => (a.kind === 'midi' ? a.startTick : (map.sampleToTick(a.start))) - (b.kind === 'midi' ? b.startTick : map.sampleToTick(b.start)))
  const inWindow = (c: ReturnType<typeof getClips>[number]) => {
    const a = c.kind === 'midi' ? c.startTick : map.sampleToTick(c.start)
    const b = c.kind === 'midi' ? a + c.lengthTicks : map.sampleToTick(c.start + c.length)
    return a < hi && b > lo
  }
  const clipView = (c: ReturnType<typeof getClips>[number]): AgentMidiClip | AgentAudioClip => {
    if (c.kind === 'audio') {
      const startTick = map.sampleToTick(c.start)
      return {
        id: c.id, kind: 'audio', start: formatPosition(map, startTick), startSeconds: r3(c.start / rate), lengthSeconds: r3(c.length / rate),
        ...(samples[c.sourceHash]?.name ? { sample: samples[c.sourceHash].name } : {}), sourceHash: c.sourceHash,
        sourceOffsetSeconds: r3(c.sourceOffset / rate),
        ...(c.loopLength ? { loopSeconds: r3(c.loopLength / rate), ...(c.loopPhase ? { loopPhaseSeconds: r3(c.loopPhase / rate) } : {}) } : {}), gain: r3(c.gain),
      }
    }
    return {
      id: c.id, kind: 'midi', start: formatPosition(map, c.startTick), startTick: r3(c.startTick), lengthTicks: r3(c.lengthTicks),
      length: formatDuration(map, c.startTick, c.lengthTicks), end: formatPosition(map, c.startTick + c.lengthTicks),
      ...(c.loopTicks ? { loopTicks: r3(c.loopTicks) } : {}), ...(c.forever ? { forever: true } : {}), ...(c.view ? { view: c.view } : {}),
      notes: (notes.get(c.id) ?? []).filter((n) => c.startTick + n.tick < hi && c.startTick + n.tick + n.durTicks > lo).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch).map((n) => ({
        id: n.id, p: noteName(n.pitch).toUpperCase(), pitch: n.pitch, t: r3(n.tick), d: r3(n.durTicks), v: Math.round(n.velocity * 127),
      })),
    }
  }
  const tracks = getTracks(doc).filter((t) => !wanted || wanted.includes(t.id.toLowerCase()) || wanted.includes(t.name.toLowerCase())).map((t) => ({
    id: t.id, name: t.name, kind: t.kind, muted: t.muted, soloed: t.soloed, ...(t.color != null ? { color: t.color } : {}),
    devices: devices.filter((d) => d.trackId === t.id).map(deviceView),
    clips: clips.filter((c) => c.trackId === t.id && inWindow(c)).map(clipView),
  }))
  const used: Record<string, AgentSample> = {}
  for (const t of tracks) for (const c of t.clips) {
    const s = c.kind === 'audio' ? samples[c.sourceHash] : undefined
    if (s && c.kind === 'audio') used[c.sourceHash] = { name: s.name, duration: r3(s.duration), mime: s.mime, ...(s.status ? { status: s.status } : {}) }
  }
  const regions: AgentRegion[] = getRegions(doc).map((r: Region) => {
    if (r.kind === 'free') return { id: r.id, bar: r.bar, kind: 'free', seconds: r3(r.length / rate) }
    const m = map.meterAt(r.bar)
    return {
      id: r.id, bar: r.bar, kind: 'metered', bpm: r3(r.bpm), meter: `${r.num}/${r.den}`, ...(r.groups ? { groups: r.groups } : {}), ...(r.rampTo != null ? { rampTo: r3(r.rampTo) } : {}),
      beatTicks: r3(m.beatTicks), barTicks: r3(m.barTicks),
    }
  })
  return {
    ...(rev != null ? { rev } : {}),
    meta: { ppq, sampleRate: rate, ...(getKey(doc) ? { key: getKey(doc) } : {}) },
    regions,
    markers: getMarkers(doc).map((m) => ({ id: m.id, bar: m.bar, label: m.label, ...(m.text ? { text: m.text } : {}) })),
    samples: used,
    tracks,
    master: { devices: devices.filter((d) => d.trackId === MASTER_TRACK).map(deviceView) },
  }
}

// --- the outline

const fmtParams = (p: AgentParams) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ')
const devLine = (d: AgentDevice) =>
  `${d.type}${d.name ? ` "${d.name}"` : ''} [${d.id}]${d.bypass ? ' (bypassed)' : ''}${d.key != null ? ` key ${d.key}` : ''}${d.keyLo != null ? ` keys ${d.keyLo}-${d.keyHi ?? 127}` : ''}: ${fmtParams(d.params)}`

/** The view as a compact text outline: ids in [brackets], positions "bar.beat.tick", notes `PITCH tick+duration vVELOCITY` (clip-local ticks). */
export function agentText(doc: Y.Doc, rev?: number, filter: ViewFilter = {}): string {
  const v = agentView(doc, rev, filter)
  const out: string[] = []
  out.push(`project: ppq ${v.meta.ppq}, ${v.meta.sampleRate} Hz${v.meta.key ? `, key ${v.meta.key}` : ''}${v.rev != null ? `, rev ${v.rev}` : ''}`)
  if (filter.tracks || filter.fromBar != null || filter.toBar != null) {
    out.push(`(filtered: ${[filter.tracks ? `tracks ${filter.tracks.join(', ')}` : '', filter.fromBar != null || filter.toBar != null ? `bars ${filter.fromBar ?? 1}-${filter.toBar ?? 'end'}` : ''].filter(Boolean).join('; ')}; clips and notes outside are left out, note positions are still clip-local ticks)`)
  }
  out.push('timeline:')
  for (const r of v.regions) {
    out.push(
      r.kind === 'free' ? `  bar ${r.bar}: free bar, ${r.seconds} s [${r.id}]`
      : `  bar ${r.bar}: ${r.bpm} bpm ${r.meter}${r.groups ? ` (${r.groups.join('+')})` : ''}${r.rampTo != null ? ` ramping to ${r.rampTo}` : ''} (beat ${r.beatTicks} ticks, bar ${r.barTicks} ticks) [${r.id}]`)
  }
  if (v.markers.length) out.push(`markers: ${v.markers.map((m) => `bar ${m.bar} "${m.label}" [${m.id}]`).join(', ')}`)
  for (const t of v.tracks) {
    out.push(`track "${t.name}" [${t.id}] ${t.kind}${t.muted ? ' muted' : ''}${t.soloed ? ' soloed' : ''}`)
    for (const d of t.devices) out.push(`  device ${devLine(d)}`)
    for (const c of t.clips) {
      if (c.kind === 'audio') {
        out.push(`  audio clip [${c.id}] at ${c.start} (${c.startSeconds} s), ${c.lengthSeconds} s${c.sample ? `, "${c.sample}"` : ''}${c.sourceOffsetSeconds ? `, from ${c.sourceOffsetSeconds} s` : ''}${v.samples[c.sourceHash]?.status ? ` (${v.samples[c.sourceHash].status})` : ''}${c.loopSeconds ? `, loop ${c.loopSeconds} s${c.loopPhaseSeconds ? ` from ${c.loopPhaseSeconds} s in` : ''}` : ''}`)
        continue
      }
      out.push(`  clip [${c.id}] ${c.start} to ${c.end} (${c.length}, ${c.lengthTicks} ticks)${c.loopTicks ? `, loop ${c.loopTicks} ticks` : ''}${c.forever ? ' forever' : ''}${c.view ? `, ${c.view} view` : ''}, ${c.notes.length} notes`)
      for (let i = 0; i < c.notes.length; i += 6) out.push(`    ${c.notes.slice(i, i + 6).map((n) => `${n.p} ${n.t}+${n.d} v${n.v} [${n.id}]`).join('  ')}`)
    }
  }
  if (v.master.devices.length) {
    out.push('master:')
    for (const d of v.master.devices) out.push(`  device ${devLine(d)}`)
  }
  return out.join('\n')
}

/** The device and param names, ranges and options an agent can use, as text (for the ops documentation). */
export function deviceCatalogText(): string {
  return Object.values(DEVICES)
    .filter((d) => !d.hidden || d.type === MIX)
    .map((d) => {
      const ps = d.params.map((p) => `${p.name} ${p.options ? `${p.options.map((o, i) => `${i}=${o}`).join('/')}` : `${p.min}..${p.max}${p.unit ? ` ${p.unit}` : ''}`} (default ${p.def})`).join('; ')
      return `- ${d.name}${d.instrument ? ' (instrument)' : d.type === MIX ? ' (fader and pan, one per track, always there)' : ' (effect)'}: ${ps}`
    })
    .join('\n')
}
