// New-project templates, offered on the home page. Each builds into an empty doc.
import type * as Y from 'yjs'
import { DELAY, MASTER_TRACK, addClickTrack, addDevice, getClips, setTrackColor, updateClip, updateTrack } from '@mobdaw/shared'
import { clip, initProject, track, type Song } from './compose'
import { buildDemo } from './demo'
import { GM, addDrumKit, addEffectPreset, addInstrument, drumKit, effectPreset, instrumentPreset } from './presets'

export type Template = { id: string; name: string; blurb: string; build(doc: Y.Doc): void }

/** The metronome track, following the project tempo (addClickTrack writes a 120 bpm clip). */
function click(s: Song, o: { color: number; muted?: boolean }): string {
  const id = addClickTrack(s.doc)
  setTrackColor(s.doc, id, o.color)
  if (o.muted) updateTrack(s.doc, id, { muted: true })
  for (const c of getClips(s.doc)) if (c.trackId === id) updateClip(s.doc, c.id, { bpm: s.bpm })
  return id
}

function empty(doc: Y.Doc) {
  doc.transact(() => {
    const s = initProject(doc, 120)
    track(s, 'audio 1', 'audio', { color: 0 })
  })
}

function beat(doc: Y.Doc) {
  doc.transact(() => {
    const s = initProject(doc, 90)
    const drums = track(s, 'drums', 'midi', { color: 4, gain: 0.85 })
    addDrumKit(doc, drums, drumKit('tape')!)
    const d = clip(s, drums, { bar: 0, bars: 8, loopBars: 2, drums: true })
    const hit = (bar: number, step16: number, key: number, v: number) => d.note(bar * 4 + step16 / 4 + (step16 % 2 ? 0.05 : 0), key, 0.25, v)
    for (let bar = 0; bar < 2; bar++) {
      for (let i = 0; i < 16; i += 2) hit(bar, i, GM.closedHat, i % 4 === 0 ? 0.5 : 0.3)
      hit(bar, 4, GM.snare, 0.85)
      hit(bar, 12, GM.snare, 0.9)
      hit(bar, 0, GM.kick, 0.95)
      hit(bar, 10, GM.kick, 0.8)
    }
    hit(0, 7, GM.snare, 0.15)
    hit(1, 7, GM.kick, 0.55)
    hit(1, 15, GM.closedHat, 0.2)

    const bass = track(s, 'bass', 'midi', { color: 2, gain: 0.85 })
    addInstrument(doc, bass, instrumentPreset('round-bass')!)
    const b = clip(s, bass, { bar: 0, bars: 8, loopBars: 2 })
    // A minor: A, then G and E leading back round
    const line: [number, number, number, number][] = [
      [0, 33, 1.4, 0.9], [1.75, 33, 0.22, 0.5], [2.5, 40, 0.8, 0.7], [3.5, 43, 0.4, 0.6],
      [4, 31, 1.4, 0.88], [5.75, 31, 0.22, 0.5], [6.5, 38, 0.7, 0.7], [7.25, 40, 0.6, 0.65],
    ]
    for (const [at, pitch, dur, v] of line) b.note(at, pitch, dur, v)
  })
}

function band(doc: Y.Doc) {
  doc.transact(() => {
    const s = initProject(doc, 100)
    click(s, { color: 7, muted: true })
    const vocals = track(s, 'vocals', 'audio', { color: 3 })
    addEffectPreset(doc, vocals, effectPreset('vocal-polish')!)
    track(s, 'guitar', 'audio', { color: 6, pan: -0.2 })
    const keys = track(s, 'keys', 'midi', { color: 0, gain: 0.8, pan: 0.2 })
    addInstrument(doc, keys, instrumentPreset('soft-keys')!)
    const drums = track(s, 'drums', 'midi', { color: 4, gain: 0.85 })
    addDrumKit(doc, drums, drumKit('tape')!)
  })
}

function loopjam(doc: Y.Doc) {
  doc.transact(() => {
    const s = initProject(doc, 100)
    click(s, { color: 7 })
    for (let i = 1; i <= 3; i++) track(s, `loop ${i}`, 'audio', { color: i - 1 })
    addDevice(doc, MASTER_TRACK, DELAY, {}, { 0: 0.2, 1: Math.round((0.75 * 60000) / s.bpm), 2: 0.35, 3: 0.3, 4: 0.2, 5: 0, 6: 3500, 7: 0 })
  })
}

export const TEMPLATES: Template[] = [
  { id: 'empty', name: 'Empty', blurb: 'One audio track at 120 bpm.', build: empty },
  { id: 'beat', name: 'Beat', blurb: 'A two-bar drum groove and a bass line at 90 bpm.', build: beat },
  { id: 'band', name: 'Band', blurb: 'Vocal and guitar tracks ready to record, with keys, drums and a muted click.', build: band },
  { id: 'loopjam', name: 'Loop jam', blurb: 'A click, three audio tracks for the loop pedal and a tape echo on the master.', build: loopjam },
  { id: 'demo', name: 'Demo song', blurb: 'A short chillhop piece made from the built-in synths.', build: buildDemo },
]
