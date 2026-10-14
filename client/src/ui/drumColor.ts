import { KEY_MIN, isDrum, type Device } from '@mobdaw/shared'
import { FILTER_COLORS } from './filterCurve'

/**
 * The one colour of a drum, shared by the drum grid rows and the synth drawer's drum cards. Keyed by the drum's MIDI key
 * (its identity: the note it answers to), not by a row or card index, so adding, deleting or reordering drums never
 * makes the two views disagree. Same palette as the loopers and EQ bands.
 */
export const drumColor = (key: number): string => FILTER_COLORS[((key % FILTER_COLORS.length) + FILTER_COLORS.length) % FILTER_COLORS.length]

/** A device's drum colour, or null for anything that is not a single-key drum. */
export const deviceDrumColor = (d: Pick<Device, 'type' | 'keyLo' | 'keyHi'>): string | null => (isDrum(d) ? drumColor(d.keyLo ?? KEY_MIN) : null)
