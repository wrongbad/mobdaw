// What a track is, as people say it (audio, instrument, drums, soundscape, click), for its header icon and tooltip.
// A MIDI track is a drum track when every instrument on it is a drum, or every clip on it is a drum grid.
import { DEVICES, isDrum, type Clip, type Device, type Track } from '@mobdaw/shared'
import type { IconName } from '../theme/icons'

export function trackKind(t: Pick<Track, 'id' | 'kind' | 'role'>, devices: Pick<Device, 'trackId' | 'type' | 'keyLo' | 'keyHi'>[], clips: Pick<Clip, 'trackId' | 'kind'>[]): { icon: IconName; label: string } {
  if (t.kind === 'audio') return { icon: 'wave', label: 'audio track' }
  if (t.kind === 'soundscape') return { icon: 'loop', label: 'soundscape' }
  if (t.role === 'click') return { icon: 'metronome', label: 'click track' }
  return isDrumTrack(t, devices, clips) ? { icon: 'drum', label: 'drum track' } : { icon: 'piano', label: 'instrument track' }
}

/** A MIDI track is a drum track when every instrument on it is a drum, or (with no instruments) every clip on it is a drum grid. */
export function isDrumTrack(t: Pick<Track, 'id'>, devices: Pick<Device, 'trackId' | 'type' | 'keyLo' | 'keyHi'>[], clips: Pick<Clip, 'trackId' | 'kind'>[]): boolean {
  const inst = devices.filter((d) => d.trackId === t.id && DEVICES[d.type]?.instrument)
  const cs = clips.filter((c) => c.trackId === t.id)
  return inst.length ? inst.every(isDrum) : cs.length > 0 && cs.every((c) => c.kind === 'midi' && (c as Clip & { kind: 'midi' }).view === 'drums')
}
