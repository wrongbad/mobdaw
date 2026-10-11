// Frequency response of the simple filter (engine `dsp::svf` + `FilterDevice`), for drawing it. The engine's zero-delay
// filter is a bilinear transform of the analog prototype, so its exact digital response is the prototype evaluated at
// s = jx, x = tan(π·f/sr) / g, where g is the (pre-warped) cutoff. That is cheap and has no approximation near Nyquist.
//   D = (1−x²) + j·k·x   (k = 2·damping)     lowpass 1/D   bandpass jx/D   highpass −x²/D
// Every mode is `m0 + m1·bp + m2·lp` over D, which is how the engine builds the bell and shelves.

/** Filter modes, in `DEVICES[SIMPLE_FILTER]` option order. */
export const FILTER_LOWPASS = 0
export const FILTER_HIGHPASS = 1
export const FILTER_BANDPASS = 2
export const FILTER_NOTCH = 3
export const FILTER_PEAK = 4
export const FILTER_BELL = 5
export const FILTER_LOW_SHELF = 6
export const FILTER_HIGH_SHELF = 7

/** Modes whose `gain` param does something. */
export const filterHasGain = (mode: number) => mode >= FILTER_BELL

export type FilterSettings = { mode: number; cutoff: number; damping: number; gain?: number }

const NYQUIST_LIMIT = 0.99 * 0.5 // the engine clamps the cutoff just below Nyquist

/** Gain in dB of the filter at `hz`. `damping` is R (Q = 1/2R), `gain` in dB (bell and shelves only). */
export function filterResponseDb(f: FilterSettings, hz: number, sampleRate = 48000): number {
  const { mode } = f
  let damping = f.damping
  let warp = 1
  let m0 = 0, m1 = 0, m2 = 0
  if (filterHasGain(mode)) {
    const a = 10 ** ((f.gain ?? 0) / 40)
    const k = 2 * damping
    if (mode === FILTER_BELL) { damping /= a; m0 = 1; m1 = (k / a) * (a * a - 1) }
    else if (mode === FILTER_LOW_SHELF) { warp = 1 / Math.sqrt(a); m0 = 1; m1 = k * (a - 1); m2 = a * a - 1 }
    else { warp = Math.sqrt(a); m0 = a * a; m1 = k * (1 - a) * a; m2 = 1 - a * a }
  }
  const fc = Math.min(f.cutoff, NYQUIST_LIMIT * sampleRate)
  const x = Math.tan((Math.PI * Math.min(hz, 0.4999 * sampleRate)) / sampleRate) / (Math.tan((Math.PI * fc) / sampleRate) * warp)
  const x2 = x * x
  const k = 2 * damping
  const den = (1 - x2) ** 2 + (k * x) ** 2
  if (filterHasGain(mode)) {
    // N = m0·D + m1·(jx) + m2
    const re = m0 * (1 - x2) + m2
    const im = m0 * k * x + m1 * x
    return 10 * Math.log10(Math.max((re * re + im * im) / den, 1e-12))
  }
  const num = mode === FILTER_HIGHPASS ? x2 : mode === FILTER_BANDPASS ? x : mode === FILTER_NOTCH ? Math.abs(1 - x2) : mode === FILTER_PEAK ? 1 + x2 : 1
  return 10 * Math.log10(Math.max((num * num) / den, 1e-12))
}

/**
 * The height at which a cutoff node sits on the response, in dB. Bell and shelves: their gain. The rest: the gain at
 * the cutoff, i.e. the resonance (a notch is silent there, so it uses the band-pass level, which still orders by damping).
 */
export const filterNodeDb = (f: FilterSettings): number =>
  filterHasGain(f.mode) ? (f.gain ?? 0) : -20 * Math.log10(2 * f.damping) + (f.mode === FILTER_PEAK ? 20 * Math.log10(2) : 0)
/** Inverse of `filterNodeDb` for the modes without gain: the damping that puts the node at `db`. */
export const dampingAtNodeDb = (mode: number, db: number): number => 10 ** (-(db - (mode === FILTER_PEAK ? 20 * Math.log10(2) : 0)) / 20) / 2
