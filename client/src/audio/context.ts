import { DEFAULT_SAMPLE_RATE } from '@mobdaw/shared'

// One AudioContext per sample rate: the engine renders at the project rate, and
// decodeAudioData resamples sources to the context's rate.
const ctxs = new Map<number, AudioContext>()

// The iOS audio session category follows what the page is doing (Safari 16.4+; elsewhere the property doesn't exist):
// - microphone in use: 'play-and-record' (capture is refused in 'playback': "AudioSession category is not compatible with audio capture");
// - sound being made: 'playback', so the hardware silent switch doesn't mute Web Audio;
// - otherwise 'auto': an idle page isn't listed in the lock screen / notification center as "now playing".
let captures = 0
let playbacks = 0
function applySession() {
  const session = (navigator as { audioSession?: { type: string } }).audioSession
  if (session) session.type = captures > 0 ? 'play-and-record' : playbacks > 0 ? 'playback' : 'auto'
}
function hold(count: 'captures' | 'playbacks'): () => void {
  if (count === 'captures') captures++
  else playbacks++
  applySession()
  let released = false
  return () => {
    if (released) return
    released = true
    if (count === 'captures') captures--
    else playbacks--
    applySession()
  }
}
/** Declare that the microphone is (about to be) in use; the returned function releases it (once). */
export const holdCapture = () => hold('captures')
/** Declare that sound is (about to be) playing; the returned function releases it (once). */
export const holdPlayback = () => hold('playbacks')

export function getCtx(sampleRate = DEFAULT_SAMPLE_RATE): AudioContext {
  applySession()
  let c = ctxs.get(sampleRate)
  if (!c) ctxs.set(sampleRate, (c = new AudioContext({ sampleRate })))
  return c
}
