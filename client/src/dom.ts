type Attrs = Record<string, string | number | boolean | ((e: any) => void) | undefined>

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k in el && k !== 'list') (el as any)[k] = v
    else el.setAttribute(k, String(v))
  }
  for (const k of kids) if (k != null) el.append(k)
  return el
}

export const mount = (...kids: Node[]) => document.getElementById('app')!.replaceChildren(...kids)
