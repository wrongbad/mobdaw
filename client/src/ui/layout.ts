// The timeline's fixed horizontal layout, defined once: styles.css reads --head / --gutter, which `applyLayout` sets from these.
export const HEAD = 168 // a track's header
export const GUTTER = 6 // the gap to its left (and between tiles)
/** Where the lanes' time axis starts, in the scroller's content px. */
export const HEADER = HEAD + GUTTER

export function applyLayout(root: HTMLElement = document.documentElement) {
  root.style.setProperty('--head', `${HEAD}px`)
  root.style.setProperty('--gutter', `${GUTTER}px`)
}
