// One looper slot's card: mute and volume, speed (0.1x-4x, log slider), a "draw region" arm button and clear.
import { LOOP_SPEED_MAX, LOOP_SPEED_MIN, type Looper } from '@mobdaw/shared'
import { h } from '../dom'
import { deleteMenu } from './popover'

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
  /** Arm / disarm drawing this looper's region on the lane. */
  toggleArm(id: string): void
  clear(id: string): void
  remove(id: string): void
}

const RATIO = LOOP_SPEED_MAX / LOOP_SPEED_MIN
const toSpeed = (pos: number) => {
  const s = LOOP_SPEED_MIN * RATIO ** pos
  return Math.abs(s - 1) < 0.03 ? 1 : s // detent at 1x
}
const toPos = (s: number) => Math.log(s / LOOP_SPEED_MIN) / Math.log(RATIO)
const fmtSpeed = (s: number) => `${s.toFixed(2)}×`

export function looperCard(lp: Looper, deps: LooperDeps) {
  const id = lp.id
  const color = LOOP_COLORS[lp.slot % LOOP_COLORS.length]
  const draw = h('button', { title: 'draw the loop region on the track', onclick: () => deps.toggleArm(id) }, 'draw')
  const clear = h('button', { title: 'clear region', onclick: () => deps.clear(id) }, 'clear')
  const remove = h('button', { className: 'x', title: 'remove looper', onclick: () => deps.remove(id) }, '×')
  const mute = h('button', { className: 'mute', title: 'mute', onclick: () => deps.setMuted(id, !muted) }, 'M')
  draw.disabled = clear.disabled = remove.disabled = mute.disabled = deps.readOnly
  let muted = false
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, disabled: deps.readOnly, title: 'volume' })
  vol.onpointerdown = () => deps.grab()
  vol.oninput = () => deps.setGain(id, Number(vol.value))
  const speed = h('input', { type: 'range', min: 0, max: 1, step: 'any', disabled: deps.readOnly, title: 'speed' })
  const out = h('span', { className: 'dim out' })
  speed.onpointerdown = () => deps.grab()
  speed.oninput = () => {
    const v = toSpeed(Number(speed.value))
    out.textContent = fmtSpeed(v)
    deps.commit(id, v)
  }
  const el = h('div', { className: 'dev looper' },
    h('div', { className: 'dev-head' }, h('strong', {}, `loop ${lp.slot + 1}`), h('span', { className: 'grow' }), remove),
    h('div', { className: 'prm' }, h('span', { className: 'dim' }, 'volume'), h('div', { className: 'ctl' }, mute, vol)),
    h('label', { className: 'prm' }, h('span', { className: 'dim' }, 'speed'), speed, out),
    h('div', { className: 'prm' }, h('span', { className: 'dim' }, 'region'), h('div', { className: 'btns' }, draw, clear)))
  el.style.setProperty('--c', color)
  deleteMenu(el, 'Delete looper', () => deps.remove(id), () => !deps.readOnly)

  function update(l: Looper, armed: boolean, rate: number) {
    if (document.activeElement !== speed) {
      speed.value = String(toPos(l.speed))
      out.textContent = fmtSpeed(l.speed)
    }
    muted = l.muted ?? false
    mute.classList.toggle('on', muted)
    if (document.activeElement !== vol) vol.value = String(l.gain ?? 1)
    const has = l.length > 0
    clear.hidden = !has
    draw.classList.toggle('on', armed)
    draw.textContent = armed ? 'drag on track…' : has ? 'redraw' : 'draw'
  }
  update(lp, false, 48000)
  return { el, update }
}
