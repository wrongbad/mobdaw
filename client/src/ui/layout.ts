// The timeline's fixed horizontal layout, defined once: styles.css reads --head / --gutter / --frame-w, which `applyLayout` sets from these.
export const HEAD = 168 // a track's header
export const GUTTER = 6 // the gap to its left (and between tiles)
/** The left frame of a bus (and the master) around its tracks: how far each level of nesting moves its tracks in. */
export const FRAME = 10
/** Where the lanes' time axis starts, in the scroller's content px. */
export const HEADER = HEAD + GUTTER

export function applyLayout(root: HTMLElement = document.documentElement) {
  root.style.setProperty('--head', `${HEAD}px`)
  root.style.setProperty('--gutter', `${GUTTER}px`)
  root.style.setProperty('--frame-w', `${FRAME}px`)
}
