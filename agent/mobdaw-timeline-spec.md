# Spec: one shared timeline (tempo, meter, free regions, markers)

For an agent working in `wrongbad/mobdaw`. Start from a fresh `origin/main` (a worktree or a
clean pull); the local checkout has uncommitted edits in `client/src/content/midifile.ts`,
`presets.ts`, `ui/timeline.ts` and `test/midifile.test.ts` that are not yours to touch.

## Why

Today there is no global grid (`docs/engine.md` §2): every MIDI clip carries its own `bpm`
and `ppq`, the UI snaps to clip edges, the selected clip's grid or a UI-only "guide BPM",
and the metronome is a 120 bpm 4/4 drum clip. That was a deliberate experiment in an
audio-first, free-form DAW, but it leaves tracks with no shared idea of where bar 17 is.

The next big feature is an AI collaborator that edits MIDI as a project member: it joins as
another user, talks in the project chat, and proposes note-level changes that humans review
as diffs. Its musical tooling (badmidi) thinks in bars and beats: "bars 33-34, alto". For the
agent, the chat and the diff review to agree on what a bar is, the project needs **one
timeline that every track agrees on**, made of song regions:

- **metered** regions: a tempo and a time signature, possibly ramping (rit./accel.);
- **free** regions: unmetered time with no bars or beats inside, for rubato takes, intros,
  cadenzas, ambient beds.

Audio stays the bread and butter. Audio clips keep their positions in samples: the grid is
something to snap to and count by, never a constraint on a take. This matches how most DAWs
treat audio without warping.

## Goals

1. A project-wide tempo/meter map, edited on the timeline, shared through the Yjs doc.
2. Section markers (label + description) on the same timeline.
3. MIDI clips in musical time: they follow tempo edits; per-clip `bpm` goes away.
4. Snapping, the ruler, the click track and loop-command quantizing follow the map.
5. A lossless migration of existing projects: every note sounds where it did before.
6. Pure, tested conversion functions in `shared/` (bars/beats ↔ ticks ↔ samples) that the
   client, the engine host and the future agent bridge all use.

## Non-goals (for this change)

- Audio following tempo edits (warp markers, stretching). `docs/engine.md` already defers
  warp markers; this model keeps room for them.
- Key changes. An optional single project key is in scope; a key map isn't.
- Anything about the agent, proposals or diff review. This spec only lays the timeline they
  need.
- Polytempo between tracks. If it's wanted later, it would come back as an explicit
  per-clip "own clock" option, not as the default.

## Data model (schema v4)

Two new flat maps, keyed by id like the rest of the doc (`shared/src/schema.ts` header).

### `regions`: the tempo/meter map

```ts
/**
 * A run of bars from `bar` (1-based) up to the next region's `bar`. Regions partition the
 * timeline: there is always one at bar 1, and no two share a bar.
 * metered: every bar is `num`/`den` (beats grouped by `groups` when given, e.g. [2,2,3] for 7/8),
 *          at `bpm` quarter notes per minute; with `rampTo`, the tempo moves linearly in
 *          musical time from `bpm` at the region's first beat to `rampTo` at the next region.
 * free:    exactly one bar, `length` samples long, with no beats inside. Its tempo for
 *          tick arithmetic is the previous region's (see "Ticks in free regions").
 */
export type Region =
  | { id: string; bar: number; kind: 'metered'; bpm: number; num: number; den: number; groups?: number[]; rampTo?: number }
  | { id: string; bar: number; kind: 'free'; length: number }
```

Why bars and not samples: the map has to be musical so MIDI follows tempo edits. Changing
an early region's `bpm` moves every later bar line (and the MIDI on them) in time, as in any
DAW. Audio clips don't move (they are in samples), which is what you want for takes until
warping exists. The UI should make that visible (see below).

A free region is one "bar" so bar numbers stay integers across the whole song and a free
passage has an address ("bar 20 is the free intro"). It maps one to one onto badmidi's
`free_bar`.

Bar 1 starts at sample 0. A song that starts later starts with a free region, or simply
with empty bars.

### `markers`: sections

```ts
/** A rehearsal mark / section start at a bar (beat 1). `label` is short ("A", "Verse 2"), `text` optional. */
export type Marker = { id: string; bar: number; label: string; text?: string }
```

### `meta`

- `schemaVersion: 4`
- `ppq: 960`: the project's tick resolution. Today it is per clip; it becomes one value.
- `key?: string`: optional, e.g. `"D minor"`. Display only; the agent uses it for spelling.

### MIDI clips

```ts
export type MidiClip = {
  id: string; trackId: string; kind: 'midi'
  startTick: number      // global musical position: ticks from bar 1 beat 1, at meta.ppq
  lengthTicks: number; loopTicks?: number; forever?: boolean; view?: 'drums'
}
```

`start` (samples), `bpm` and `ppq` go. Notes keep clip-local `tick`/`durTicks`, so a note's
global tick is `clip.startTick + note.tick`. Ticks can be fractional numbers (migration may
produce them); don't round them on write.

Audio clips, pads, loopers and automation points are unchanged: they stay in samples.
Snapping just offers bar/beat positions converted to samples.

## Conversions (`shared/src/timemap.ts`)

All pure, deterministic and covered by tests. Build a `TimeMap` once from the doc (cache
it, rebuild on `regions` changes):

```ts
const map = timeMap(regions, sampleRate, ppq)
map.tickToSample(t)          // f64 internally, rounded once per event
map.sampleToTick(s)
map.barStart(bar)            // in ticks; and barStartSample(bar)
map.position(tick)           // { bar, beat } (beat 1-based, fractional), the way badmidi prints "12:3"
map.regionAt(tick) / regionAtSample(s)
map.bars(fromSample, toSample)   // bar lines and beats in a window: what the ruler, snapping and the click draw
map.meterAt(bar)
```

- **Constant tempo:** linear, `samples = ticks * 60 * rate / (bpm * ppq)`, exactly as the
  engine does per clip today.
- **Ramps:** tempo linear in ticks over the region, so time is the integral
  `∫ 60 / (ppq * bpm(t)) dt`, which has a closed form (a log). Make the inverse closed-form too
  (an exp), with no iteration.
- **Ticks in free regions:** a free bar has no beats, but MIDI can still sit inside one, for
  example a rubato MIDI take. Give the free region a nominal tick length, computed from its
  `length` at the previous region's tempo (120 if it is first), so ticks and samples stay a
  bijection. The ruler shows seconds there, not beats.
- **Determinism:** the same doc gives the same sample for every event on every client and
  in export. No accumulation across events: each event is converted from its absolute tick.

## Engine and host

Today the host hands the engine clips with `bpm`/`ppq` and the engine maps ticks to
samples per clip (`docs/engine-api.md`). Pick one of these and document it in
`docs/engine.md` §2:

- **(a) the host bakes:** send the engine MIDI events already in samples, through
  `TimeMap`. That is simple and exact. Looping and `forever` clips under a changing tempo
  need the pattern unrolled per pass. Bound it by the transport window, as forever clips do
  today.
- **(b) the engine gets the map:** send the region list to the engine, which implements the
  same conversion in Rust. That gives one implementation per language, so you need a shared
  test vector file both sides check against.

Prefer (a) unless it costs real-time safety or makes forever loops awkward. Either way, a
tempo edit while playing must stay glitch-free for audio and land MIDI on the new grid from
the next block.

## UI

- **Ruler:** bars and beats in metered regions, seconds in free ones. Region changes are
  drawn at their bar ("♩=92 7/8", with a ramp drawn as a sloped line to the next one).
  Markers sit in a thin row above or below the ruler.
- **Editing:** a ruler menu at a bar offers "tempo / meter from here", "free region here",
  "ramp to next", "add marker", and deleting a region (it merges into the previous one).
  Bpm and meter edits are one undo step each and are collaborative like everything else.
  Show plainly that a tempo edit moves MIDI and not audio, for example by briefly ghosting
  audio clips that are now off the grid they were recorded against.
- **Snapping:** in metered regions, snap to bars, beats and subdivisions, for clips, notes,
  pads, automation points and loop regions. In free regions, keep today's behaviour (clip
  edges). The guide BPM goes; the map replaces it.
- **Piano roll and drum grid:** draw the grid from the map, so 7/8 bars look like 7/8 and
  grouped beats are accented.
- **Click track:** it follows the map: an accent on each bar's first beat and an emphasis on
  group starts (2+2+3), silent in free regions, and it ramps with tempo. Keep the click's own
  sounds (its drum devices). Its pattern becomes something generated from the map instead of
  a stored 4/4 clip. If you keep a user-editable click pattern, define it per meter, with
  generation as the fallback for meters it doesn't cover.
- **Loop commands:** in a metered region, a loop's start and stop snap to bar lines (one bar
  minimum), so loops agree with the grid. In a free region, keep today's cycle behaviour
  (the first loop sets the cycle). Optional and nice: "tempo from loop", which turns the
  first free loop's pass into a metered region where the pass is N bars at the nearest
  sensible bpm, so a loop-first session can grow a grid afterwards.
- **Export and MIDI import:** MIDI file import (`content/midifile.ts`) should write the
  file's tempo and time-signature events into regions (when the project has only the
  default map, or on request) and place clips in ticks. MIDI export writes the map back as
  tempo and time-signature meta events.

## Migration v3 → v4

Use the `migrateToV2` / `migrateToV3` pattern: idempotent, origin `'migrate'` (kept out of
undo), run on open. It must be **lossless in sound**: every MIDI note starts and ends on the
same sample before and after (±1 sample of rounding).

1. **Choose the map.** If there is a click track, use its clip: `bpm`, a meter of
   `loopTicks / ppq` quarters per bar written as n/4, and its `start`. A start other than 0
   becomes a leading free region of that length. Otherwise use the bpm of the longest-total
   MIDI material, defaulting to 120, in 4/4.
2. **Convert every MIDI clip.** `startTick = map.sampleToTick(clip.start)`. Rescale its notes'
   `tick`/`durTicks`, `lengthTicks` and `loopTicks` by
   `(mapBpm / clipBpm) * (meta.ppq / clip.ppq)`, so they span the same samples. A clip whose
   bpm differs from the map's comes out off-grid. That's correct (it sounds the same), and it
   goes into a migration note.
3. **Don't move audio, pads, loopers or automation.**
4. **Leave a trace.** Append one system chat message summarising anything non-trivial
   ("migrated to a shared timeline at 96 bpm 4/4; 2 MIDI clips had their own tempo and are
   now off the grid: 'bass' at bar 9, 'arp' at bar 33"). Use whatever the chat UI renders
   for a system author.
5. Old clients must not write v3 shapes into a v4 doc. Check what `schemaVersion` gating
   exists and keep the same discipline.

## Tests

- `timemap`: round trips tick→sample→tick at constant tempo, across meter changes, across
  ramps (closed form against a numeric integral), across free regions; `position()` labels;
  `bars()` windows that straddle regions; regions edited mid-song moving later bars.
- Migration: a v3 fixture with a click track, MIDI clips at other bpms, looping and forever
  clips, audio clips and automation. Assert every note's start and end sample is unchanged
  (±1) and that audio, pads and points are untouched.
- Engine: a scheduled MIDI clip plays its notes at `map.tickToSample` positions, including
  under a ramp and across a region boundary while looping.
- Click: accents at bar starts and group starts for 4/4, 6/8, 2+2+3/8; silence in a free
  region.
- Loop commands: in a metered region, a press quantizes to bar lines; in a free region,
  today's cycle behaviour.
- Collaboration: two clients editing different regions concurrently converge; deleting a
  region another client is editing doesn't corrupt the partition (a region at bar 1 always
  exists; duplicates at one bar resolve deterministically, for example by smallest id).

## Done when

- Every track, the ruler, snapping, the click and the loop commands agree on one bar grid.
- Tempo, meter, free regions, ramps and markers can be edited collaboratively and undone.
- Old projects open, migrate and sound identical.
- `docs/engine.md` §2 (time model), §3 (schema) and §10 (metronome), `docs/engine-api.md`
  and `docs/spec.md` describe the new model. `docs/todo.md` holds any foot-guns left behind.
- `npm test` passes, including the SLOW tests.

## How the agent bridge will use this (context, not work for now)

The badmidi side will read the doc into a badmidi `Score` like this:

- each region → `meter_change` / `free_bar` / `tempo_mark` / `rit`/`accel`;
- markers → `score.section(bar, label, text)`;
- `meta.key` → the score's key;
- each note → an exact position, `(clip.startTick + note.tick) / ppq` quarter notes, with
  its note id kept.

Agent proposals will then be note-level operations (add, delete, change one field) keyed by
note id. mobdaw renders them as a reviewable diff. Nothing in this spec needs to anticipate
that beyond stable note ids (already there) and the conversion functions above.
