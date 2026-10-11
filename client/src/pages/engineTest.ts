// Dev playground for the wasm engine (milestone 1). Route: #/engine-test. Linked from nowhere.
import type { Me } from '@mobdaw/shared'
import { h, mount } from '../dom'
import { nav } from '../ui/nav'
import { getCtx } from '../audio/context'
import { EngineHost, P } from '../audio/engine-host'
import { valueTip } from '../ui/valueTip'

type Slider = { label: string; id: number; min: number; max: number; log: boolean; init: number; unit: string }
const SLIDERS: Slider[] = [
  { label: 'freq', id: P.freq, min: 20, max: 10000, log: true, init: 220, unit: 'hz' },
  { label: 'rolloff b', id: P.rolloff, min: 0.001, max: 3, log: true, init: 0.3, unit: '' },
  { label: 'cutoff', id: P.cutoff, min: 20, max: 20000, log: true, init: 2000, unit: 'hz' },
  { label: 'damping r', id: P.damping, min: 0.05, max: 2, log: false, init: Math.SQRT1_2, unit: '' },
  { label: 'gain', id: P.gain, min: 0, max: 1, log: false, init: 0.3, unit: '' },
]

// Sliders are 0..1 internally; map to/from the parameter range.
const toValue = (s: Slider, t: number) => (s.log ? s.min * (s.max / s.min) ** t : s.min + t * (s.max - s.min))
const toPos = (s: Slider, v: number) => (s.log ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min))
const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3))

export function engineTestPage(me: Me) {
  let host: EngineHost | null = null
  let on = false
  const values = new Map(SLIDERS.map((s) => [s.id, s.init]))

  const status = h('p', { className: 'dim' }, 'idle')
  const err = h('p', { className: 'error' })
  const startBtn = h('button', {
    onclick: async () => {
      err.textContent = ''
      try {
        const ctx = getCtx()
        await ctx.resume()
        if (!host) {
          status.textContent = 'loading engine…'
          host = await EngineHost.create(ctx)
          host.node.connect(ctx.destination)
          for (const [id, v] of values) host.setParam(id, v)
        }
        on = !on
        host.setParam(P.gate, on ? 1 : 0)
        startBtn.textContent = on ? 'stop' : 'start'
        status.textContent = `${on ? 'playing' : 'stopped'} (engine ready)`
      } catch (e) {
        err.textContent = String((e as Error).message ?? e)
        status.textContent = 'error'
      }
    },
  }, 'start')

  const rows = SLIDERS.map((s) => {
    const out = h('span', { className: 'dim' }, `${fmt(s.init)} ${s.unit}`)
    const input = h('input', {
      type: 'range', min: 0, max: 1, step: 'any', value: toPos(s, s.init),
      oninput: (e: any) => {
        const v = toValue(s, Number(e.target.value))
        values.set(s.id, v)
        out.textContent = `${fmt(v)} ${s.unit}`
        host?.setParam(s.id, v)
      },
    })
    valueTip(input, out)
    return h('label', { className: 'row' }, h('span', { style: 'width:90px' }, s.label), input, out)
  })

  const ctx = getCtx()
  mount(nav(me), h('main', {},
    h('h2', {}, 'engine test'),
    h('p', { className: 'dim' }, `sample rate: ${ctx.sampleRate} hz · finnwave → svf low-pass → gain`),
    h('div', { className: 'row' }, startBtn), ...rows, status, err))

  return () => {
    host?.setParam(P.gate, 0)
    host?.dispose()
  }
}
