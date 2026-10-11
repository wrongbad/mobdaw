// Tick marks for a range input: `fracs` are positions along the slider, 0..1. The stylesheet draws them under the handle.
const TICK = 'var(--dim)'

export function ticks(input: HTMLInputElement, fracs: number[]) {
  // the handle is 4px wide and travels from 2px to width - 2px; a tick is 1px wide
  const layers = fracs.map((f) => `linear-gradient(${TICK}, ${TICK}) calc(1.5px + ${f} * (100% - 3px)) 50% / 1px 10px no-repeat`)
  input.style.setProperty('--ticks', layers.join(', '))
}

// Fader taper for a linear gain: unity sits at UNITY_POS, a power curve falls to silence below it, and dB rises
// linearly to +6 dB (a gain of 2) at the top.
export const UNITY_POS = 0.8
const BELOW = 3
const TOP_DB = 20 * Math.log10(2)

export function posToGain(p: number) {
  if (p <= UNITY_POS) return (Math.max(p, 0) / UNITY_POS) ** BELOW
  return 10 ** ((TOP_DB * (Math.min(p, 1) - UNITY_POS)) / (1 - UNITY_POS) / 20)
}

export function gainToPos(g: number) {
  if (g <= 1) return UNITY_POS * Math.max(g, 0) ** (1 / BELOW)
  return Math.min(1, UNITY_POS + ((1 - UNITY_POS) * 20 * Math.log10(g)) / TOP_DB)
}

/** A linear gain as dB text, e.g. `-6.0 dB`, `+3.2 dB` or `-∞ dB`. */
export function fmtDb(g: number) {
  if (g < 0.0005) return '-∞ dB'
  const db = 20 * Math.log10(g)
  return `${db >= 0.05 ? '+' : ''}${Math.abs(db) < 0.05 ? '0.0' : db.toFixed(1)} dB`
}
