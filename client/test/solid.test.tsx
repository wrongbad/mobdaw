// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

describe('solid in vitest', () => {
  it('renders and patches only the bound text', () => {
    const root = document.createElement('div')
    const [n, setN] = createSignal(1)
    const dispose = render(() => <b class="x">{n()}</b>, root)
    const el = root.firstChild
    expect(root.textContent).toBe('1')
    setN(2)
    expect(root.textContent).toBe('2')
    expect(root.firstChild).toBe(el)
    dispose()
  })
})
