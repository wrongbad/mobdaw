// The ruler's editing: a menu at a bar (tempo / meter from here, free region, ramp, markers, delete region) and the small dialogs
// behind it. Every write is one doc transaction (one undo step) through the shared regions / markers helpers.
import {
  addMarker, deleteMarker, deleteRegion, getMarkers, getRegions, getSampleRate, updateMarker, type Marker, type Region, type TimeMap,
} from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { modal } from '../theme/dialog'
import { popover, type MenuItem } from './popover'
import { meterLabel } from './rulerModel'
import {
  parseFreeSeconds, parseMarkerLabel, parseTempoForm, rampOption, regionAt, setFreeHere, setTempoHere, toggleRamp, type Parsed,
} from './rulerEdit'

/** What the menu was opened on: a bar, and optionally the region / marker that starts there. */
export type RulerTarget = { bar: number; regionId?: string; markerId?: string }

const field = (label: string, input: HTMLElement) => h('label', { className: 'field' }, h('span', {}, label), input)

/** A small form dialog: `fields`, a line for errors, and an ok button that runs `submit` and closes when it returns ok. */
function formDialog(title: string, fields: HTMLElement[], ok: string, submit: () => Parsed<unknown>, extraFoot: HTMLElement[] = []) {
  const err = h('p', { className: 'error', hidden: true })
  const go = h('button', { className: 'btn primary' }, ok)
  const run = () => {
    const r = submit()
    if (r.ok) return m.close()
    err.hidden = false
    err.textContent = r.error
  }
  go.onclick = run
  const m = modal({ title, body: [...fields, err], foot: [...extraFoot, h('button', { className: 'btn', onclick: () => m.close() }, 'cancel'), go], className: 'tl-dialog' })
  m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') (e.preventDefault(), run()) })
  ;(fields[0]?.querySelector('input') as HTMLInputElement | null)?.select()
  return m
}

/** "tempo / meter from here": bpm, meter (num/den) and optional beat groups. */
export function tempoDialog(doc: Y.Doc, map: TimeMap, bar: number) {
  const cur = regionAt(getRegions(doc), bar)
  const m0 = cur.kind === 'metered' ? cur : map.meterAt(bar).region
  const at = m0.kind === 'metered' ? m0 : { bpm: 120, num: 4, den: 4, groups: undefined as number[] | undefined }
  const bpm = h('input', { value: String(+at.bpm.toFixed(2)), inputMode: 'decimal', spellcheck: false })
  const meter = h('input', { value: `${at.num}/${at.den}`, spellcheck: false, title: 'beats per bar over the note value, like 4/4, 6/8 or 7/8' })
  const groups = h('input', { value: at.groups?.join('+') ?? '', placeholder: 'default', spellcheck: false, title: 'how the beats are counted, like 2+2+3 for 7/8 (the first beat of each group is accented)' })
  formDialog(`tempo / meter from bar ${bar}`, [field('tempo (quarter notes per minute)', bpm), field('meter', meter), field('beat groups (optional, like 2+2+3)', groups)], 'set',
    () => {
      const f = parseTempoForm(bpm.value, meter.value, groups.value)
      if (f.ok) setTempoHere(doc, bar, f.value)
      return f
    })
}

/** "free region here": one unmetered bar of a given length in seconds. */
export function freeDialog(doc: Y.Doc, bar: number) {
  const rate = getSampleRate(doc)
  const cur = regionAt(getRegions(doc), bar)
  const len = h('input', { value: cur.kind === 'free' && cur.bar === bar ? String(+(cur.length / rate).toFixed(2)) : '4', inputMode: 'decimal', spellcheck: false })
  formDialog(`free region at bar ${bar}`, [field('length (seconds), with no bars or beats inside', len)], 'set', () => {
    const r = parseFreeSeconds(len.value, rate)
    if (r.ok) setFreeHere(doc, bar, r.value)
    return r
  })
}

/** Add a marker at `bar`, or edit `marker`. */
export function markerDialog(doc: Y.Doc, bar: number, marker?: Marker) {
  const label = h('input', { value: marker?.label ?? '', placeholder: 'A, Verse 2, ...', maxLength: 40, spellcheck: false })
  const text = h('input', { value: marker?.text ?? '', placeholder: 'optional notes about this section', spellcheck: false })
  formDialog(marker ? `marker at bar ${marker.bar}` : `new marker at bar ${bar}`, [field('label', label), field('description', text)], marker ? 'save' : 'add', () => {
    const l = parseMarkerLabel(label.value)
    if (!l.ok) return l
    if (marker) updateMarker(doc, marker.id, { label: l.value, text: text.value.trim() })
    else addMarker(doc, { bar, label: l.value, ...(text.value.trim() ? { text: text.value.trim() } : {}) })
    return l
  })
}

/** The entries of the ruler menu at a bar. `say` shows a line in the status bar. */
export function rulerMenuItems(doc: Y.Doc, map: TimeMap, t: RulerTarget, say: (text: string) => void): MenuItem[] {
  const regions = getRegions(doc)
  const markers = getMarkers(doc)
  const here: Region | undefined = regions.find((r) => r.bar === t.bar)
  const markerHere = markers.filter((m) => m.bar === t.bar)
  const ramp = rampOption(regions, t.bar)
  const items: MenuItem[] = [
    { label: here ? `edit tempo / meter (bar ${t.bar})…` : `tempo / meter from bar ${t.bar}…`, run: () => tempoDialog(doc, map, t.bar), title: 'a new tempo and time signature from this bar until the next change. MIDI moves with the bars; audio stays where it is.' },
    { label: `free region at bar ${t.bar}…`, run: () => freeDialog(doc, t.bar), title: 'one bar of unmetered time of a given length, with no beats in it' },
    ramp.kind === 'remove'
      ? { label: 'remove ramp', run: () => void toggleRamp(doc, t.bar), title: 'hold the tempo of this region until the next one' }
      : { label: 'ramp to next', run: () => void toggleRamp(doc, t.bar), disabled: ramp.kind === 'none', title: ramp.kind === 'none' ? ramp.reason : `move the tempo gradually to ${ramp.to} bpm at the next region`, hint: ramp.kind === 'add' ? `→ ${+ramp.to.toFixed(2)}` : undefined },
    'sep',
    { label: `add marker at bar ${t.bar}…`, run: () => markerDialog(doc, t.bar) },
  ]
  for (const mk of markerHere) {
    items.push({ label: `edit marker "${mk.label}"…`, run: () => markerDialog(doc, t.bar, mk) })
    items.push({ label: `delete marker "${mk.label}"`, danger: true, run: () => deleteMarker(doc, mk.id) })
  }
  if (here) {
    items.push('sep')
    const first = regions[0].id === here.id
    items.push({
      label: `delete ${here.kind === 'free' ? 'free ' : ''}region at bar ${t.bar} (${here.kind === 'metered' ? meterLabel(here) : 'free'})`, danger: true, disabled: first,
      title: first ? 'the first region sets the starting tempo; change it instead' : 'the previous region carries on over these bars',
      run: () => void (deleteRegion(doc, here.id) || say('that region cannot be deleted')),
    })
  }
  return items
}

/** Open the ruler menu at viewport point `at`. */
export function openRulerMenu(anchor: HTMLElement, doc: Y.Doc, map: TimeMap, t: RulerTarget, at: [number, number], say: (text: string) => void) {
  popover(anchor, rulerMenuItems(doc, map, t, say), at)
}
