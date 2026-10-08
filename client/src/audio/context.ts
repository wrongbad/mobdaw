import { DEFAULT_SAMPLE_RATE } from '@mobdaw/shared'

// One AudioContext per sample rate: the engine renders at the project rate, and
// decodeAudioData resamples sources to the context's rate.
const ctxs = new Map<number, AudioContext>()
export function getCtx(sampleRate = DEFAULT_SAMPLE_RATE): AudioContext {
  // iOS mutes Web Audio under the hardware silent switch unless the page declares media playback
  // (Safari 16.4+; elsewhere the property doesn't exist).
  const session = (navigator as { audioSession?: { type: string } }).audioSession
  if (session) session.type = 'playback'
  let c = ctxs.get(sampleRate)
  if (!c) ctxs.set(sampleRate, (c = new AudioContext({ sampleRate })))
  return c
}
