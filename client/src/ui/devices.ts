// FX chain cards: title, bypass, remove and param controls for one device.
import { DEVICES, paramToPos, paramToValue, type Device, type ParamDef, type ParamTarget } from '@mobdaw/shared'
import { h } from '../dom'
import { NO_AUTO, type AutoInfo } from './automation'
import { deleteMenu } from './popover'
import { valueTip } from './valueTip'

export type CardDeps = {
  readOnly: boolean
  /** Apply a value to the local engine immediately (not in the doc). */
  live(deviceId: string, paramId: number, value: number): void
  /** Publish (or clear, with null) the in-progress drag for collaborators. */
  drag(d: { deviceId: string; paramId: number; value: number } | null): void
  /** Write the final value to the doc (one undo step). */
  commit(deviceId: string, paramId: number, value: number): void
  bypass(deviceId: string, bypass: boolean): void
  remove(deviceId: string): void
  /** Make a param's name offer "Automate" (the timeline owns the lanes). */
  autoMenu(label: HTMLElement, target: ParamTarget): void
}

export const fmt = (p: ParamDef, v: number) =>
  `${v >= 1000 ? Math.round(v) : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3)}${p.unit ? ` ${p.unit}` : ''}`

type Row = { p: ParamDef; input: HTMLInputElement | HTMLSelectElement; out: HTMLElement; label: HTMLElement }

export function deviceCard(dev: Device, deps: CardDeps) {
  const def = DEVICES[dev.type]
  const id = dev.id
  const bypass = h('button', { title: 'bypass', className: 'byp', onclick: () => deps.bypass(id, !current.bypass) }, 'bypass')
  const remove = h('button', { title: 'remove device', className: 'x', onclick: () => deps.remove(id) }, '×')
  bypass.disabled = remove.disabled = deps.readOnly
  let current = dev

  const rows: Row[] = (def?.params ?? []).map((p) => {
    const out = h('span', { className: 'dim out' })
    const label = h('span', { className: 'dim' }, p.name)
    deps.autoMenu(label, { scope: dev.trackId, kind: def?.instrument ? 'synth' : 'effect', owner: id, param: String(p.id) })
    if (p.options) {
      const input = h('select', { onchange: () => {
        const v = Number(input.value)
        deps.live(id, p.id, v)
        deps.commit(id, p.id, v)
      } }, ...p.options.map((o, i) => h('option', { value: String(i) }, o)))
      input.disabled = deps.readOnly
      return { p, input, out, label }
    }
    const input = h('input', { type: 'range', min: 0, max: 1, step: 'any', disabled: deps.readOnly })
    valueTip(input, out)
    input.oninput = () => {
      const v = paramToValue(p, Number(input.value))
      out.textContent = fmt(p, v)
      deps.live(id, p.id, v)
      deps.drag({ deviceId: id, paramId: p.id, value: v })
    }
    input.onchange = () => { // fires on release
      deps.commit(id, p.id, paramToValue(p, Number(input.value)))
      deps.drag(null)
    }
    return { p, input, out, label }
  })

  const el = h('div', { className: 'dev' },
    h('div', { className: 'dev-head' }, h('strong', {}, def?.name ?? `device ${dev.type}`), h('span', { className: 'grow' }), bypass, def?.instrument ? null : remove),
    ...rows.map((r) => h('label', { className: 'prm' }, r.label, r.input)))
  if (!def?.instrument) deleteMenu(el, 'delete device', () => deps.remove(id), () => !deps.readOnly)

  /**
   * `remote`: in-progress values from other users' drags, keyed by param id. `auto`: the params a lane
   * drives, keyed by param id as a string; those show the lane's value and can't be dragged.
   */
  let lastRemote = new Map<number, number>()
  function update(d: Device, remote: Map<number, number>, auto: Map<string, AutoInfo> = NO_AUTO) {
    current = d
    lastRemote = remote
    bypass.classList.toggle('on', d.bypass)
    el.classList.toggle('bypassed', d.bypass)
    for (const { p, input, out, label } of rows) {
      const a = auto.get(String(p.id))
      const driven = !!a?.on && a.value != null
      label.classList.toggle('auto', !!a)
      label.classList.toggle('driven', driven)
      input.disabled = deps.readOnly || driven
      const v = (driven ? a!.value : null) ?? remote.get(p.id) ?? d.params?.[p.id] ?? p.def
      const free = driven || document.activeElement !== input // a driven slider follows the lane even while focused
      if (free) input instanceof HTMLSelectElement ? (input.value = String(Math.round(v))) : (input.value = String(paramToPos(p, v)))
      if (!(input instanceof HTMLSelectElement) && free) out.textContent = fmt(p, v)
    }
  }
  update(dev, new Map())
  /** Repaint with new automation values only (the playhead moved). */
  const refresh = (auto: Map<string, AutoInfo>) => update(current, lastRemote, auto)
  return { el, update, refresh }
}
