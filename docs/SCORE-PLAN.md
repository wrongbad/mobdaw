# Score view: MIDI tracks as an ensemble score

Plan of record for a sheet-music mode that shows a chosen set of MIDI tracks as one score, and later lets you edit
it. Status: milestone 1 (view, end to end) built in `client/src/score/` and the `score` button in the top bar; notation hints (from MusicXML import) are drawn as written. Open questions settled 2026-10-21 (see the end).

## The goal, as a user sees it

1. In a project, switch the main area from **tracks** to **score** (a toggle in the top bar). Transport, chat and
   presence stay as they are.
2. The score shows every MIDI track with notes, drum tracks included (on a percussion staff) and the click track
   left out, as staves of one system, in track order, bracketed, with the project's meters, key, tempo and markers. Chips above the score pick
   which tracks are shown; the choice is yours only (it is not written to the project).
3. While playing, the current bar is highlighted and the view follows. A collaborator's edit in the piano roll shows
   up in the score at once.
4. Later: click a note to select it (the same selection as the piano roll), and change its pitch, length or position,
   delete it, or type new notes, as ordinary undoable edits.

## Decisions

- **Renderer: abcjs (MIT), behind an adapter.** A spike (below) rendered the same ensemble through abcjs 6.7,
  Verovio 6.3 and OpenSheetMusicDisplay 2.2 in Chromium. abcjs drew a correct bracketed ensemble (flute, violin,
  alto-clef viola, piano grand staff; 7/8; triplet; ties; two voices per staff) in about 8 ms per re-render, is
  ~150 KB gzipped and gives a click callback with the source character range of every element. That speed is what lets
  the score re-render on every Yjs update. Verovio engraves best (ids survive, MusicXML in) but is a 7 MB wasm module
  under LGPL-3.0, takes ~40-160 ms per page, and its ABC import collapsed our multi-staff `%%score` into one staff.
  OSMD looks good but was the slowest (80-450 ms) and is display-only. So: abcjs now; our own model emits to it through
  a narrow interface, so swapping in Verovio (fed MusicXML) stays a contained change if abcjs's engraving limits bite.
- **We own the interpretation, not the library.** The hard part is not drawing glyphs but turning a piano roll into
  notation (bars, quantized rhythms, voices, ties, spelling, clefs). That lives in our pure TypeScript, unit-tested,
  and renderer-independent. badmidi (`agent/badmidi/ingest.py`, `lilypond.py`, `musicxml.py`) already solves most of
  it in Python; port its rules (the per-beat 16th-vs-triplet quantizer, splitting into printable values, key estimate),
  don't reinvent them.
- **The doc stays the piano roll.** Notes keep their exact ticks. The score is a view computed from them. Every guess is
  recomputed on each render, so it is never stale. The one thing stored is an optional per-note *notation hint* (see
  "Notation hints"), which the score uses only while it is still true of the note.
- **Editing writes only what you touched.** A note edited in the score is written back at its notated (quantized)
  tick and length; its neighbours keep their performed timing. Notation that cannot be derived (a spelling, a voice, a
  staff, a clef, a tuplet) lives in the note hints, which editing will have to keep true.

## Layers

Each layer is a pure function of the one before, except the last two.

```
Y.Doc ──1 flatten──▶ Performance ──2 interpret──▶ Notation ──3 emit──▶ ABC + id map ──4 render──▶ SVG
                                                                                     ◀─5 edit (click → note ids → doc ops)
```

1. **Flatten** (`client/src/score/flatten.ts`). For the chosen tracks: every MIDI clip's notes in absolute ticks
   (`clip.startTick + note.tick`), loop repeats written out (`patternTicks`, `isLooping`; repeats carry
   `repeat: n` and are read-only), clipped to the clip's end. Overlapping same-pitch notes are cut at the later onset.
   Output per track: `{ id, tick, dur, pitch, velocity, noteId, repeat }[]`, plus the track's name, kind (drums by `trackKind.ts`; its drum devices,
   `isDrum`, give each key a name), the click track (`role: 'click'`) never offered, and the project's `TimeMap`, key (`getKey`) and markers.
2. **Interpret** (`client/src/score/interpret/`), the guesswork, each step its own small module with its own tests:
   - `measures.ts`: bars from the `TimeMap` spans: tick range, `num/den`, beat `groups` (2+2+3) for beaming, tempo and
     ramp (`accel.`/`rit.` text), markers as rehearsal marks. A free region becomes one unmetered bar of its nominal
     ticks (hidden time signature, notes placed proportionally, quantized coarsely).
   - `quantize.ts`: port of badmidi's `_Quantizer`: times already on a notated grid stay, the rest snap beat by beat
     to 16ths or eighth-triplets, whichever fits that beat better. Only onsets vote for a window's division (ends vote only in a window with no onset). A note's end is rounded *up*
     to the grid of the window it ends in (the finest plain division of that window and its neighbours, so a lone onset inside a 16th
     passage still writes 16ths), at least one step after the onset, never past the next onset in the voice; an end within an
     eighth of a quarter before the next onset goes to it (legato). A note performed at <= 0.6 of its written length, written as a
     quarter or shorter, gets a staccato dot (`STACCATO_RATIO`); a rest after a note the quantizer made is not staccato.
     Overlaps within a voice trim. Per-track override (`1/8`, `1/16`, `1/8t`, off) later.
   - `voices.ts`: notes with the same quantized onset and length become a chord; otherwise up to two voices per staff
     (the upper line stems up), extra overlaps go to the nearest voice and are trimmed. v1 may ship single-voice
     (chords + trim) if that is enough to be useful.
   - `staves.ts`: clef from the track's pitch range (treble, bass, treble_8/bass_8 for extremes); a wide part (e.g.
     piano, range over ~2.5 octaves with both hands busy) becomes a grand staff split at a moving point between the
     hands, starting from middle C.
   - `drums.ts`: a drum track is one five-line percussion staff (abcjs `clef=perc` and `%%percmap`). Each key gets a
     line or space and a notehead from its drum device's name (kick bottom space, snare third space, toms between,
     hats and cymbals above the staff with `x` heads; `addDrum` names them `kick`, `rim`, `snare`, `clap`, `tom`,
     `hat`, `open hat`, `perc`), unknown names in key order between them. Drum notes have no length on the page:
     each is written as the time to the next onset in its voice, capped at a beat; kick goes stems down in voice 2,
     the rest stems up in voice 1. No spelling, no key signature.
   - `spell.ts`: key from `meta.key`, else a Krumhansl-Schmuckler estimate over the shown tracks (port of
     `ingest.estimate_key`); each pitch spelled on the line of fifths nearest the key and its neighbours (a rising
     chromatic line sharps, falling flats). Accidentals per bar and per staff.
   - `rhythm.ts`: split every event into printable values at bar lines and beat-group boundaries, with ties (port of
     `lilypond._split`), fill gaps with rests, beam by beat groups.
   Output, the **notation model** (`model.ts`): parts → staves → voices → bars → events
   `{ kind: 'note'|'chord'|'rest', heads: {step, alter, octave, tie}[], value, dots, tuplet?, noteIds[], tick }`.
   Every printed head knows the doc note ids it came from (a tied chain shares one id), which is what selection,
   playback highlight and editing hang on.
3. **Emit** (`client/src/score/abc.ts`). Notation model → ABC string (`%%score` grouping with brackets and braces,
   `V:` per staff and voice, `M:`, `K:`, `Q:`, inline meter/key changes, `"^A"` for markers) plus a map from character
   ranges to note ids. Golden-string tests. A `musicxml.ts` emitter is the same walk with other output; it comes with
   "export MusicXML" (milestone 4) and is the route to Verovio if we ever switch.
4. **Render** (`client/src/score/view.tsx`). abcjs `renderAbc` into the score pane at the pane's width, re-run on doc
   changes (coalesced to one per animation frame) and on width or track-choice changes; scroll position kept by bar.
   Colours from the theme (abcjs draws with `currentColor`; selection and playhead are CSS classes we add). The playhead
   maps the transport's sample → tick (`TimeMap.sampleToTick`) → bar → that bar's SVG elements.
5. **Edit** (`client/src/score/edit.ts`, milestone 2). abcjs `clickListener` → character range → note ids → the shared
   selection (`createSelection().note`, so the piano roll and the score agree). Edits are translated back to doc ops
   through the inverse of layer 1 (absolute tick → clip-local tick; a loop repeat is not editable, the click selects the
   source note) and go through the existing undo manager and history labels (`noteOps.ts` has the pure edits).

## Notation hints

A note may carry `Note.hint` (`NoteHint` in `shared/src/schema.ts`; the doc comments there are the reference): how its writer notated it.
The score view draws a note exactly so when it can, and guesses (the layers above) when it can't.

- **The data.** `on` and `len`: the notated onset and length of the whole tied chain, as exact fractions of a quarter from the clip start
  (so a quintuplet sixteenth is `[1,5]`, not a rounded tick). `segs`: the written pieces of a tied chain. `tup`: `{ n, of, start, span }`,
  the tuplet group the note is in. `staff` and `voice` (1-based; `Track.clefs` gives one clef per staff, top first), `spell` (`'F#4'`) and
  `art` (`>` accent, `^` marcato, `'` staccato, `_` tenuto). `at: [tick, durTicks, pitch]` is the note as it was when the hint was written.
- **Freshness.** A hint is *fresh* when the note's current `tick`, `durTicks` and `pitch` equal `at`, exactly. Anything else (the note was
  moved, resized or transposed, the clip's left edge was trimmed, which shifts every `tick`) makes it stale, and a stale hint is ignored:
  it is never repaired and never trusted. Hints are for a clip's first pass only; loop repeats (`repeat > 0` in flatten) are always guessed.
  Moving a whole clip does not touch note ticks, so the hints stay fresh.
- **Hinted vs guessed, per (track, bar).** `hinted.ts` decides for each bar of each track: if every note sounding in the bar (by its
  notated span if it has a fresh hint, by its performed span if not; a repeat's notes count as unhinted) has a fresh hint, the whole track-bar
  is written from the hints; otherwise the whole track-bar is guessed, as without hints. The two are never mixed in one voice of one bar, so
  an edit makes only the bars it touches fall back to guessing. A bar is not "mostly hinted".
- **What a hinted bar does.** Onsets and lengths at clip start + `on` (a clip may start off the quarter grid; ticks are not rounded); staves and
  voices from the hints (`( V V )` in `%%score`, stems up for voice 1 and down for voice 2); `spell` as the head's spelling (accidentals follow
  ABC's per-bar state; a spelling that does not name the note's pitch is ignored); articulations before the note (`.`, `!>!`, `!marcato!`,
  `!tenuto!`); tuplets as `(n:of:k` over the pieces of the group, rests in the span at the group's ratio; `segs` written verbatim and tied
  unless one crosses a bar line (then the ordinary splitting rules apply); same-onset notes of a voice are a chord; gaps are rests (voice 1
  visible; a voice with nothing in the bar is an invisible whole-bar rest `x`, except voice 1).
- **Guessed bars of a track with `clefs`.** The track still has one staff per clef. Each note goes to the staff its fresh hint names, else
  middle C splits the top staff from the bottom one. A track without `clefs` keeps the clef and grand-staff logic of milestone 1.
  Drum tracks ignore hints.
- **Where hints come from.** MusicXML import (`client/src/content/musicxml.ts`) now; badmidi pushing hints with its notes, and score editing
  (which must write them with the notes it changes), later.

## Where the guesswork will show, and the escape hatches

| problem | v1 behaviour | later |
|---|---|---|
| performed timing (rubato, swing) | per-beat 16th/triplet snap | per-track grid override; swing detection writes straight 8ths + "Swing" |
| chord vs. voices | same onset+length → chord, else trim | two voices (guessed); from hints, as many voices as the hints name |
| spelling | key + line of fifths | `hint.spell` (done, for notes that carry hints) |
| piano split | moving split point | per-track staff setting |
| drums | percussion staff, position and head by drum name, two voices (feet down) | per-drum position override; a drum key legend |
| loops | written out, repeats read-only | repeat barlines when a clip loops whole bars |
| free bars, ramps | unmetered bar; `accel.` text | — |
| grace notes, very short notes | snap to one step | grace notes below a threshold |

Hints are optional fields, so old clients ignore them; see "Notation hints" above.

## Milestones

1. **View, end to end.** Score mode toggle, drum tracks on a percussion staff, track chips (local, per project, `localStorage`), flatten → measures →
   quantize → chords/trim → clef → spelling → rhythm → ABC → abcjs. Playhead bar highlight and follow. Unit tests for
   each interpret module and the emitter (vitest, plain data in, plain data out); one Playwright smoke test that a demo
   project renders with the right number of staves and bars. Done when the demo project and an imported MIDI file read
   as a plausible ensemble score.
2. **Select and edit.** Click to select (shared with the piano roll), delete, pitch up/down (diatonic by default,
   chromatic with a modifier), set length by written value (keys 1-7 like MuseScore), move by step, type a note by
   letter at a cursor. One history entry per gesture.
3. **Better guesses.** Two voices per staff, grand-staff split, beaming by groups, tuplets beyond triplets, per-track
   quantize override, swing.
4. **Export, polish.** MusicXML export (and print via the browser), repeat barlines. Re-evaluate abcjs vs. Verovio here with the real failures in hand.
   (The "stored notation hints" that were part of this milestone are built now, ahead of editing: see "Notation hints". Milestone 2's edits
   must keep the hints of the notes they touch true, or drop them.)

## Spike notes (2026-10-21)

Same content in each library, headless Chromium, 1000 px wide, warm re-render times:

| library | version | licence | size | chorale (4 voices, 2 staves) | ensemble (5 staves, 7/8) | 431 KB MusicXML organ piece |
|---|---|---|---|---|---|---|
| abcjs | 6.7.2 | MIT | 150 KB gz | 8 ms | 7 ms, correct | (no MusicXML input) |
| Verovio | 6.3.0 | LGPL-3.0 | 7 MB wasm | 39 ms (ABC) / 41 ms (MusicXML) | 26 ms, **voices collapsed to one staff** (ABC import) | 160 ms per page |
| OSMD | 2.2.1 | BSD-3 | 1.4 MB | 77 ms | — | 450 ms |

Watch with abcjs: render cost on long scores (measure on a 200-bar, 10-track project in milestone 1; if it is slow,
render only the systems in view or re-render only changed lines), and collisions between dense voices.

## Settled questions

- Score is a full-page mode, not a per-clip drawer.
- The track choice is per person, kept in this browser (`localStorage`, per project), not in the project.
- Editing a note in the score writes it at its notated tick and length; its neighbours keep their timing.
- Drum tracks are shown from milestone 1 (percussion staff); the click track is never shown.
