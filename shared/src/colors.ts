// Track colour palette (purely visual): muted hues that read on the dark console. `Track.color` stores an index into it.
export const TRACK_COLORS = ['#58b4a8', '#6c9bd6', '#a68bd9', '#d97c9e', '#d9a648', '#8db86b', '#e0896a', '#8e9cb0'] as const
const wrap = (i: number) => ((i % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length
/** A track's colour: its own index if set, else a stable fallback by its position in the track order. */
export const trackColor = (t: { color?: number }, position = 0) => TRACK_COLORS[wrap(t.color ?? position)]
/** The colour index for the next track added: one past the number of tracks, so colours cycle in order. */
export const nextTrackColor = (tracks: readonly unknown[]) => wrap(tracks.length)
