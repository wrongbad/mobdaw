import { describe, expect, it } from 'vitest'
import type { AwarenessState } from '@mobdaw/shared'
import { remoteKey } from '../src/project/presence'

const user = (username: string) => ({ username, color: '#fff' })
const peer = (username: string, extra: Partial<AwarenessState> = {}): AwarenessState => ({ user: user(username), ...extra })

describe('remoteKey', () => {
  it('ignores playheads, so a playing peer (or our own echo) does not schedule a full draw', () => {
    expect(remoteKey([peer('a', { playhead: 1 })])).toBe(remoteKey([peer('a', { playhead: 99999 })]))
    expect(remoteKey([peer('a', { playhead: null })])).toBe(remoteKey([peer('a')]))
  })
  it('sees drags, takes, selections and who is there', () => {
    const base = remoteKey([peer('a')])
    expect(remoteKey([peer('a', { dragging: [{ deviceId: 'd', paramId: 1, value: 0.5 }] })])).not.toBe(base)
    expect(remoteKey([peer('a', { recording: { trackId: 't', start: 0 } })])).not.toBe(base)
    expect(remoteKey([peer('a', { selection: ['c'] })])).not.toBe(base)
    expect(remoteKey([peer('a'), peer('b')])).not.toBe(base)
    expect(remoteKey([])).not.toBe(base)
  })
  it('a drag that moves is a change; one that ended is too', () => {
    const d = (value: number) => remoteKey([peer('a', { dragging: [{ deviceId: 'd', paramId: 1, value }] })])
    expect(d(0.1)).not.toBe(d(0.2))
    expect(d(0.1)).not.toBe(remoteKey([peer('a', { dragging: null })]))
    expect(remoteKey([peer('a', { dragging: null })])).toBe(remoteKey([peer('a', { dragging: undefined })]))
  })
})
