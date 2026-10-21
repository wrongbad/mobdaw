// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureTimeline, getClips, getKey, getMarkers, getNotes, getRegions, getTimeMap, getTracks, metaMap, type Note } from '@mobdaw/shared'
import { strToU8, zipSync } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { importMusicXml, isMusicXmlFile, parseMusicXml, planMusicXml, soundingRatio, velocityOf, type XmlScore } from '../src/content/musicxml'

const RATE = 48000
const PPQ = 960
function blank() {
  const doc = new Y.Doc()
  metaMap(doc).set('sampleRate', RATE)
  ensureTimeline(doc)
  return doc
}

/** A partwise document with one part (id P1, "Part") whose body is `measures`; `attrs` go in the first measure. */
const xml = (measures: string, o: { attrs?: string; extraParts?: string; list?: string; div?: number } = {}) => `<?xml version="1.0"?>
<score-partwise version="4.0"><work><work-title>Test</work-title></work>
<part-list><score-part id="P1"><part-name>Part</part-name></score-part>${o.list ?? ''}</part-list>
<part id="P1">${measures.replace('<measure number="1">', `<measure number="1"><attributes><divisions>${o.div ?? 1}</divisions>${o.attrs ?? '<time><beats>4</beats><beat-type>4</beat-type></time>'}</attributes>`)}</part>${o.extraParts ?? ''}
</score-partwise>`

const note = (step: string, octave: number, dur: number, extra = '', alter = 0) =>
  `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${dur}</duration>${extra}</note>`
const rest = (dur: number, extra = '') => `<note><rest/><duration>${dur}</duration>${extra}</note>`
const m = (n: number, body: string) => `<measure number="${n}">${body}</measure>`
const tm = (a: number, n: number) => `<time-modification><actual-notes>${a}</actual-notes><normal-notes>${n}</normal-notes></time-modification>`
const arts = (...tags: string[]) => `<notations><articulations>${tags.map((t) => `<${t}/>`).join('')}</articulations></notations>`
const q = (n: [number, number]) => n[0] / n[1]

describe('reading', () => {
  it('follows divisions changes', () => {
    const s = parseMusicXml(xml(
      m(1, note('C', 4, 1) + note('D', 4, 3)) +
      m(2, '<attributes><divisions>4</divisions></attributes>' + note('E', 4, 2) + note('F', 4, 1) + note('G', 4, 13)),
    ))
    expect(s.parts[0].notes.map((n) => [n.on, n.dur])).toEqual([
      [[0, 1], [1, 1]], [[1, 1], [3, 1]], [[4, 1], [1, 2]], [[9, 2], [1, 4]], [[19, 4], [13, 4]],
    ])
    expect(s.bars.map(q)).toEqual([0, 4, 8])
  })

  it('places two voices with backup and forward', () => {
    const s = parseMusicXml(xml(m(1,
      note('C', 5, 2, '<voice>1</voice>') + note('D', 5, 2, '<voice>1</voice>') +
      '<backup><duration>4</duration></backup>' +
      note('C', 4, 1, '<voice>2</voice>') + '<forward><duration>1</duration></forward>' + note('E', 4, 2, '<voice>2</voice>'))))
    const ns = s.parts[0].notes
    expect(ns.map((n) => [n.voice, q(n.on), q(n.dur)])).toEqual([[1, 0, 2], [1, 2, 2], [2, 0, 1], [2, 2, 2]])
  })

  it('keeps a chord on one onset', () => {
    const s = parseMusicXml(xml(m(1, note('C', 4, 1) + note('E', 4, 1, '<chord/>') + note('G', 4, 1, '<chord/>') + note('D', 4, 3))))
    expect(s.parts[0].notes.map((n) => [n.pitch, q(n.on)])).toEqual([[60, 0], [64, 0], [67, 0], [62, 1]])
  })

  it('names spelling as written: E# and Cb', () => {
    const s = parseMusicXml(xml(m(1, note('E', 5, 1, '', 1) + note('C', 4, 1, '', -1) + note('B', 3, 1, '', -2) + note('F', 4, 1, '', 1))))
    expect(s.parts[0].notes.map((n) => [n.spell, n.pitch])).toEqual([['E#5', 77], ['Cb4', 59], ['Bbb3', 57], ['F#4', 66]])
  })

  it('reads a key with a mode', () => {
    const k = (f: number, mode?: string) => parseMusicXml(xml(m(1, note('C', 4, 4)), { attrs: `<key><fifths>${f}</fifths>${mode ? `<mode>${mode}</mode>` : ''}</key>` })).key
    expect(k(-1, 'minor')).toBe('D minor')
    expect(k(1, 'minor')).toBe('E minor')
    expect(k(0, 'dorian')).toBe('D dorian')
    expect(k(-3)).toBe('Eb major')
    expect(k(6, 'major')).toBe('F# major')
    expect(k(0, 'aeolian')).toBe('A minor')
    expect(parseMusicXml(xml(m(1, note('C', 4, 4)))).key).toBeUndefined()
  })

  it('reads tempo (sound wins over the metronome), meters and a pickup bar', () => {
    const s = parseMusicXml(xml(
      m(1, '<attributes><time><beats>1</beats><beat-type>4</beat-type></time></attributes>' + note('C', 4, 1)) +
      m(2, '<attributes><time><beats>6</beats><beat-type>8</beat-type></time><divisions>2</divisions></attributes>' +
        '<direction><direction-type><metronome><beat-unit>eighth</beat-unit><per-minute>200</per-minute></metronome></direction-type></direction>' +
        note('D', 4, 3) + note('E', 4, 3)) +
      m(3, '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type><sound tempo="90"/></direction>' + note('D', 4, 6)),
      { attrs: '<time><beats>4</beats><beat-type>4</beat-type></time>' },
    ))
    expect(s.meters.map((x) => [q(x.at), x.num, x.den])).toEqual([[0, 1, 4], [1, 6, 8]])
    expect(s.tempos.map((x) => [q(x.at), x.bpm])).toEqual([[0, 120], [1, 100], [4, 90]])
  })

  it('counts what it skips', () => {
    const s = parseMusicXml(xml(m(1,
      '<note><grace/><pitch><step>D</step><octave>5</octave></pitch></note>' +
      note('C', 4, 2, '<notations><slur type="start"/><slur type="stop"/><ornaments><trill-mark/></ornaments></notations><lyric><text>la</text></lyric>') +
      '<note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>2</duration></note>' +
      '<barline><repeat direction="forward"/></barline>')))
    expect(s.skipped).toEqual({ 'grace notes': 1, slurs: 1, ornaments: 1, lyrics: 1, 'unpitched (percussion) notes': 1, 'repeat barlines (not unfolded)': 1 })
    expect(s.report).toContain('skipped: 1 grace notes')
    expect(s.parts[0].notes).toHaveLength(1)
  })

  it('reads a compressed .mxl through its container, or the first xml entry', () => {
    const doc = xml(m(1, note('C', 4, 4)))
    const container = '<container><rootfiles><rootfile full-path="score/main.xml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'
    const a = parseMusicXml(zipSync({ 'META-INF/container.xml': strToU8(container), 'other.xml': strToU8('<x/>'), 'score/main.xml': strToU8(doc) }))
    expect(a.title).toBe('Test')
    const b = parseMusicXml(zipSync({ 'META-INF/container.xml': strToU8('<container/>'), 'song.musicxml': strToU8(doc) }))
    expect(b.parts[0].notes).toHaveLength(1)
    expect(() => parseMusicXml(zipSync({ 'readme.txt': strToU8('hi') }))).toThrow(/no score/)
  })

  it('refuses what it cannot read', () => {
    expect(() => parseMusicXml('<score-timewise/>')).toThrow(/timewise/)
    expect(() => parseMusicXml('<html/>')).toThrow(/not a MusicXML/)
    expect(() => parseMusicXml('<score-partwise><part-list/></score-partwise>')).toThrow(/no <part>/)
    expect(() => parseMusicXml('not xml at all <<')).toThrow(/not a MusicXML/)
  })

  it('reads a two-staff piano part with its clefs', () => {
    const s = parseMusicXml(xml(
      m(1, note('C', 5, 4, '<voice>1</voice><staff>1</staff>') + '<backup><duration>4</duration></backup>' + note('C', 3, 4, '<voice>5</voice><staff>2</staff>')),
      { attrs: '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>' },
    ))
    const p = s.parts[0]
    expect(p.staves).toBe(2)
    expect(p.clefs).toEqual(['treble', 'bass'])
    expect(p.notes.map((n) => [n.staff, n.voice])).toEqual([[1, 1], [2, 5]])
    // the voice is renumbered per staff in the hint
    expect(planMusicXml(s, { ppq: PPQ })[0].notes.map((n) => [n.hint.staff, n.hint.voice])).toEqual([[2, 1], [1, 1]])
  })

  it('maps clef signs', () => {
    const c = (sign: string, line: number, shift = 0) => parseMusicXml(xml(m(1, note('C', 4, 4)), { attrs: `<clef><sign>${sign}</sign><line>${line}</line>${shift ? `<clef-octave-change>${shift}</clef-octave-change>` : ''}</clef>` })).parts[0].clefs
    expect(c('G', 2, -1)).toEqual(['treble_8'])
    expect(c('F', 4, -1)).toEqual(['bass_8'])
    expect(c('C', 3)).toEqual(['alto'])
    expect(c('C', 4)).toEqual(['tenor'])
  })
})

describe('tuplets', () => {
  const startN = '<notations><tuplet type="start" number="1"/></notations>'
  const stopN = '<notations><tuplet type="stop" number="1"/></notations>'
  const e3 = (extra = '') => `<type>eighth</type>${tm(3, 2)}${extra}` // an eighth in a 3:2 triplet

  it('reads a 3:2 triplet with a rest inside, from its notations', () => {
    const s = parseMusicXml(xml(m(1,
      note('C', 4, 3) + // a quarter (divisions 3)
      note('E', 4, 1, e3(startN)) + rest(1, e3()) + note('G', 4, 1, e3(stopN)) +
      note('A', 4, 3)), { div: 3 }))
    const ns = s.parts[0].notes
    expect(ns.map((n) => [n.on, n.dur])).toEqual([[[0, 1], [1, 1]], [[1, 1], [1, 3]], [[5, 3], [1, 3]], [[2, 1], [1, 1]]])
    expect(ns[0].tup).toBeUndefined()
    expect(ns[1].tup).toEqual({ n: 3, of: 2, start: [1, 1], span: [1, 1] })
    expect(ns[2].tup).toEqual({ n: 3, of: 2, start: [1, 1], span: [1, 1] })
    expect(ns[3].tup).toBeUndefined()
  })

  it('groups a time-modified run without notations until it fills its span (5:4, then two 3:2 groups with rests)', () => {
    const e = e3()
    const s = parseMusicXml(xml(m(1,
      note('C', 4, 60) +
      [0, 1, 2, 3, 4].map((i) => note('DEFGA'[i], 4, 12, `<type>16th</type>${tm(5, 4)}`)).join('') + // 5:4 sixteenths, one quarter
      note('B', 4, 20, e) + rest(20, e) + note('C', 5, 20, e) +
      note('D', 5, 20, e) + rest(20, e) + rest(20, e)), { div: 60 }))
    const ns = s.parts[0].notes
    const quint = ns.slice(1, 6)
    expect(quint.map((n) => q(n.on))).toEqual([1, 1.2, 1.4, 1.6, 1.8])
    for (const n of quint) { expect(n.dur).toEqual([1, 5]); expect(n.tup).toEqual({ n: 5, of: 4, start: [1, 1], span: [1, 1] }) }
    expect(ns[6].tup).toEqual({ n: 3, of: 2, start: [2, 1], span: [1, 1] })
    expect(ns[7].tup).toEqual({ n: 3, of: 2, start: [2, 1], span: [1, 1] })
    expect(ns[8].tup).toEqual({ n: 3, of: 2, start: [3, 1], span: [1, 1] }) // the next group starts where the first ended
  })

  it('reads a 5:4 quintuplet from its notations', () => {
    const s = parseMusicXml(xml(m(1, [0, 1, 2, 3, 4].map((i) => note('CDEFG'[i], 4, 12, `<type>16th</type>${tm(5, 4)}${i === 0 ? startN : i === 4 ? stopN : ''}`)).join('') + note('A', 4, 180)), { div: 60 }))
    expect(s.parts[0].notes.slice(0, 5).map((n) => n.tup)).toEqual(Array(5).fill({ n: 5, of: 4, start: [0, 1], span: [1, 1] }))
  })
})

describe('performing', () => {
  const play = (s: XmlScore) => planMusicXml(s, { ppq: PPQ })[0].notes

  it('plays staccato at half, staccatissimo at a quarter, tenuto and plain in full', () => {
    const s = parseMusicXml(xml(m(1,
      note('C', 4, 1, arts('staccato')) + note('D', 4, 1, arts('staccatissimo')) + note('E', 4, 1, arts('tenuto')) + note('F', 4, 1))))
    const ns = play(s)
    expect(ns.map((n) => n.durTicks)).toEqual([480, 240, 960, 960])
    expect(ns.map((n) => n.hint.art)).toEqual(["'", "'", '_', undefined])
    expect(soundingRatio({ art: "'" })).toBe(0.5)
  })

  it('merges a tie across a bar into one note and keeps the written pieces', () => {
    const s = parseMusicXml(xml(
      m(1, note('C', 4, 2) + note('G', 4, 2, '<tie type="start"/><notations><tied type="start"/></notations>')) +
      m(2, note('G', 4, 4, '<tie type="stop"/><tie type="start"/>')) +
      m(3, note('G', 4, 1, '<tie type="stop"/>') + rest(3)),
    ))
    const ns = play(s)
    expect(ns.map((n) => n.pitch)).toEqual([60, 67])
    const g = ns[1]
    expect([g.tick, g.durTicks]).toEqual([2 * PPQ, 7 * PPQ])
    expect(g.hint.on).toEqual([2, 1])
    expect(g.hint.len).toEqual([7, 1])
    expect(g.hint.segs).toEqual([[2, 1], [4, 1], [1, 1]])
    expect(ns[0].hint.segs).toBeUndefined()
  })

  it('writes ticks and the hint `at` from the same rounded numbers, with the tuplet', () => {
    const s = parseMusicXml(xml(m(1,
      [0, 1, 2, 3, 4, 5, 6].map((i) => note('CDEFGAB'[i], 4, 1, `<type>16th</type>${tm(7, 4)}`)).join('')), { div: 7 }))
    const ns = play(s)
    for (const n of ns) expect(n.hint.at).toEqual([n.tick, n.durTicks, n.pitch])
    expect(ns.map((n) => n.tick)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => Math.round((i * PPQ) / 7)))
    expect(ns[0].hint.tup).toEqual({ n: 7, of: 4, start: [0, 1], span: [1, 1] })
    expect(ns[0].hint.len).toEqual([1, 7]) // exact, even though 1/7 of a quarter is not a whole tick count
  })

  it('takes velocity from the dynamics in force, with accents on top', () => {
    const dyn = (name: string) => `<direction><direction-type><dynamics><${name}/></dynamics></direction-type></direction>`
    const s = parseMusicXml(xml(m(1,
      note('C', 4, 1) + dyn('pp') + note('D', 4, 1) + dyn('ff') + note('E', 4, 1) + note('F', 4, 1, arts('accent')) )))
    const v = play(s).map((n) => n.velocity)
    expect(v).toEqual([velocityOf(78), velocityOf(36), velocityOf(108), velocityOf(108, 0, '>')])
    expect(v[0]).toBeGreaterThan(v[1])
    expect(v[2]).toBeGreaterThan(v[0])
    expect(v[3]).toBeGreaterThan(v[2])
    for (const x of v) expect(x).toBeGreaterThan(0), expect(x).toBeLessThanOrEqual(1)
  })

  it('transposing parts keep concert pitch and drop the spelling', () => {
    const s = parseMusicXml(xml(m(1, note('D', 4, 4)), { attrs: '<transpose><chromatic>-2</chromatic></transpose>' }))
    const n = play(s)[0]
    expect(n.pitch).toBe(60)
    expect(n.hint.spell).toBeUndefined()
  })
})

describe('importing into a project', () => {
  const twoParts = () => parseMusicXml(xml(
    m(1, '<attributes><key><fifths>-1</fifths><mode>minor</mode></key><clef><sign>G</sign><line>2</line></clef></attributes>' +
      '<direction><direction-type><rehearsal>A</rehearsal></direction-type><sound tempo="90"/></direction>' + note('D', 5, 4)) +
      m(2, '<direction><sound tempo="60"/></direction>' + note('E', 5, 4)),
    {
      attrs: '<time><beats>4</beats><beat-type>4</beat-type></time>',
      list: '<score-part id="P2"><part-name>Cello</part-name><midi-instrument id="I"><midi-program>43</midi-program></midi-instrument></score-part>',
      extraParts: '<part id="P2"><measure number="1"><attributes><divisions>1</divisions><clef><sign>F</sign><line>4</line></clef></attributes>' + note('D', 2, 4) + '</measure><measure number="2">' + note('A', 2, 4) + '</measure></part>',
    },
  ))

  it('adopts meter, tempo, key and marks in a fresh project, one track per part, in one transaction', () => {
    const doc = blank()
    let tx = 0
    doc.on('afterTransaction', () => tx++)
    const r = importMusicXml(doc, twoParts(), { at: 123456, base: 'song' })
    expect(tx).toBe(1)
    expect(r.adopted).toBe(true)
    expect(r.tracks).toHaveLength(2)
    expect(getRegions(doc).map((x) => [x.bar, x.bpm, x.num, x.den])).toEqual([[1, 90, 4, 4], [2, 60, 4, 4]])
    expect(getKey(doc)).toBe('D minor')
    expect(getMarkers(doc).map((x) => [x.bar, x.label])).toEqual([[1, 'A']])
    const tracks = getTracks(doc).filter((t) => r.tracks.includes(t.id))
    expect(tracks.map((t) => [t.name, t.kind, t.clefs])).toEqual([['Part', 'midi', ['treble']], ['Cello', 'midi', ['bass']]])
    const clips = getClips(doc)
    expect(clips).toHaveLength(2)
    for (const c of clips) expect(c.kind === 'midi' && c.startTick).toBe(0)
    const notes = getNotes(doc)
    expect(notes).toHaveLength(4)
    for (const n of notes) expect(n.hint!.at).toEqual([n.tick, n.durTicks, n.pitch])
    const d5 = notes.find((n) => n.pitch === 74)!
    expect(d5).toMatchObject({ tick: 0, durTicks: 4 * PPQ })
    expect(d5.hint).toMatchObject({ on: [0, 1], len: [4, 1], staff: 1, voice: 1, spell: 'D5' })
    expect(getTimeMap(doc).barStart(2)).toBe(4 * PPQ)
  })

  it('keeps a project that has its own timeline and places by quarters from the nearest bar', () => {
    const doc = blank()
    importMusicXml(doc, twoParts(), { at: 0, base: 'first' }) // takes the timeline over
    const before = getRegions(doc).map((x) => [x.bar, x.bpm])
    const map = getTimeMap(doc)
    const r = importMusicXml(doc, twoParts(), { at: map.barStartSample(2) + 100, base: 'second' })
    expect(r.adopted).toBe(false)
    expect(getRegions(doc).map((x) => [x.bar, x.bpm])).toEqual(before)
    const clip = getClips(doc).find((c) => c.kind === 'midi' && r.clips.includes(c.id))!
    expect(clip.kind === 'midi' && clip.startTick).toBe(map.barStart(2))
    const notes = getNotes(doc).filter((n: Note) => n.clipId === clip.id)
    expect(notes.map((n) => n.tick).sort((a, b) => a - b)).toEqual([0, 4 * PPQ])
    expect(getMarkers(doc)).toHaveLength(1) // marks are not added to a project with its own map
  })

  it('merges into a given MIDI track without staff and voice', () => {
    const doc = blank()
    const first = importMusicXml(doc, twoParts(), { at: 0, base: 'a' })
    const r = importMusicXml(doc, twoParts(), { at: 0, trackId: first.tracks[0], base: 'b' })
    expect(r.into).toBe(first.tracks[0])
    expect(r.tracks).toEqual([])
    const clip = getClips(doc).find((c) => r.clips.includes(c.id))!
    const ns = getNotes(doc).filter((n) => n.clipId === clip.id)
    expect(ns).toHaveLength(4)
    for (const n of ns) { expect(n.hint!.staff).toBeUndefined(); expect(n.hint!.voice).toBeUndefined(); expect(n.hint!.on).toBeDefined() }
  })
})

it('recognises MusicXML files', () => {
  for (const name of ['a.musicxml', 'a.XML', 'b.mxl']) expect(isMusicXmlFile({ name, type: '' })).toBe(true)
  expect(isMusicXmlFile({ name: 'a.mid', type: 'audio/midi' })).toBe(false)
})

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const bar = (s: XmlScore, n: number) => [s.bars[n - 1], s.bars[n]] as const
const inBar = <T extends { hint: { on: [number, number] } }>(notes: T[], s: XmlScore, n: number) => {
  const [a, b] = bar(s, n)
  return notes.filter((x) => q(x.hint.on) >= q(a) && q(x.hint.on) < q(b))
}

describe('chorale (badmidi export)', () => {
  it('reads four parts with their clefs, key and tempo', () => {
    const s = parseMusicXml(fixture('chorale.musicxml'))
    expect(s.parts.map((p) => [p.name, p.notes.length])).toEqual([['Soprano', 26], ['Alto', 26], ['Tenor', 26], ['Bass', 26]])
    expect(s.parts.map((p) => p.clefs)).toEqual([['treble'], ['treble'], ['treble_8'], ['bass']])
    expect(s.key).toBe('G major')
    expect(s.tempos).toEqual([{ at: [0, 1], bpm: 66 }])
    expect(q(s.bars[s.bars.length - 1])).toBe(32)
    const doc = blank()
    importMusicXml(doc, s, { at: 0, base: 'chorale' })
    expect(getTracks(doc).filter((t) => t.role !== 'click' && t.kind === 'midi')).toHaveLength(4)
    expect(getRegions(doc)).toMatchObject([{ bpm: 66, num: 4, den: 4 }])
  })
})

describe('woven chaconne excerpt (bars 1-2, 25-26, 57-58 of badmidi\'s export, as bars 1-6)', () => {
  const s = parseMusicXml(fixture('woven-excerpt.musicxml'))
  const plan = planMusicXml(s, { ppq: PPQ })
  it('is a quartet in 3/4, E minor, with the tempo changes', () => {
    expect(plan.map((p) => p.name)).toEqual(['Violin 1', 'Violin 2', 'Viola', 'Cello'])
    expect(s.meters.map((x) => [q(x.at), x.num, x.den])).toEqual([[0, 3, 4]])
    expect(s.key).toBe('E minor')
    expect(s.tempos.map((x) => [q(x.at), x.bpm])).toEqual([[0, 69], [6, 76]])
  })
  it('plays the staccato hocket short and writes it as staccato', () => {
    const ns = inBar(plan[0].notes, s, 3)
    expect(ns.length).toBeGreaterThan(3)
    for (const n of ns) { expect(n.durTicks).toBe(120); expect(n.hint.art).toBe("'"); expect(n.hint.len).toEqual([1, 4]) }
    expect(ns.slice(0, 3).map((n) => n.tick - ns[0].tick)).toEqual([0, 720, 1440]) // every three 16ths
  })
  it('writes the quintuplet', () => {
    const ns = inBar(plan[0].notes, s, 5).filter((n) => n.hint.tup)
    expect(ns.length).toBeGreaterThanOrEqual(5)
    for (const n of ns.slice(0, 5)) expect(n.hint.tup).toMatchObject({ n: 5, of: 4, span: [1, 1] })
    expect(ns[0].hint.len).toEqual([1, 5])
  })
  it('matches `at` to every note, with a spelling and a staff everywhere', () => {
    for (const p of plan) for (const n of p.notes) {
      expect(n.hint.at).toEqual([n.tick, n.durTicks, n.pitch])
      expect(n.hint.spell).toMatch(/^[A-G](#|b)*-?\d$/)
      expect(n.hint.staff).toBe(1)
    }
  })
})

// The full 408 KB export is not committed: WOVEN_XML points at badmidi's export of agent/examples/woven_chaconne.py.
describe.runIf(process.env.SLOW && process.env.WOVEN_XML && existsSync(process.env.WOVEN_XML))('woven chaconne, whole file', () => {
  let s: XmlScore, plan: ReturnType<typeof planMusicXml>
  beforeAll(() => { s = parseMusicXml(readFileSync(process.env.WOVEN_XML!, 'utf8')); plan = planMusicXml(s, { ppq: PPQ }) })
  it('is 4 tracks in 3/4, E minor, with the tempo changes', () => {
    expect(plan).toHaveLength(4)
    expect(s.key).toBe('E minor')
    const doc = blank()
    importMusicXml(doc, s, { at: 0, base: 'woven' })
    expect(getKey(doc)).toBe('E minor')
    expect(getTracks(doc).filter((t) => t.kind === 'midi' && t.role !== 'click')).toHaveLength(4)
    const rs = getRegions(doc)
    expect(rs.every((r) => r.num === 3 && r.den === 4)).toBe(true)
    expect(rs.map((r) => [r.bar, r.bpm])).toEqual([[1, 69], [25, 76], [49, 69], [65, 63], [75, 44]])
  })
  it('has staccato 16ths in bar 25 and quintuplets in bar 57 for violin 1', () => {
    const v1 = plan[0].notes
    const b25 = inBar(v1, s, 25)
    expect(b25.slice(0, 4).map((n) => n.durTicks)).toEqual([120, 120, 120, 120])
    expect(b25.slice(0, 4).map((n) => n.hint.art)).toEqual(["'", "'", "'", "'"])
    expect(b25[1].tick - b25[0].tick).toBe(720)
    const b57 = inBar(v1, s, 57)
    expect(b57.filter((n) => n.hint.tup?.n === 5 && n.hint.tup.of === 4).length).toBeGreaterThanOrEqual(5)
    console.log('bar 57 violin 1 first note:', JSON.stringify(b57[0]))
  })
  it('writes `at` equal to each note everywhere', () => {
    for (const p of plan) for (const n of p.notes) expect(n.hint.at).toEqual([n.tick, n.durTicks, n.pitch])
    console.log('woven skipped:', s.report, 'notes per part', plan.map((p) => p.notes.length), 'end ticks', plan.map((p) => p.lengthTicks))
  })
})
