// FX chain cards: title, bypass, remove and param controls for one device.
import { DEVICES, paramToPos, paramToValue, type Device, type ParamDef } from '@mobdaw/shared'
import { h } from '../dom'
import { deleteMenu } from './popover'

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
}

const fmt = (p: ParamDef, v: number) =>
  `${v >= 1000 ? Math.round(v) : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3)}${p.unit ? ` ${p.unit}` : ''}`

type Row = { p: ParamDef; input: HTMLInputElement | HTMLSelectElement; out: HTMLElement }

export function deviceCard(dev: Device, deps: CardDeps) {
  const def = DEVICES[dev.type]
  const id = dev.id
  const bypass = h('button', { title: 'bypass', className: 'byp', onclick: () => deps.bypass(id, !current.bypass) }, 'bypass')
  const remove = h('button', { title: 'remove device', className: 'x', onclick: () => deps.remove(id) }, '×')
  bypass.disabled = remove.disabled = deps.readOnly
  let current = dev

  const rows: Row[] = (def?.params ?? []).map((p) => {
    const out = h('span', { className: 'dim out' })
    if (p.options) {
      const input = h('select', { onchange: () => {
        const v = Number(input.value)
        deps.live(id, p.id, v)
        deps.commit(id, p.id, v)
      } }, ...p.options.map((o, i) => h('option', { value: String(i) }, o)))
      input.disabled = deps.readOnly
      return { p, input, out }
    }
    const input = h('input', { type: 'range', min: 0, max: 1, step: 'any', disabled: deps.readOnly })
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
    return { p, input, out }
  })

  const el = h('div', { className: 'dev' },
    h('div', { className: 'dev-head' }, h('strong', {}, def?.name ?? `device ${dev.type}`), h('span', { className: 'grow' }), bypass, def?.instrument ? null : remove),
    ...rows.map((r) => h('label', { className: 'prm' }, h('span', { className: 'dim' }, r.p.name), r.input, r.out)))
  if (!def?.instrument) deleteMenu(el, 'Delete device', () => deps.remove(id), () => !deps.readOnly)

  /** `remote`: in-progress values from other users' drags, keyed by param id. */
  function update(d: Device, remote: Map<number, number>) {
    current = d
    bypass.classList.toggle('on', d.bypass)
    el.classList.toggle('bypassed', d.bypass)
    for (const { p, input, out } of rows) {
      const v = remote.get(p.id) ?? d.params?.[p.id] ?? p.def
      if (document.activeElement !== input) input instanceof HTMLSelectElement ? (input.value = String(Math.round(v))) : (input.value = String(paramToPos(p, v)))
      if (!(input instanceof HTMLSelectElement) && document.activeElement !== input) out.textContent = fmt(p, v)
    }
  }
  update(dev, new Map())
  return { el, update }
}
