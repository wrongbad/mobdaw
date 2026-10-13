// The mobdaw icon set: inline SVG on a 16px grid, 1.6px round strokes in currentColor (docs/redesign.md §2).
// Solid glyphs (transport, dots) are filled *and* stroked, so their corners round off like the line icons.
//
//   icon('play')            -> SVGSVGElement (16px; pass a size to scale)
//   iconHtml('play')        -> the same as a markup string
//   ICON_NAMES              -> every name, for the kit page

const F = 'fill="currentColor"'

const ICONS = {
  // transport
  play: `<path d="M5 3.6 12.4 8 5 12.4Z" ${F}/>`,
  pause: `<path d="M5.2 4v8M10.8 4v8" stroke-width="2.6"/>`,
  stop: `<rect x="4.2" y="4.2" width="7.6" height="7.6" rx=".8" ${F}/>`,
  record: `<circle cx="8" cy="8" r="4" ${F}/>`,
  rewind: `<path d="M3.8 3.8v8.4"/><path d="M12.2 4 6.6 8l5.6 4Z" ${F}/>`,
  loop: `<path d="M3 9.2V7.4A2.9 2.9 0 0 1 5.9 4.5H12.4"/><path d="M10.4 2.6 12.4 4.5 10.4 6.4"/><path d="M13 6.8v1.8a2.9 2.9 0 0 1-2.9 2.9H3.6"/><path d="M5.6 9.6 3.6 11.5 5.6 13.4"/>`,
  metronome: `<path d="M6.2 2.5h3.6l2.7 11h-9Z"/><path d="M4.6 10.5h6.8"/><path d="M8 10.5 11.8 4"/>`,
  undo: `<path d="M5.8 3.4 2.9 6.3l2.9 2.9"/><path d="M3.2 6.3h6.6a3.2 3.2 0 0 1 0 6.4H7"/>`,
  redo: `<path d="M10.2 3.4l2.9 2.9-2.9 2.9"/><path d="M12.8 6.3H6.2a3.2 3.2 0 0 0 0 6.4H9"/>`,
  // view
  'zoom-in': `<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 13.6 13.6M5 7h4M7 5v4"/>`,
  'zoom-out': `<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 13.6 13.6M5 7h4"/>`,
  mixer: `<path d="M4 2.5v11M8 2.5v11M12 2.5v11"/><path d="M2.4 9.6h3.2M6.4 5.4h3.2M10.4 11h3.2" stroke-width="2.2"/>`,
  arrange: `<rect x="2.5" y="2.6" width="7" height="2.8" rx="1"/><rect x="6.5" y="6.6" width="7" height="2.8" rx="1"/><rect x="2.5" y="10.6" width="5" height="2.8" rx="1"/>`,
  browser: `<rect x="2" y="2.8" width="12" height="10.4" rx="1.6"/><path d="M6 2.8v10.4"/>`,
  dock: `<rect x="2" y="2.8" width="12" height="10.4" rx="1.6"/><path d="M2 9.4h12"/>`,
  eye: `<path d="M1.8 8S4.1 3.6 8 3.6 14.2 8 14.2 8 11.9 12.4 8 12.4 1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="2"/>`,
  // files
  export: `<path d="M8 2.5v7.6M4.9 7.2 8 10.3l3.1-3.1"/><path d="M2.8 11v1.2a1.3 1.3 0 0 0 1.3 1.3h7.8a1.3 1.3 0 0 0 1.3-1.3V11"/>`,
  upload: `<path d="M8 10.3V2.7M4.9 5.8 8 2.7l3.1 3.1"/><path d="M2.8 11v1.2a1.3 1.3 0 0 0 1.3 1.3h7.8a1.3 1.3 0 0 0 1.3-1.3V11"/>`,
  folder: `<path d="M2.2 4.6a1.1 1.1 0 0 1 1.1-1.1h2.9l1.5 1.6h5a1.1 1.1 0 0 1 1.1 1.1v6.2a1.1 1.1 0 0 1-1.1 1.1H3.3a1.1 1.1 0 0 1-1.1-1.1Z"/>`,
  search: `<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 13.6 13.6"/>`,
  // general
  help: `<circle cx="8" cy="8" r="6"/><path d="M6.2 6.4a1.9 1.9 0 0 1 3.7.4c0 1.3-1.9 1.5-1.9 2.8"/><path d="M8 11.5v.1" stroke-width="2"/>`,
  settings: `<path d="M6.79 3.77L7.08 2.17L8.92 2.17L9.21 3.77A4.4 4.4 0 0 1 10.13 4.15L11.47 3.23L12.77 4.53L11.85 5.87A4.4 4.4 0 0 1 12.23 6.79L13.83 7.08L13.83 8.92L12.23 9.21A4.4 4.4 0 0 1 11.85 10.13L12.77 11.47L11.47 12.77L10.13 11.85A4.4 4.4 0 0 1 9.21 12.23L8.92 13.83L7.08 13.83L6.79 12.23A4.4 4.4 0 0 1 5.87 11.85L4.53 12.77L3.23 11.47L4.15 10.13A4.4 4.4 0 0 1 3.77 9.21L2.17 8.92L2.17 7.08L3.77 6.79A4.4 4.4 0 0 1 4.15 5.87L3.23 4.53L4.53 3.23L5.87 4.15A4.4 4.4 0 0 1 6.79 3.77Z" stroke-width="1.4"/><circle cx="8" cy="8" r="1.9"/>`,
  edit: `<path d="M10.4 3.2l2.4 2.4-7.4 7.4-3 .6.6-3Z"/><path d="M9 4.6l2.4 2.4"/>`,
  plus: `<path d="M8 3.2v9.6M3.2 8h9.6"/>`,
  close: `<path d="M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4"/>`,
  'chevron-down': `<path d="M4.2 6.2 8 10l3.8-3.8"/>`,
  'chevron-right': `<path d="M6.2 4.2 10 8l-3.8 3.8"/>`,
  more: `<circle cx="3.6" cy="8" r=".5" ${F}/><circle cx="8" cy="8" r=".5" ${F}/><circle cx="12.4" cy="8" r=".5" ${F}/>`,
  grip: `<circle cx="6" cy="4" r=".35" ${F}/><circle cx="10" cy="4" r=".35" ${F}/><circle cx="6" cy="8" r=".35" ${F}/><circle cx="10" cy="8" r=".35" ${F}/><circle cx="6" cy="12" r=".35" ${F}/><circle cx="10" cy="12" r=".35" ${F}/>`,
  lock: `<rect x="3.5" y="7.2" width="9" height="6.3" rx="1.3"/><path d="M5.6 7.2V5.1a2.4 2.4 0 0 1 4.8 0v2.1"/>`,
  keyboard: `<rect x="1.6" y="4" width="12.8" height="8" rx="1.6"/><path d="M4.6 6.9h.1M7 6.9h.1M9.4 6.9h.1M11.6 6.9h.1M5.6 9.4h4.8"/>`,
  trash: `<path d="M2.8 4.4h10.4M6.2 4.4V2.9h3.6v1.5"/><path d="M4.1 4.4l.6 8.2a1.1 1.1 0 0 0 1.1 1h4.4a1.1 1.1 0 0 0 1.1-1l.6-8.2"/><path d="M6.8 7v3.8M9.2 7v3.8"/>`,
  duplicate: `<rect x="5.6" y="5.6" width="8" height="8" rx="1.4"/><path d="M10.4 5.6V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.3a1.3 1.3 0 0 0 1.3 1.3h1.8"/>`,
  scissors: `<circle cx="4.4" cy="4.6" r="2"/><circle cx="4.4" cy="11.4" r="2"/><path d="M6.1 5.7 13.4 12M6.1 10.3 13.4 4"/>`,
  magnet: `<path d="M3.4 2.6h2.8v5.2a1.8 1.8 0 0 0 3.6 0V2.6h2.8v5.2a4.6 4.6 0 0 1-9.2 0Z"/><path d="M3.4 5.4h2.8M9.8 5.4h2.8"/>`,
  power: `<path d="M8 2.4v5"/><path d="M4.7 4.6a5 5 0 1 0 6.6 0"/>`,
  automation: `<path d="M2.2 12.2 5.4 5.6l4 3.8 4.4-5.6"/><circle cx="5.4" cy="5.6" r=".6" ${F}/><circle cx="9.4" cy="9.4" r=".6" ${F}/>`,
  chat: `<path d="M3.2 3.2h9.6a1.2 1.2 0 0 1 1.2 1.2v5.8a1.2 1.2 0 0 1-1.2 1.2H7.6L4.6 13.8v-2.4H3.2A1.2 1.2 0 0 1 2 10.2V4.4a1.2 1.2 0 0 1 1.2-1.2Z"/>`,
  users: `<circle cx="6" cy="5.4" r="2.4"/><path d="M1.8 13.2a4.2 4.2 0 0 1 8.4 0"/><path d="M10.6 3.1a2.4 2.4 0 0 1 0 4.6M12.2 9.4a4.2 4.2 0 0 1 2 3.8"/>`,
  // track controls
  mute: `<path d="M2.4 6.1h2.2L7.8 3.4v9.2L4.6 9.9H2.4Z"/><path d="M10.4 6.1l3.6 3.8M14 6.1l-3.6 3.8"/>`,
  speaker: `<path d="M2.4 6.1h2.2L7.8 3.4v9.2L4.6 9.9H2.4Z"/><path d="M10.2 5.6a3.4 3.4 0 0 1 0 4.8M12.1 3.8a6 6 0 0 1 0 8.4"/>`,
  solo: `<path d="M2.8 10.4V8.6a5.2 5.2 0 0 1 10.4 0v1.8"/><rect x="2.2" y="9.4" width="2.8" height="4.2" rx="1.1"/><rect x="11" y="9.4" width="2.8" height="4.2" rx="1.1"/>`,
  arm: `<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.9" ${F}/>`,
  // content kinds
  piano: `<rect x="2" y="2.8" width="12" height="10.4" rx="1.6"/><path d="M6.2 3v5.4M9.8 3v5.4" stroke-width="2.2"/><path d="M6.2 8.4v4.8M9.8 8.4v4.8"/>`,
  drum: `<ellipse cx="8" cy="5.6" rx="5.6" ry="2.1"/><path d="M2.4 5.6v4.8c0 1.2 2.5 2.1 5.6 2.1s5.6-.9 5.6-2.1V5.6"/><path d="M5 7.5v4.6M11 7.5v4.6M8 7.7v4.8"/>`,
  wave: `<path d="M2.6 7v2M5.3 4.6v6.8M8 2.4v11.2M10.7 5.2v5.6M13.4 6.6v2.8"/>`,
  synth: `<path d="M1.8 11.2h2.6V4.8h3.2v6.4h3.2V4.8h3.4"/>`,
  effect: `<rect x="3.8" y="2.2" width="8.4" height="11.6" rx="1.6"/><circle cx="8" cy="6.2" r="1.8"/><path d="M6.6 10.8h2.8"/>`,
} as const

export type IconName = keyof typeof ICONS
export const ICON_NAMES = Object.keys(ICONS) as IconName[]

const open = (size: number, cls: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" class="icon${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">`

/** An icon as SVG markup. */
export function iconHtml(name: IconName, size = 16, cls = ''): string {
  return `${open(size, cls)}${ICONS[name]}</svg>`
}

const tpl = typeof document !== 'undefined' ? document.createElement('template') : null

/** An icon as a fresh SVG element. */
export function icon(name: IconName, size = 16, cls = ''): SVGSVGElement {
  tpl!.innerHTML = iconHtml(name, size, cls)
  return tpl!.content.firstElementChild as SVGSVGElement
}

/** Swap the glyph inside an icon element in place (e.g. play <-> pause), keeping its size and classes. */
export function setIcon(el: SVGSVGElement, name: IconName) {
  el.innerHTML = ICONS[name]
}
