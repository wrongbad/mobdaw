# The badmidi <-> mobdaw bridge: history and status

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

## Status: built

Each friction point above now has an answer; `tests/e2e_live.py` drives all of it against a local server.

1. **Reading is lossy** -> `badmidi pull <project> -o piece.py` (`badmidi/bridge.py`): a script, no model in the loop,
   reads `state?format=json` into a Score with every real track, the region map (meter, tempo, rit./accel., free bars),
   markers as sections and the key. `grid`, `lens` and `form` now see the whole ensemble. A snapshot
   `piece.mobdaw.json` (project id, `rev`, note ids per track) sits beside the piece; the token is never written
   (env `MOBDAW_TOKEN`, `MOBDAW_URL`).
2. **Writing is manual** -> `badmidi push piece.py` diffs the piece against the snapshot (a note is its track, onset
   and pitch) and sends one batch: `addNotes` / `removeNotes` / `updateNotes`, and a new part becomes `addTrack` +
   `addMidiClip` + `addNotes`. Dry run by default, `--apply` sends it as ONE labelled history entry. It refuses when the
   project's `rev` moved since the pull, when the piece's bar map differs from the project's, and for edits inside
   looped clips. After a push the snapshot is refreshed, so the next push diffs against what the project is now.
3. **Wrong meter** -> `pull` reports when the project sits on the default 4/4 but its clips fit another meter, with the
   `setRegion` to fix it. (The v3 -> v4 migration itself is unchanged.) `setRegion` on a project whose timeline was
   never edited used to do nothing and say nothing; it now writes the region out.
4. **Preset discovery** -> `addTrack {like: "<track name or id>"}` copies the whole device chain (params, key ranges,
   fader/pan, colour); `badmidi push --like <track>`. `preset` is documented as a device type, not a display name.
5. **No selective read** -> `get_state` / `GET .../state` take `tracks`, `fromBar`, `toBar`; `badmidi pull --tracks
   --bars` pulls a slice and then push only touches that slice (a note outside it is an error, not a deletion).
6. **Batch limits** were raised (5000 ops, 100000 notes, 32 MB body) so a whole piece is one history entry.
   Session mechanics are unchanged (restart after `claude mcp add`); scripts read the token from the environment.

## Dynamics, drums and loops
- **Velocity <-> dynamics.** `pull` infers `dyn` marks from stored velocities; the snapshot keeps each note's project velocity (`vel`) and
  the velocity the pulled piece performs (`pv`). `push` sends `v` only for notes whose performed velocity differs from `pv` and for
  new notes, so untouched notes keep their human velocities. After a push the baseline is rebuilt from the piece that was pushed.
- **Drums.** badmidi has a `drums` instrument (MIDI channel 10, not in grid/lens/form by default). A drum track is a part with the
  keys named in the pull report; new drum parts are pushed as drum-view clips and need `--like`.
- **Loops.** A looped clip is a `Loop` in the piece: its pattern once, `times` passes. Pull places the later passes so the views
  hear them (ghosts: no project note) and registers the Loop; `Part` refuses notes over a loop's span, so the first pass says
  everything. Push never compares passes: it diffs pass 1 against the project's stored notes and reconciles each clip's loop
  (`updateClip` loop/length when `times` or the body changed, loop 0 when the Loop is gone, a Loop at a plain clip's start loops it).

## Not done
- Hairpins, articulations (except a drum accent) and ghost-note velocities are not inferred; per-hit drum velocity variation
  survives in the project but is flattened to level + accent in the piece.
- Audio clips are left out of a pull (reported). `forever` and partial-pass loops are read-only (badmidi's Loop is whole passes).
- A track's clip boundaries are not editable from a piece: new notes outside every clip get a new clip.
- Free regions round-trip through the nominal-tick bijection (`free_bar` of seconds at the previous tempo).
- The migration's meter guess is only reported, not fixed; mobdaw's UI could offer the same suggestion.
