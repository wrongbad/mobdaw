# Listening: from a recorded take to an agent's bass track

Plan of record for teaching the badmidi bridge to hear audio. Read `BRIDGE-PLAN.md` (pull/push) and `docs/agent-api.md`
first. Status: phases 1-6 built (milestones 1-5; the bass patch needs a listening pass), milestone 6 (monophonic) built. The chat loop runs end to
end in `tests/e2e_audio_live.sh` against `examples/bass_for_take.py`, on a take of open-position guitar shapes (`tests/synth.py`: six
Karplus-Strong strings, strum, body, room). The chord hearing was hardened against such playing (single thirds are not power chords,
the key comes from the chord sequence, confidence compares rival roots and families, `HeardChord.alt_conf` and one `is_unsure()`),
and `tools/listen-eval.py` scores it against labelled takes. Everything above is measured on synthetic guitar only: **the next step is
real recordings** through `tools/listen-eval.py`, then refitting the constants in `hear.py` marked in `docs/todo.md`.

## The goal, as a user sees it

1. In mobdaw, record a real instrument (guitar, keys, a sung line) onto an audio track, to the click.
2. In chat: `@k(api) make a bass track for Guitar, bars 1-16`.
3. A minute later there is a new MIDI track "Bass" playing a part that fits, as one history entry ("bass for Guitar"),
   and a chat reply with the chords the agent heard, e.g. `Am | F | C | G (or Em?) | ...`. A wrong chord is
   corrected in chat ("bar 4 is G") and the agent redoes the part.

## Decisions

- **All analysis is offline, on the agent's machine.** The server stays a blob store: it hands out a signed URL and the
  bytes come straight from object storage. Nothing about listening costs server CPU, so it scales with the number of
  agents rather than the number of users. (The browser could run the same analysis later on the user's CPU; not v1.)
- **Python, in badmidi, as an optional extra.** `pip install badmidi[audio]` adds numpy, scipy (resampling, filters) and
  soundfile. The core stays dependency-free. An optional `badmidi[transcribe]` adds Spotify's Basic Pitch for real
  polyphonic note transcription; nothing depends on it.
- **Hearing produces ordinary badmidi parts.** What is heard becomes read-only parts in the pulled Score, so the existing
  tools (`grid` for chord symbols, `lens`, `check`) work on audio unchanged and the bass is checked against what was played.
  Heard parts are never pushed (unless asked for as a muted guide track).
- **Not tuner-perfect, and honest about it.** Every heard chord and note carries a confidence. Low confidence turns into
  an "A or B?" in the chat reply, not a silent guess.
- **v1 assumes the take was recorded to the project's click.** Bar lines then come from the project's time map and need no
  beat tracking. A take that drifts from the grid is detected and reported, not fixed (see "Later").

## What exists today

- Recording: takes are latency-compensated and placed on the timeline (`client/src/takes.ts`, `audio/wav.ts` `placeTake`,
  `docs/engine.md` §9), saved as 16-bit WAV, content-addressed by sha256, uploaded as project samples. While uploading, a
  take's sample has `status: 'incoming'` and exists only on the recorder's device.
- Sample bytes: `GET /api/projects/:id/samples/:hash/url` returns a signed download URL
  (`server/src/routes/samples.ts`). It sits behind the **session** middleware; API tokens (`mdw_...`) are only accepted on
  `/api/agent` (`routes/agent.ts`, `apiTokenUser`). So an agent cannot download a sample yet.
- Agent view: audio clips show `start`, `startSeconds`, `lengthSeconds`, `loopSeconds?`, `gain`, `sample` (name) and
  `sourceHash` (`shared/src/agentView.ts`). Missing: `sourceOffset` (where in the file a trimmed clip begins), the
  sample's duration, mime and `status`.
- badmidi: `pull` skips audio clips with a "left out" note (`bridge.py`). `Score.seconds(t)` maps score time to seconds
  (the inverse isn't there yet). `grid` labels every onset with chord symbol, roman numeral and set class. Instruments
  include `bass guitar` and `contrabass` with ranges.
- Instruments: `addTrack` accepts `finnwave`, `bore`, `lofi drum`, `none` or `like: <track>`. No bass patch exists.

## Phase 1: server and view gaps (small, TypeScript)

1. **Agent sample route.** `GET /api/agent/projects/:id/samples/:hash/url` with API-token auth and the same project
   access check as the other agent routes, same response as the session route (`{url}`; `409 sample_incoming` while
   the take is still on the recorder's device). Reuse the session route's query. Server test in `agent.test.ts`. Document
   in `docs/agent-api.md`.
2. **Agent view of audio clips.** Add `sourceOffsetSeconds` and a `samples` table at the top of the view
   (`{hash: {name, duration, mime, status?}}`), in the JSON and as one text line per clip. Update `agentView` tests.
3. **Event when a take lands.** `wait_for_events` emits `{type: 'sample', hash, status}` when a sample's status changes,
   so an agent asked about a take that is still uploading can wait for it instead of polling. (Optional; the bridge can also
   retry on 409 for a minute.)

## Phase 2: fetch, decode, place (`badmidi/audio/source.py`)

- `fetch(project, hash) -> path`: agent route -> signed URL -> download to `~/.cache/badmidi/samples/<hash>`. The hash
  is the content, so the cache never goes stale; verify sha256 after download.
- `decode(path) -> (mono float32, sr)`: soundfile (WAV/FLAC/OGG/MP3 in libsndfile >= 1.1); fall back to `ffmpeg` on
  PATH for other imported formats, with a clear error if neither works. Downmix to mono, resample to 22050 Hz
  (`scipy.signal.resample_poly`).
- `clip_audio(state, clip) -> (signal, onset)`: the stretch the timeline actually plays: `[sourceOffset, sourceOffset +
  length)`, repeated per `loopSeconds`, placed at the clip's `startSeconds`. Clips on one track are mixed into one
  track-length signal, so the analysis sees the track as heard.
- `Timeline.onset_at(seconds) -> Fraction`, the inverse of `Score.seconds`, through tempo ramps and free bars. Round-trip
  test against `seconds` on every region kind.

## Phase 3: hearing (`badmidi/audio/hear.py`, numpy + scipy)

All frame-based at 22050 Hz, ~10 ms hop. Every output is in score time (bars/beats as Fractions), via phase 2.

### 3a. Common front end
- **Tuning offset.** Histogram of strong spectral peaks against 12-TET cents; shift the filterbank by the median offset
  (a guitar tuned 20 cents flat, or a capo'd piano sample, still reads right). Reported.
- **Onsets.** Spectral flux with adaptive threshold; onset strength per 16th-note slot of each bar (the instrument's
  rhythm, which the bass will lock to).
- **Grid check.** Do onsets cluster on the project's beats? Report the mean offset and drift. Mean offset > 30 ms
  suggests latency compensation is off; drift means the take wasn't recorded to the click (v1 then refuses with a
  message pointing at `tempo from loop` or re-recording).

### 3b. Polyphonic: chords per beat (the default for guitar and keys)
- **Semitone filterbank:** this is the "note-aligned filters" idea. Log-frequency spectrum (STFT, 4096-point at 22 kHz,
  mapped to 3 bins per semitone A1-C7), tuning-shifted, log-compressed and whitened per frame.
- **Harmonic suppression:** for each semitone, subtract a decaying share of the energy at its 3rd and 5th harmonics
  (those are what read as a false fifth and major third). Crude, but it fixes the commonest error.
- **Chroma per beat** (fold to 12 pitch classes, average over each beat) plus a **bass chroma** from below ~250 Hz
  (gives inversions and the root the bass should favour).
- **Chord estimation:** cosine match of beat chroma against templates (maj, min, 7, maj7, m7, sus2, sus4, dim, power
  chord `5`, and "N" for silence), then Viterbi over beats with a change penalty that is lower on bar lines and strong
  beats. Output per span: `(start, end, symbol, root, confidence, runner-up)`.
- **Key:** Krumhansl-Schmuckler over the whole take; used to pick between near ties (a power chord is major or minor
  by key) and written to the Score's key if the project has none.

### 3c. Monophonic: notes (a sung or single-note line)
- **Pitch:** YIN/pYIN f0 with voicing probability, median-filtered.
- **Notes:** split on onsets and on pitch moves of more than ~70 cents held for more than 60 ms; each note's pitch is the
  median of its f0 (rounded after tuning shift), velocity from its RMS. Quantize to the grid (16ths by default, `--snap`)
  and keep the unquantized onset beside it for reporting.
- Chords for a melody come from 3b run on the line (works poorly) or from the agent reading the notes; the bass is then
  written against the melody with `lens` instead of a chord chart.

### 3d. Which one
Auto by voicing: if pYIN finds one clear f0 in most voiced frames, monophonic; else polyphonic. `--as chords|notes`
overrides. `badmidi[transcribe]` adds `--as transcribe` (Basic Pitch notes, then 3b-style chord spans from them).

## Phase 4: the bridge (`badmidi pull --listen`, `badmidi listen`)

- `badmidi listen <project> --track Guitar [--bars 1-16] [--as ...]`: prints the chart, one bar per line, with confidence
  and runner-up where it is low, the tuning offset, the key and the grid check. This is what the agent reads first;
  it's short enough for a model's context.

  ```
  Guitar (audio, 2 takes, 16 bars), heard as chords, tuning -12 c, key A minor, on the grid (+8 ms)
   1  Am .......... 0.91
   2  F ........... 0.84
   3  C ........... 0.88
   4  G 0.52 | Em 0.47      <- unsure
   rhythm: | x..x ..x. x..x ..x. | (onset strength per 16th, bar 1)
  ```
- `badmidi pull <project> --listen Guitar -o piece.py`: as today, plus the heard parts:
  `guitar (heard)` (block chords per chord span, voiced in the bass-chroma inversion) or the transcribed notes, and a
  `guitar (rhythm)` attribute with per-bar slot strengths. The snapshot marks them `heard`, so `push` skips them and
  refuses edits to them. `--guide` instead pushes them as a muted MIDI track so humans can see and fix what was heard.
- Analysis results cache beside the samples, keyed by (hash, analysis version, options), so a re-pull is instant.

## Phase 5: the bass

- **Draft generator** `badmidi.bass.line(chords, rhythm, style=...)`: a starting point the agent edits, not the
  finished part. Styles: `roots` (root on each change), `root-fifth`, `pulse` (8ths on the root, following the heard
  rhythm's accents), `walk` (quarters with chromatic/diatonic approach notes into each change). Uses the bass chroma for
  inversions, stays in `bass guitar` range (E1-G4, mostly below C3), prefers stepwise voice leading between changes. If the project
  has a drum track, bass onsets favour the kick's.
- **Checks:** `check` and `lens` against `guitar (heard)`: notes outside the heard chord on strong beats, parallel
  octaves with the heard bass chroma, range.
- **Sound:** a `bass` patch for finnwave (a short list of `setParam`s, chosen by ear and stored in badmidi as a named
  patch), sent by `push --patch bass` as `addTrack` + `setParam` ops in the same batch. If the project already has a
  bass-ish track, `--like` it instead. (A GM bass fit with `engine/crates/match` is a later improvement.)
- `badmidi push piece.py --apply --label "bass for Guitar"`: one history entry, revertable from chat.

## Phase 6: the agent loop (docs, no new code)

Add "Making a part for a recording" to `docs/agent-api.md` and `AGENTS.md`:

1. `wait_for_events`; a chat mention asks for a bass for a track.
2. If its sample is `incoming`, reply "waiting for the take to upload" and wait for the `sample` event.
3. `badmidi listen ...`; if the grid check fails, say so and stop. If bars are unsure, either ask in chat
   (`bar 4: G or Em?`) or pick the key-consistent one and say which in the reply.
4. `badmidi pull --listen ... -o piece.py`, draft with `bass.line`, edit by taste, `check`, `push --apply`.
5. `send_chat`: the chart it heard, what the bass does, "revert with: ...".

The agent runs wherever the user's Claude Code runs (laptop or a cloud session with mobdaw's host allowed), with
`MOBDAW_TOKEN` in the environment.

## Testing

- **Unit (fast, pure Python):** `onset_at`/`seconds` round trips; chord templates and Viterbi on hand-built chroma;
  YIN on synthetic sines and sawtooths with vibrato; clip windowing (offset, loops, two clips on a track).
- **Synthetic audio (fast):** badmidi already renders WAV. Render known progressions with harmonic-rich voices (saw
  pads, plucked strings, a sung-like formant tone), add noise and reverb, detune by 15 cents, and assert >= 90% of beats
  get the right chord root and >= 80% the right quality; monophonic lines -> notes within one 16th and the right pitch.
- **Real recordings (tool, not test):** `tools/listen-eval.py` (built) runs the hearing over a folder of short takes with hand-written
  chord charts (`*.chords.txt`, committed) and writes `docs/listen/runs/<date>-<label>/report.md` with per-take accuracy.
  The WAVs stay out of git (per CLAUDE.md); keep them backed up elsewhere. Start with: clean electric guitar strummed,
  distorted power chords, fingerpicked acoustic, piano comping, a sung melody.
- **End to end:** extend `tests/e2e_live.py`: upload a rendered progression as a project sample on the local server, place
  it as an audio clip, run `listen` + draft bass + `push --apply`, assert a bass track exists whose strong-beat notes sit
  in the known chords, and that one history entry was added.
- **Latency check (once, by hand):** record a click played into the mic (or a loopback cable) and confirm the grid check
  reads under ~10 ms. If not, it's a recording bug, filed in `docs/todo.md`.

## Milestones

| # | Deliverable | Size |
|---|---|---|
| 1 | Phase 1: agent sample route, view fields, docs, tests | ~half a day |
| 2 | Phase 2: fetch/decode/place, `onset_at` | ~half a day |
| 3 | Phase 3b + 3a: chords, key, tuning, grid check; `badmidi listen` text; synthetic tests | 1-2 days |
| 4 | Phase 4 + 5: heard parts in `pull`, bass draft generator, bass patch, `push --patch` | 1-2 days |
| 5 | Phase 6 + e2e: the chat loop end to end on a real recorded guitar | half a day |
| 6 | Phase 3c monophonic, then optional Basic Pitch | 1 day |

Milestone 5 is the demo: record guitar, ask in chat, get a bass track. Milestone 6 widens it to melodies.

## Risks

- **Distorted guitar** smears harmonics across everything; power chords carry no third. Mitigation: the `5` template plus
  key prior; report "power chord, read as minor from the key".
- **Recorded off the click.** v1 refuses. Beat tracking is a different, harder problem.
- **Latency compensation off by a few ms** shifts onsets; harmless for chords per beat, matters for locking the bass to
  the strum rhythm. The grid check exposes it.
- **Bleed and room noise** from a phone mic: whitening and the confidence gate; the reply says when confidence is low
  throughout.
- **Big takes:** a 5-minute stereo 48 kHz take is ~55 MB; download once, cache by hash. Analysis is well under real time.

## Later

Beat tracking for free-time takes (then `addRegion`s from the detected tempo), running the same analysis in the browser
(wasm, the user's CPU) for a "show chords" lane, GM bass via patch matching, drums from a recorded beat, and other parts
(pads, counter-melodies) through the same heard-parts path.
