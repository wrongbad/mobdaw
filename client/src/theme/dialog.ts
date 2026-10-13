// Modal dialogs in the theme's style (dialog.modal in base.css): a title bar with a close button, a body, a footer.
import { h } from '../dom'
import { icon } from './icons'

export type Modal = { el: HTMLDialogElement; body: HTMLElement; foot: HTMLElement; close(): void }

/** Open a modal. It removes itself when closed (Escape, the close button, or `close()`). */
export function modal(o: { title: string; body?: (Node | string | null)[]; foot?: (Node | null)[]; className?: string; onClose?(): void }): Modal {
  const body = h('div', { className: 'modal-body' }, ...(o.body ?? []))
  const foot = h('div', { className: 'modal-foot' }, ...(o.foot ?? []))
  const closeBtn = h('button', { className: 'icon-btn', title: 'close (esc)', 'aria-label': 'close', onclick: () => el.close() }, icon('close'))
  const el = h('dialog', { className: `modal${o.className ? ' ' + o.className : ''}`, onclose: () => (o.onClose?.(), el.remove()) },
    h('div', { className: 'modal-head' }, h('h2', {}, o.title), closeBtn),
    body, foot)
  // a press on the backdrop (outside the box) closes it
  el.addEventListener('pointerdown', (e) => {
    if (e.target !== el) return
    const r = el.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close()
  })
  el.addEventListener('keydown', (e) => e.stopPropagation()) // studio shortcuts stay out of dialogs
  document.body.append(el)
  el.showModal()
  return { el, body, foot, close: () => el.close() }
}

/** Ask before doing something. Resolves true when `action` is pressed. */
export function confirmModal(o: { title: string; text: string; action: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false
    const go = h('button', { className: o.danger ? 'btn danger-fill' : 'btn primary', onclick: () => ((ok = true), m.close()) }, o.action)
    const m = modal({
      title: o.title,
      body: [h('p', { className: 'modal-text' }, o.text)],
      foot: [h('button', { className: 'btn', onclick: () => m.close() }, 'cancel'), go],
      onClose: () => resolve(ok),
    })
    go.focus()
  })
}
