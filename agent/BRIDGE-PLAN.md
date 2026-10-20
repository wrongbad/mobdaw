# Plan: a badmidi <-> mobdaw bridge

Handoff notes from the first session that composed into a mobdaw project through the MCP. Read
`AGENTS.md` (how badmidi works) and `docs/agent-api.md` (the mobdaw agent API) first. The timeline
spec that this builds on is `docs/spec.md` / the schema v4 notes (regions, markers, `meta.ppq`).

## What happened

Goal: add a track to an existing project (a 33-bar D minor chaconne for strings: cello ground,
then viola, violin 2 and violin 1 entering every four bars). Steps taken:

1. Connected the mobdaw MCP (`claude mcp add --transport http mobdaw https://wrongbad.com/mobdaw/mcp
   --header "Authorization: Bearer mdw_..."`, token from the account page; tools only appear after
   a session restart).
2. `get_state` (text) to read the project, then wrote a badmidi piece with only the cello ground
   (retyped by hand) plus the new part, ran `check` and `lens`, and hand-converted the notes to ticks
   and `apply_ops`.
3. The new part is "violin 3": a one-note-per-bar descant from bar 17 to the end.

## Friction points

1. **Reading is lossy for the composer.** `get_state` returns the whole outline into the model's
   context (about 300 notes). It cannot be written to a file by the model, so badmidi never saw the
   upper strings: `lens` ran against the cello only. Counterpoint checks need the real ensemble.
2. **Writing is manual and unchecked.** Notes were converted by hand to tick positions and op JSON.
   Easy to get wrong, no proof that what was sent equals what was composed.
3. **The project's meter was wrong.** The v3 -> v4 migration made a 60 bpm 4/4 default map, but the
   music is 3/4 (every ground note is 2880 ticks = 3 beats). Bar numbers in the state were off until
   the region was set with `setRegion {bar: 1, meter: "3/4"}`. Worth a look: could the migration, or
   the bridge, suggest a meter from the clip contents?
4. **Preset discovery.** `addTrack preset` accepts only `finnwave`, `lofi drum`, `bore` or `none`;
   `"GM Violin"` (the name shown on existing devices) is rejected. Recreating the existing violin
   sound meant copying every param of its `bore` device by hand through `addDevice`. A
   `like: "<track name>"` option, or copying a track's devices, would remove this.
5. **No selective read.** `get_state` can't be limited to a track or bar range, so a big project
   floods the context.
6. **Session mechanics.** MCP tools need a session restart after `claude mcp add`; the token is a
   secret that the model should not see, so scripts should read it from an env var.

## Design: what to build (in this order)

1. **Pull**: `load_mobdaw(project_id)` (and `badmidi pull <id> -o piece.py`). A script (no model in
   the loop) fetches `GET /api/agent/projects/:id/state?format=json` with `Authorization: Bearer
   $MOBDAW_TOKEN` and builds a `Score`:
   - each region -> `meter_change` / `free_bar` / `tempo_mark` / `rit` / `accel` (see the end of the
     timeline spec for the mapping); markers -> `score.section`; `meta.key` -> the score's key.
   - each track -> a part (instrument from the device type: `bore`/`finnwave` names map to the
     nearest instrument; keep the device list so it can be recreated).
   - each clip -> notes at `(clip.startTick + note.t) / ppq` quarter notes, exact (ticks can be
     fractional; don't round).
   - Save the JSON snapshot beside the piece (e.g. `piece.mobdaw.json`) with the project id and
     `rev`; keep a map `part/onset/pitch -> note id`.
2. **Push**: diff the edited `Score` against the snapshot and emit ops:
   - new part -> `addTrack` (+ `addDevice`s copied from a named existing track) + `addMidiClip` +
     `addNotes`; edited note -> `updateNotes`; removed -> `removeNotes`, all keyed by note ids.
   - dry run by default (print the ops and a `melody`-style before/after); `--apply` sends them via
     `POST /api/agent/projects/:id/ops` as one batch with a short `label`.
   - refuse if the project's `rev` moved since the pull (someone else edited); offer to re-pull.
   - batch limits: 500 ops, 5000 notes.
3. **mobdaw API additions** (small, in `server/src/agentOps.ts`): `addTrack` with a device-copy
   option; a `get_state` filter (`tracks`, `fromBar`/`toBar`); maybe a catalog of preset names.
4. **Then** a `Part.loop`-style export for clips with `loopTicks`, drums (`view: "drums"`), and audio
   clips (read-only: show them as rests/markers, never write).

Keep badmidi a loader and exporter, not a style generator (see `AGENTS.md`; analysis stays
descriptive).

## Open questions

- Where does the token live? Suggest `MOBDAW_TOKEN` and `MOBDAW_URL` env vars, never written to the
  piece or the snapshot.
- Piece file as source of truth, or the project? Suggest: the project, with the piece as a scratch
  copy; every push is a labelled history entry so a person can revert from the History panel.
- Notes inside free regions: ticks are a nominal bijection (see the spec); decide how `free_bar`
  round-trips.

## Done when

`badmidi pull` of a project gives a piece whose `grid`, `lens`, `form` run on every real track, a
new part written against them can be pushed with `badmidi push`, and a second pull shows exactly
that change and nothing else.
