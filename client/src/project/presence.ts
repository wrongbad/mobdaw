import type { AwarenessState } from '@mobdaw/shared'

/**
 * The part of the others' awareness state that a full draw reads: their drags (engine overrides and card values, the clips and notes they are moving), recording
 * locks and selection outlines. Anything else (playheads, who is here) is patched in place without a draw.
 */
export const remoteKey = (remote: AwarenessState[]) =>
  JSON.stringify(remote.map((r) => [r.user.username, r.dragging ?? null, r.recording ?? null, r.selection ?? null, r.moving ?? null]))
