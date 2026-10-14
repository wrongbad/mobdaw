# To do

Known risks, follow-ups and loose ends. Add to it when work leaves something unfinished, unverified or risky; remove items when they're done.

## Risks

- **MIDI editor gesture cancel uses `undo.undo()`.** When a second pointer cancels a note drag, the editor rolls back with `undo.undo()` and clears the redo stack (`client/src/ui/noteEditor.ts`, dc763a1). If the drag hasn't recorded its own undo step by then, this undoes the user's previous edit instead. Fix: snapshot the affected notes at drag start and restore them on cancel without touching the undo stack. Add a test.
- **Schema v3 vs older clients.** v3 moves `Track.gain`/`Track.pan` into the hidden mix device. A client running pre-v3 code that opens a migrated cloud project won't find those fields. Deploy server and client together; consider a version gate that refuses to edit newer docs.

## Unverified (needs a look in a real browser)

- Live gain-fader meter fill and its attack/release feel.
- Clip corners/borders against loop notches and fade handles.
- MIDI editor: keyboard, velocity lane, marquee, header strip, segmented grid switch, auto-zoom scroll timing, touch input.
- Pinch zoom in the MIDI editor (trackpad and two-finger touch).
- Fader trough centring in Firefox.

## Follow-ups

- MIDI editor keys and drum names overlay the first 18px of the clip. Proposal: render them in the track-header column of the editor row (scroll-synced vertically).
- Most presets have no paired fx chain (only 5 do in `PRESET_FX`, `client/src/content/presets.ts`).
- The applied-preset highlight (`Track.preset`) stays lit after the sound is edited.
- MIDI import/export (`client/src/content/midifile.ts`) isn't wired to any UI. Export always writes 4/4; import ignores tempo changes after the first.
- MIDI recording (fork 1c92e99) not ported; it needs re-wiring into the recorder.
- Transport cycle: `bridge.setCycle()` exists, but nothing calls it (no loop region in the doc).
- Live notes from a computer keyboard or MIDI input don't light the editor's keys (no live-input path into `noteLive`).
- Zoom isn't saved per project.
- `api.demos()` in `client/src/api.ts` is now unused on the client.
- Master pan uses a balance law (unity at centre) while tracks use equal-power (-3 dB at centre); confirm that's wanted.

## Parked fork features (waiting on a tempo design)

From `refs/fork/redesign`: bars/beats ruler and loop brace (66b411e), song markers (7ec6693), count-in, tap tempo.

## Fork features not yet decided

- Knob/fader/meter control library and `#/kit` page (1a684bd).
- Export dialog, project settings and panel restyle (d111c7c).
- PWA, offline and local snapshots (b77998d).
- `BASE_PATH` relative builds (64f1a2b).
