// One looper slot's card: mute and volume, speed (0.1x-4x, log slider), tape controls (saturation, filter, warble), a "draw region" arm button and clear.
import { LOOP_CUTOFF_MAX, LOOP_CUTOFF_MIN, LOOP_SPEED_MAX, LOOP_SPEED_MIN, type Looper, type ParamTarget } from '@mobdaw/shared'
import { h } from '../dom'
import { NO_AUTO, type AutoInfo } from './automation'
import { deleteMenu } from './popover'
import { fmtDb } from './slider'
import { valueTip } from './valueTip'

export const LOOP_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0']

export type LooperDeps = {
  readOnly: boolean
  /** A slider drag begins (so it undoes as one step). */
  grab(): void
  /** Write the speed to the doc as the slider moves: the engine applies it live, smoothed. */
  commit(id: string, speed: number): void
  setMuted(id: string, muted: boolean): void
  /** Write the volume (0..1) to the doc as the slider moves. */
  setGain(id: string, gain: number): void
  /** Write a tape control (saturation, low-pass cutoff in Hz, warble depth) to the doc as its slider moves. */
  setTape(id: string, patch: { sat?: number; cutoff?: number; warble?: number }): void
  /** Arm / disarm drawing this looper's region on the lane. */
  toggleArm(id: string): void
  clear(id: string): void
  remove(id: string): void
  /** Make a param's name offer "Automate" (the timeline owns the lanes). */
  autoMenu(label: HTMLElement, target: ParamTarget): void
}

const RATIO = LOOP_SPEED_MAX / LOOP_SPEED_MIN
const toSpeed = (pos: number) => {
  const s = LOOP_SPEED_MIN * RATIO ** pos
  return Math.abs(s - 1) < 0.03 ? 1 : s // detent at 1x
}
const toPos = (s: number) => Math.log(s / LOOP_SPEED_MIN) / Math.log(RATIO)
const CUT_RATIO = LOOP_CUTOFF_MAX / LOOP_CUTOFF_MIN
const toCutoff = (pos: number) => LOOP_CUTOFF_MIN * CUT_RATIO ** pos
const toCutPos = (hz: number) => Math.log(hz / LOOP_CUTOFF_MIN) / Math.log(CUT_RATIO)
const fmtCutoff = (hz: number) => (hz >= LOOP_CUTOFF_MAX * 0.99 ? 'open' : hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`)
const fmtPct = (v: number) => `${Math.round(v * 100)}%`
const fmtSpeed = (s: number) => `${s.toFixed(2)}×`

export function looperCard(lp: Looper, deps: LooperDeps) {
  const id = lp.id
  const color = LOOP_COLORS[lp.slot % LOOP_COLORS.length]
  const draw = h('button', { title: 'draw the loop region on the track', onclick: () => deps.toggleArm(id) }, 'draw')
  const clear = h('button', { title: 'clear region', onclick: () => deps.clear(id) }, 'clear')
  const remove = h('button', { className: 'x', title: 'remove looper', onclick: () => deps.remove(id) }, '×')
  const mute = h('button', { className: 'mute', title: 'mute', onclick: () => deps.setMuted(id, !muted) }, 'm')
  draw.disabled = clear.disabled = remove.disabled = mute.disabled = deps.readOnly
  let muted = false
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, disabled: deps.readOnly, title: 'volume' })
  valueTip(vol, () => fmtDb(Number(vol.value)))
  vol.onpointerdown = () => deps.grab()
  vol.oninput = () => deps.setGain(id, Number(vol.value))
  const speed = h('input', { type: 'range', min: 0, max: 1, step: 'any', disabled: deps.readOnly, title: 'speed' })
  const out = h('span', { className: 'dim out' })
  valueTip(speed, out)
  speed.onpointerdown = () => deps.grab()
  speed.oninput = () => {
    const v = toSpeed(Number(speed.value))
    out.textContent = fmtSpeed(v)
    deps.commit(id, v)
  }
  const tapeSlider = (title: string) => {
    const el = h('input', { type: 'range', min: 0, max: 1, step: 'any', disabled: deps.readOnly, title })
    el.onpointerdown = () => deps.grab()
    return el
  }
  const sat = tapeSlider('saturation')
  const satOut = h('span', { className: 'dim out' })
  valueTip(sat, satOut)
  sat.oninput = () => {
    satOut.textContent = fmtPct(Number(sat.value))
    deps.setTape(id, { sat: Number(sat.value) })
  }
  const filter = tapeSlider('low-pass filter')
  const filterOut = h('span', { className: 'dim out' })
  valueTip(filter, filterOut)
  filter.oninput = () => {
    const hz = toCutoff(Number(filter.value))
    filterOut.textContent = fmtCutoff(hz)
    deps.setTape(id, { cutoff: hz })
  }
  const warble = tapeSlider('tape wow & flutter')
  const warbleOut = h('span', { className: 'dim out' })
  valueTip(warble, warbleOut)
  warble.oninput = () => {
    warbleOut.textContent = fmtPct(Number(warble.value))
    deps.setTape(id, { warble: Number(warble.value) })
  }
  // a param's name is its automation menu; `names` lets update() mark the ones a lane drives
  const names: Record<string, HTMLElement> = {}
  const name = (key: string, text: string) => {
    const label = (names[key] = h('span', { className: 'dim' }, text))
    deps.autoMenu(label, { scope: lp.trackId, kind: 'looper', owner: id, param: key })
    return label
  }
  const el = h('div', { className: 'dev looper' },
    h('div', { className: 'dev-head' }, h('strong', {}, `loop ${lp.slot + 1}`), h('span', { className: 'grow' }), remove),
    h('div', { className: 'prm' }, name('gain', 'volume'), h('div', { className: 'ctl' }, mute, vol)),
    h('label', { className: 'prm' }, name('speed', 'speed'), speed),
    h('label', { className: 'prm' }, name('sat', 'saturate'), sat),
    h('label', { className: 'prm' }, name('cutoff', 'filter'), filter),
    h('label', { className: 'prm' }, name('warble', 'warble'), warble),
    h('div', { className: 'prm' }, h('span', { className: 'dim' }, 'region'), h('div', { className: 'btns' }, draw, clear)))
  el.style.setProperty('--c', color)
  deleteMenu(el, 'delete looper', () => deps.remove(id), () => !deps.readOnly)

  let current = lp
  let lastArmed = false
  /** `auto`: the params a lane drives, keyed by `Looper` field; those show the lane's value and can't be dragged. */
  function update(l: Looper, armed: boolean, rate: number, auto: Map<string, AutoInfo> = NO_AUTO) {
    current = l
    lastArmed = armed
    // a driven slider follows its lane (and is locked); a free one follows the doc unless it is being dragged
    const val = (key: string, input: HTMLInputElement, stat: number) => {
      const a = auto.get(key)
      const driven = !!a?.on && a.value != null
      names[key].classList.toggle('auto', !!a)
      names[key].classList.toggle('driven', driven)
      input.disabled = deps.readOnly || driven
      return { v: driven ? a!.value! : stat, show: driven || document.activeElement !== input }
    }
    const sp = val('speed', speed, l.speed)
    if (sp.show) {
      speed.value = String(toPos(sp.v))
      out.textContent = fmtSpeed(sp.v)
    }
    muted = l.muted ?? false
    mute.classList.toggle('on', muted)
    const vo = val('gain', vol, l.gain ?? 1)
    if (vo.show) vol.value = String(vo.v)
    const sa = val('sat', sat, l.sat ?? 0)
    if (sa.show) {
      sat.value = String(sa.v)
      satOut.textContent = fmtPct(sa.v)
    }
    const fi = val('cutoff', filter, l.cutoff ?? LOOP_CUTOFF_MAX)
    if (fi.show) {
      filter.value = String(toCutPos(fi.v))
      filterOut.textContent = fmtCutoff(fi.v)
    }
    const wa = val('warble', warble, l.warble ?? 0)
    if (wa.show) {
      warble.value = String(wa.v)
      warbleOut.textContent = fmtPct(wa.v)
    }
    const has = l.length > 0
    clear.hidden = !has
    draw.classList.toggle('on', armed)
    draw.textContent = armed ? 'drag on track…' : has ? 'redraw' : 'draw'
  }
  update(lp, false, 48000)
  /** Repaint with new automation values only (the playhead moved). */
  const refresh = (auto: Map<string, AutoInfo>) => update(current, lastArmed, 48000, auto)
  return { el, update, refresh }
}
