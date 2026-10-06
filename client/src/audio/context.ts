import { DEFAULT_SAMPLE_RATE } from '@mobdaw/shared'

// One AudioContext per sample rate: the engine renders at the project rate, and
// decodeAudioData resamples sources to the context's rate.
const ctxs = new Map<number, AudioContext>()
export function getCtx(sampleRate = DEFAULT_SAMPLE_RATE): AudioContext {
  let c = ctxs.get(sampleRate)
  if (!c) ctxs.set(sampleRate, (c = new AudioContext({ sampleRate })))
  return c
}
