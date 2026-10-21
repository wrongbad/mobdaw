// Layer 3: pieces -> ABC text for abcjs, plus the character ranges of every note so a click can find its doc notes. Lines of music
// are packed to the pane's width by an estimate of each bar's width; every voice gets the same bars per line. Pure.
import { defaultGroups } from '@mobdaw/shared'
import type { DrumHead } from './drums'
import type { Bar } from './measures'
import { beatLines } from './measures'
import type { Piece } from './notate'
import { abcLetter, accidentalFor, keyName, spellPitch, type KeyInfo } from './spell'

export type Voice = { bars: Piece[][]; /** Rests are invisible (the drums' second voice). */ hidden?: boolean; stem?: 'up' | 'down' }
export type Staff = { clef: 'treble' | 'bass' | 'perc'; voices: Voice[]; /** Key -> head, for a percussion staff. */ drums?: ReadonlyMap<number, DrumHead> }
/** One track: a staff, or two (grand staff). */
export type Part = { name: string; staves: Staff[] }
export type AbcInput = { bars: readonly Bar[]; parts: readonly Part[]; key: KeyInfo; ppq: number; staffWidth: number }
export type IdRange = { start: number; end: number; noteIds: string[] }
export type Emitted = { abc: string; lines: { first: number; last: number }[]; ids: IdRange[] }

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** A written length as a multiple of the unit note (an eighth): "", "2", "/2", "3/2". */
export function lenText(len: number, ppq: number): string {
  const n = Math.round(len * 2), d = ppq
  const g = gcd(n, d) || 1
  const [a, b] = [n / g, d / g]
  return b === 1 ? (a === 1 ? '' : String(a)) : a === 1 ? `/${b}` : `${a}/${b}`
}

export function meterText(b: Bar): string {
  if (b.free) return 'none'
  const plain = b.groups.join('+') === defaultGroups(b.num, b.den).join('+')
  return plain ? `${b.num}/${b.den}` : `${b.groups.join('+')}/${b.den}`
}

const quoted = (s: string) => s.replace(/["\\\n\r]/g, ' ').trim()

type Rendered = { text: string; ids: IdRange[]; pieces: number; accs: number }

type Ctx = { ppq: number; key: KeyInfo }

function drumToken(p: Piece, drums: ReadonlyMap<number, DrumHead>): string {
  const order = ['E', 'F', 'A', 'B', 'c', 'd', 'e', 'g', 'a']
  const tok = [...p.heads]
    .map((h) => ({ h: drums.get(h.pitch) ?? { pos: 'B', x: false, open: false, kick: false } }))
    .sort((a, b) => order.indexOf(a.h.pos) - order.indexOf(b.h.pos))
    .map(({ h }) => (h.x ? '!style=x!' : '') + (h.open ? '!open!' : '') + h.pos)
  return tok.length > 1 ? `[${tok.join('')}]` : tok[0]
}

/** One voice's bar as text. `lead` is true for the score's first voice (it carries tempo and text marks). */
function renderBar(staff: Staff, voice: Voice, bar: Bar, pieces: Piece[], lead: boolean, ctx: Ctx): Rendered {
  let text = ''
  const ids: IdRange[] = []
  let accs = 0
  if (bar.meterChanged) text += `[M:${meterText(bar)}]`
  if (lead && bar.tempoChanged) text += `[Q:1/4=${Math.round(bar.bpm)}]`
  if (lead && bar.marker) text += `"^${quoted(bar.marker)}"`
  if (lead && bar.ramp) text += `"^${bar.ramp}"`
  const lines = new Set(beatLines(bar, ctx.ppq).map((t) => Math.round(t)))
  const state = new Map<string, number>()
  pieces.forEach((p, i) => {
    if (i > 0 && lines.has(Math.round(p.start))) text += ' '
    if (p.tuplet) text += `(3:2:${p.tuplet}`
    const len = lenText(p.len, ctx.ppq)
    if (!p.heads.length) {
      text += p.whole ? (voice.hidden ? 'X' : 'Z') : (voice.hidden ? 'x' : 'z') + len
      return
    }
    let tok: string
    if (staff.drums) tok = drumToken(p, staff.drums) + len
    else {
      const names = [...p.heads].sort((a, b) => a.pitch - b.pitch).map((h) => {
        const a = accidentalFor(spellPitch(h.pitch, ctx.key), ctx.key.fifths, state, p.cont)
        if (a) accs++
        return a + abcLetter(spellPitch(h.pitch, ctx.key)) + (p.tie ? '-' : '')
      })
      tok = names.length > 1 ? `[${names.join('')}]${len}` : p.tie ? `${names[0].slice(0, -1)}${len}-` : `${names[0]}${len}`
    }
    ids.push({ start: text.length, end: text.length + tok.length, noteIds: [...new Set(p.heads.flatMap((h) => h.noteIds))] })
    text += tok
  })
  return { text, ids, pieces: pieces.length, accs }
}

export function emitAbc(inp: AbcInput): Emitted {
  const { bars, parts, ppq } = inp
  // voice ids and the %%score grouping
  let n = 0
  const staves = parts.flatMap((p) => p.staves.map((s) => ({ part: p, staff: s, ids: s.voices.map(() => `V${++n}`) })))
  const group = (p: Part) => {
    const names = staves.filter((s) => s.part === p).map((s) => (s.ids.length > 1 ? `(${s.ids.join(' ')})` : s.ids[0]))
    return names.length > 1 ? `{${names.join(' ')}}` : names[0]
  }
  const score = parts.map(group).join(' ')
  let head = 'X:1\nL:1/8\n'
  head += `M:${meterText(bars[0])}\nQ:1/4=${Math.round(bars[0].bpm)}\n`
  head += `%%score ${parts.length > 1 ? `[ ${score} ]` : score}\n`
  for (const s of staves) {
    s.ids.forEach((id, vi) => {
      const first = s.part.staves[0] === s.staff && vi === 0
      const v = s.staff.voices[vi]
      head += `V:${id} clef=${s.staff.clef}${first ? ` name="${quoted(s.part.name)}"` : ''}${v.stem ? ` stem=${v.stem}` : ''}\n`
    })
  }
  // the key goes on the pitched voices only (abcjs would draw it on a percussion staff too); `K:` resets the clef, so repeat it
  head += 'K:C\n'

  // every voice's bars as text
  const flat = staves.flatMap((s) => s.staff.voices.map((voice, vi) => ({ s, voice, id: s.ids[vi] })))
  const rendered = flat.map((f, fi) => bars.map((bar, bi) => renderBar(f.s.staff, f.voice, bar, f.voice.bars[bi], fi === 0, { ppq, key: inp.key })))

  // pack bars into lines
  const lines: { first: number; last: number }[] = []
  let first = 0, used = 0
  for (let bi = 0; bi < bars.length; bi++) {
    const w = 30 + 18 * Math.max(...rendered.map((r) => r[bi].pieces)) + 10 * Math.max(...rendered.map((r) => r[bi].accs)) + (bars[bi].meterChanged ? 25 : 0)
    const cost = w + (bi === first ? 70 : 0)
    if (bi > first && used + cost > inp.staffWidth) {
      lines.push({ first, last: bi - 1 })
      first = bi
      used = w + 70
    } else used += cost
  }
  lines.push({ first, last: bars.length - 1 })

  let abc = head
  const ids: IdRange[] = []
  lines.forEach((ln, li) => {
    flat.forEach((f, fi) => {
      let line = `[V:${f.id}] `
      if (li === 0 && inp.key.fifths !== 0 && f.s.staff.clef !== 'perc') line += `[K:${keyName(inp.key.fifths)} clef=${f.s.staff.clef}] `
      for (let bi = ln.first; bi <= ln.last; bi++) {
        const r = rendered[fi][bi]
        const base = abc.length + line.length
        for (const id of r.ids) ids.push({ start: base + id.start, end: base + id.end, noteIds: id.noteIds })
        line += r.text + (bi === bars.length - 1 ? ' |]' : ' |') + (bi < ln.last ? ' ' : '')
      }
      abc += line + '\n'
    })
  })
  return { abc, lines, ids }
}
