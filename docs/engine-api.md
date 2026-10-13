# Engine API contract (milestone 2 + slices of 4 and 6, plus meters and the cycle)

This is the exact interface between `engine.wasm` (Rust) and the TS host and bridge.
Both sides implement against this file. Any change to it must be made here first.

## Conventions
- All functions are `#[no_mangle] pub extern "C"` and take `e: *mut Engine` first.
  The one exception is `engine_new`.
- **Handles** are `u32` values chosen by the bridge. They are unique per entity kind
  (tracks, clips, notes, devices, sources) and are never reused within a session.
  - The engine stores entities keyed by handle.
  - An unknown handle in update or remove calls is a silent no-op.
  - Children whose parent handle is unknown are stored, but don't render until the parent
    exists. This makes ordering of commands irrelevant.
- **Sample positions** are passed as `f64` and are always integral. JS numbers are exact
  up to 2^53. Rust converts with `as i64`.
- Booleans are passed as `u32` (0 or 1).
- The engine's sample rate is fixed at `engine_new` and equals the project's
  `meta.sampleRate`. The host creates the `AudioContext` at that rate.
- `engine_process` must never allocate. Structural calls (upsert/remove) may allocate.
  Preallocate generously: 256 tracks, 4096 clips, 65536 notes, 1024 devices,
  64 synth voices per synth device (see engine.md §6.3).

## Lifecycle and transport
```
engine_new(sample_rate: f32) -> *mut Engine
engine_free(e)
engine_out_ptr(e) -> *mut f32          // planar stereo: 128 L then 128 R (unchanged from M1)
engine_process(e, frames: u32)          // frames ≤ 128
engine_play(e, from_pos: f64)           // start transport at sample position
engine_stop(e)                          // stop; voices release; position stays
engine_seek(e, pos: f64)                // works while playing or stopped
engine_position(e) -> f64               // current transport sample position
engine_is_playing(e) -> u32
engine_set_loop(e, start: f64, end: f64, on: u32)   // transport cycle; on = 0 turns it off
```
- **Cycle (`engine_set_loop`).** While playing with `on` = 1 and `end > start`, when the position reaches `end` the
  transport continues from `start` on exactly that sample: `engine_process` renders the block in pieces, up to `end` and
  then on from `start` (as often as the block crosses `end`, so a cycle shorter than a block works). The position never
  reads `end` or beyond while the cycle runs. Only *reaching* `end` wraps: a playhead already at or past `end` when the
  cycle is set (or after a play or seek there) plays on. `end <= start` is off.
- **The wrap is a seek for stateless content.** Clips, automation, LFO lanes, pads (loopers restart, as at any jump) and
  MIDI notes (those at `start` fire on its first sample) render as if playback had started at `start`. Sounding clip
  notes are released at the wrap (their scheduled note-offs lie in the old timeline); held live keys (`engine_note_live`)
  and drum tails keep sounding, and effect tails ring on across it.
- Recording a take with the cycle on is not supported: the bridge sends the cycle off while a take records and back
  when it ends, and the worklet holds it off while capture is armed (see `record` below).
- The M1 test-voice functions (`engine_set_param`) may stay for `#/engine-test`.
- The test voice is only mixed in while its gate is on.

## Meters
```
engine_meters_read(e) -> u32        // fills the meter buffer, resets the peaks, returns the number of tracks
engine_meters_ptr(e) -> *const f32  // the meter buffer: 2 + 3 * tracks f32
```
- **What is measured:** the post-fader peak, `max |x|` (linear, 1.0 = full scale, may exceed 1) per channel since the last
  read: for each track its output after its device chain, gain, pan, mute and solo (exactly what it adds to the master
  sum), and for the master the final output (after the global fx chain). A muted, silenced or sleeping track reads 0.
- **Layout** after a read: `[master L, master R, h0, L0, R0, h1, L1, R1, ...]`, one triple per track in handle order.
  `h` is the track handle stored as the bits of a `u32` (read it through a `Uint32Array` view on the same address).
- Reading resets every peak to 0. `engine_process` never allocates for meters; the buffer is resized only by
  structural track calls, so re-read the pointer after each `engine_meters_read` (and re-wrap after `memory.grow`).
  The shared reader is `readMeters` in `client/src/audio/meters.ts`.
- Decay, peak hold and dB scaling are the UI's.

## Live notes
```
engine_note_live(e, track: u32, pitch: u32, velocity: f32, on: u32)  // on = 1 holds the key, 0 lets it go
```
A key played by hand (the piano roll's gate while a note is drawn or dragged). It goes to the track's sounding
instruments whose note range holds `pitch`, like a clip note, but is held until the matching off instead of for a
duration; it sounds with the transport stopped too. Applied between blocks (not sample-accurate). Only the
notes started live are released by an off; a transport stop or seek releases everything. Unknown tracks are ignored.

## Input monitoring
```
engine_input_ptr(e) -> *mut f32         // planar stereo: 128 L then 128 R, like the output
engine_monitor(e, track: u32, on: u32)  // play the input through that track; on = 0 stops
```
- The host writes the live input into the input buffer before each `engine_process`. The engine
  never reads it unless a track is monitored, and then it is mixed into that track's scratch
  like a clip: through the device chain in `order`, then gain/pan, mute and solo.
- Only one track is monitored at a time. Starting, stopping or moving fades over 10 ms (a move
  fades the old track out, then the new one in).
- It plays whether or not the transport runs. An unknown track is a silent no-op.

## Sources (decoded PCM, f32, at the project rate)
```
engine_source_alloc(e, h: u32, channels: u32, frames: f64) -> *mut f32
    // returns a pointer to a planar buffer: channel 0 frames, then channel 1 ...
engine_source_ready(e, h)       // host has finished writing; source becomes playable
engine_source_free(e, h)
```
- The host must re-read `memory.buffer` after `engine_source_alloc`, because memory may
  have grown.
- A mono source is played to both channels. A source with more than 2 channels uses its
  first two.
- A clip whose source isn't ready renders silence. Until milestone 3, the host only loads
  sources ≤ 200 MB.

### Live sources (a take being recorded)
```
engine_source_live_alloc(e, h: u32, channels: u32, reserve_frames: f64)
engine_source_live_reserve(e, h, frames: f64)              // room for this many frames in total
engine_source_live_append(e, h, frames: u32) -> u32        // from the input buffer; returns the frames taken
engine_source_live_written(e, h) -> f64                    // frames written so far
engine_source_live_finalize(e, h)
```
A live source is a source that grows while it is recorded. It is playable from `engine_source_live_alloc` on (no
`engine_source_ready`), and `engine_source_free` frees it like any other.
- **Silence past the written frames.** A read at source frame `f` returns silence when `f >= written` (and when `f < 0`),
  so an audio clip on a live source is silent until the recording reaches the frames it plays, then plays them. The
  output is a pure function of `(t, clip, written)`: the same clip over the same written audio always renders the same
  samples, and once everything is written it is bit-identical to a decoded source holding the same frames. The seam rule
  needs no special case: it reads only frames before the pass end, so a loop is complete as soon as its pass is written.
- **Chunked storage.** Frames live in fixed chunks of 32768 frames (`LIVE_CHUNK`), each holding all channels planar. Growing
  adds chunks and never moves audio that is already written, and a read is an index split, so a read, a loop pass or a seam
  crossing a chunk boundary is the same as anywhere else.
- **Only the first two channels are kept** (`channels` is clamped to 1..2; a mono source plays to both sides).
- **`engine_source_live_reserve` allocates; `engine_source_live_append` never does.** Chunks are allocated by `alloc` (for
  `reserve_frames`, rounded up to whole chunks) and `reserve`, which are structural calls: keep them ahead of the recording
  (the host reserves 30 s up front and tops up with every ~1 s chunk). An append takes only what fits in the allocated chunks
  and returns that count; the rest is dropped, and since later frames would no longer line up, the source then stays full
  until more room is reserved. `reserve` never shrinks and ignores unknown handles and decoded sources.
- **Append reads the input buffer** (`engine_input_ptr`, planar stereo, 128 frames per side): the host fills it as it does for
  monitoring, then calls `append` with `frames` <= 128. A one-channel source takes the left side only. The host's capture uses
  it, which is harmless to input monitoring: the engine reads the buffer only inside `engine_process`, where the monitor feed
  has refilled it.
- **`engine_source_live_finalize`**: no more appends (they return 0); chunks past the written frames are freed; what was
  written stays readable. Written is the total from then on.
- Appends and `written` take effect immediately, between renders. A block rendered after an append sees those frames.

## Tracks
```
engine_track_upsert(e, h, kind: u32 /*0 audio, 1 midi*/, gain: f32, pan: f32 /*-1..1*/,
                    muted: u32, soloed: u32, solo_safe: u32)
engine_track_remove(e, h)       // also stops rendering its clips/devices (bridge removes those too)
```
- **Gain:** linear. Changes are smoothed with a 10 ms linear ramp.
- **Pan:** equal-power, with −3 dB at center:
  - `L = cos((pan+1)·π/4)`
  - `R = sin((pan+1)·π/4)`
  - smoothed the same way as gain.
- **Solo:** if any track is soloed, non-soloed tracks are silent. Mute always wins.
  A `solo_safe` track (the metronome's click track) ignores other tracks' solo, so it stays audible;
  its own mute still applies.
- **Signal flow:** clips (audio) or instrument outputs (midi, summed) → effects in `order` →
  gain/pan → master sum → **global fx chain**.
- **Global fx:** a device upserted with `track = 0xFFFFFFFF` (`MASTER_TRACK`) sits on the master
  bus instead of a track. Those devices run in `order` over the summed mix, before the test voice.
  In the doc this is a device whose `trackId` is `'master'`.

## Soundscape tracks
```
engine_track_upsert(..., kind = 2, ...)          // kind 2 = soundscape track
engine_looper_upsert(e, h, track: u32, speed: f64, start: f64, length: f64)
engine_looper_mix(e, h, gain: f32, muted: u32)  // level 0..2 (ramped), mute flag
engine_looper_tape(e, h, drive: f32, cutoff_hz: f32, warble: f32)  // tape colour, all glide (see below)
engine_looper_head(e, h) -> f64                 // read head on the source tape (samples), -1 while not sounding
engine_looper_remove(e, h)
engine_pad_upsert(e, h, track: u32, start: f64, length: f64)
engine_pad_remove(e, h)
```
A soundscape track has two separate time worlds:
- **Source time.** The track's audio clips are *not* played linearly. They form a **source
  tape** (the sum of the clips with their gain, fades and offsets) read at arbitrary positions.
  Clip `start`s are positions on that tape, unrelated to the timeline. Each track has 4 loopers
  (slots); the engine doesn't care how many. A looper's `start`/`length` are its loop region **in
  source time**; `length < 64` means no region (silent). `speed` is clamped to 0.1..4 (NaN
  becomes 1).
- **Timeline.** A **pad** is a free-time gate block (integer samples, no grid) that switches
  *all* of a soundscape track's loopers on over `[start, start+length)` of the timeline. (Granular
  per-looper scheduling is meant to come later, via automation.) A looper is silent unless a pad
  of its track covers the current position. Pads may overlap: the latest-starting pad covering a
  sample wins, and a later pad retriggers the loops. Pads on unknown tracks are stored but inactive.

**Stateful playback, live speed.** Each looper has a read head with a *phase* (source samples into
its region) that advances by the current speed every output sample and wraps at the region length;
the output is the source tape at `region_start + phase`. A new `speed` takes effect immediately,
but the speed in use glides toward it with a one-pole filter in the log2 domain (time constant
150 ms), so changes are free of clicks and the read head never jumps. The loops **restart from the
region start** (phase 0, speed snapped to its target) when a pad opens or retriggers, and on any
jump of the timeline (play, seek). Reproducing exactly what was heard live when the transport is
restarted is deliberately out of scope for now; it is meant to come from recorded automation.
Each pad also fades the loops in and out over 5 ms at its edges.

**Interpolation.** wade's `variable_resampler` (5th-order analog Chebyshev-I low-pass, 2 dB ripple,
cutoff 1 rad per sample of the slower rate, Taylor-3 stepping), ported in `dsp::resampler`. The
filter state is only a cache: after any jump (trigger, region edit, loop wrap) it is rebuilt by
warming up over ~96 input samples (times `max(1, speed)`).

**Seam.** For the first 10 ms (output time) after each loop wrap the output is an equal-power
crossfade between the restarted loop and the audio continuing past the region end. (The first pass
after a trigger starts clean: there is no earlier pass to fade from.)

**Tape controls.** `drive` (0..1) is a tanh soft-clip with a little bias for even harmonics, level-
compensated; `cutoff_hz` (200..20000) is a low-pass, and 20000 is open; `warble` (0..1) adds wow
(~0.7 Hz), flutter (~7 Hz) and slow drift to the read speed, up to about ±30 cents at 1. Saturation
and filter run on the looper's output before its level; warble acts on the read head, so it moves
pitch and time together. Defaults (0, 20000, 0) are a bit-exact bypass.

Editing a looper's region while it plays keeps the phase (folded into the new length) and re-reads
from the new position; that is a jump, so expect a click. The 4 loopers are summed before the
track's device chain.

### Previews (private transports)
```
engine_preview_upsert(e, h, track: u32, mode: u32 /*0 source, 1 loops*/)
engine_preview_remove(e, h)
engine_preview_play(e, h, from_pos: f64)
engine_preview_stop(e, h)
engine_preview_seek(e, h, pos: f64)
engine_preview_position(e, h) -> f64
engine_preview_is_playing(e, h) -> u32
```
A preview is a transport of its own on a soundscape track, independent of the timeline transport
and of other previews, so a soundscape can be auditioned without touching the main playhead.
- **mode 0, source:** the track's source tape played straight through, 1:1, from the preview
  position (source time).
- **mode 1, loops:** every looper that has a region sounds continuously, no pads needed. Starting or
  seeking the preview triggers the loops from their region starts, like a pad.
- Both fade in over 5 ms at every (re)start or seek. The output goes into the track's scratch, so
  its device chain, gain, pan, mute and solo apply. Previews on unknown or non-soundscape tracks
  advance silently.
- Handles are per kind like the others. The worklet reports `{ type: 'preview', h, pos, playing }`
  (see below) for every preview that is playing.

## Audio clips
```
engine_clip_audio_upsert(e, h, track: u32, source: u32, start: f64, length: f64,
                         source_offset: f64, gain: f32,
                         fade_in: f64, fade_out: f64, fade_shape: u32 /*0 equal-power, 1 linear, 2 s-curve*/,
                         loop_length: f64, loop_phase: f64)
engine_clip_remove(e, h)        // any clip kind
```
- The clip plays source frames `[source_offset, source_offset+length)` at timeline
  `[start, start+length)`.
- **Fades are in samples.** For fade-in progress `t` in 0..1, the gains are:
  - equal-power: `sin(t·π/2)`
  - linear: `t`
  - s-curve: `0.5 − 0.5·cos(t·π)`
  - Fade-out uses the mirror image of each.
- **Declick:** every clip edge gets at least a 64-sample fade, using the same shape, unless
  the user's fade is longer.
- Overlapping clips on one track are summed.
- **Looping:** `loop_length` P > 0 makes the pass the source frames `[source_offset, source_offset+P)`,
  repeated to fill `length`. Timeline sample `t` (clip offset `k = t − start`) reads source frame
  `source_offset + ((k + loop_phase) mod P)`; `loop_phase` is in `[0, P)` and says where in the pass the clip's
  start falls. `loop_length` 0 is a plain clip (and ignores the phase). The host sends only `loop_length` < `length`
  as a loop, but the engine applies the phase whenever P > 0, so a split-off half that wraps once still sounds right.
  **Forever** clips are sent with a `length` of 24 hours of samples, like MIDI's.
- **Fades and declick apply at the clip's own edges only**, not at seams.
- **Seam rule:** the engine is stateless, so the seam is a pure function of `(t, clip, source)`, and it uses only
  audio from before the pass end (computable live while recording). At the end of every pass that another pass
  follows, with `X = min(10 ms, P/4, source_offset)` (the pre-roll the source has):
  - `X >= 64`: for pass position `p` in `[P−X, P)` the output crossfades equal-power from the tail
    `src[source_offset+p]` to `src[source_offset+p−P]`, the audio just before the pass start, which runs on into
    `src[source_offset]`.
  - `X < 64` (no pre-roll): the tail fades out over its last 64 samples and the repeat's head fades in over its
    first 64, at every seam (not at the clip start, which has its normal declick).
  - The last pass has no seam after it.

## MIDI clips and notes
```
engine_clip_midi_upsert(e, h, track: u32, start: f64, bpm: f64, ppq: u32, length_ticks: f64, loop_ticks: f64)
engine_note_upsert(e, h, clip: u32, tick: f64, dur_ticks: f64, pitch: u32, velocity: f32 /*0..1*/)
engine_note_remove(e, h)
```
- **Note timing:**
  - A tick maps to a sample as `start + round(tick · 60 · sr / (bpm · ppq))`, computed in
    f64.
  - Note-on and note-off are **sample-accurate**: sub-blocks split at event offsets.
  - Notes at or after `length_ticks` don't play. A note longer than the clip is cut off at
    the clip end.
- **Looping:** `loop_ticks > 0` (and shorter than `length_ticks`) makes the clip a repeating pattern.
  The notes in `[0, loop_ticks)` repeat every `loop_ticks` until `length_ticks`; notes at or after
  `loop_ticks` are ignored. Pass `k`'s note at `tick` plays at `tick_to_sample(k·loop_ticks + tick)`,
  so every repeat is sample-accurate and rounded once like any other event. A note longer than what
  is left of its pass is cut at the end of the pass (and still at the clip end). `loop_ticks` of 0,
  or at least `length_ticks`, is a plain clip.
- **Forever:** the engine has no separate flag. The host's `forever` clips (a looping clip that keeps
  repeating past its finite end) are sent with a `length_ticks` of 24 hours' worth of ticks at the
  clip's bpm. Passes are computed on the fly, so that costs nothing, and nothing in the engine stops
  at the end of the content, so a click keeps going under a take recorded past everything else.
- **Seek and stop** release every sounding voice. Starting playback in the middle of a note
  doesn't retrigger it (simple rule for now).
- MIDI events go to **every** sounding (not bypassed) instrument on the track whose note range (see
  `engine_device_keys`) holds the note's pitch. Ranges that overlap layer; ranges that don't make a split
  keyboard. Without a matching instrument the note is silent.
- The instruments of a track run in parallel and their outputs are summed; the track's effects then run in
  `order` over that sum (an effect ordered before an instrument still processes it).

## Devices
```
engine_device_upsert(e, h, track: u32, kind: u32, order: f64, bypass: u32)
engine_device_keys(e, h, lo: u32, hi: u32)                 // instrument note range, MIDI pitches, inclusive
engine_device_remove(e, h)
engine_param_set(e, device: u32, param: u32, value: f32)   // smoothed per engine.md §6.4
```
- Devices run in ascending `order` on their track.
- **Bypass:**
  - An effect passes audio through unchanged.
  - An instrument outputs silence.
- **Note range:** `engine_device_keys` sets the pitches (`lo..=hi`, clamped to 0..127, `hi` raised to `lo`)
  an instrument receives. The default is 0..127. It is a property of the device, not a param (never
  smoothed or automated), it is ignored by effects, and an unknown device is a silent no-op. Changing
  the kind of a handle keeps its range.
- **Changing kind** on an existing handle resets the device (but not its note range).
- Defaults apply until `param_set` is called.

### Automation
```
engine_lane_upsert(e, h, kind: u32, target: u32, param: u32, enabled: u32, min: f64, max: f64, scale: u32)
engine_lane_lfo(e, h, lfo: u32, shape: u32, rate_hz: f64, depth: f64, center: f64)
engine_lane_remove(e, h)
engine_point_upsert(e, h, lane: u32, pos: f64, value: f32, hold: u32)
engine_point_remove(e, h)
```
A lane drives one param from keyframes in *timeline* time (it follows the transport position, stopped or
not). `kind` 0 drives a device (`target` = its handle, `param` = its param id); `kind` 1 drives a looper
(`param`: 0 level, 1 speed, 2 saturation, 3 filter, 4 warble). Point `value`s are **normalised** (0..1);
`min`/`max`/`scale` (0 linear, 1 log, 2 cubic, as in `devices.ts`) map them to the param's own value, so the
interpolation is exactly the curve the editor draws. Before the first point and after the last a lane holds
that point's value; between two, the left one's curve decides (`hold` non-zero = a step). Points may arrive
before their lane and in any order. A disabled lane is kept but inert.
- **Devices** (tracks and the master chain): evaluated at both ends of every control segment (at most 32
  frames, split at breakpoints, so a corner is sample-exact). The param jumps to the value at the segment start
  and, if smoothed, ramps linearly to the value the lane reaches at its end (`set_param_auto`; a `hold` step
  stays a step at its breakpoint). Devices that interpolate per sample (the synth and drum gain) follow the
  ramp sample by sample; others take coefficients from the segment start. No extra glide.
- **Loopers:** once per block. The level ramps linearly to the lane's value at the block's end (mute still
  wins); speed, warble, saturation and filter take the value at the block's start and keep their own glides.
- **LFO mode** (`engine_lane_lfo`, `lfo` non-zero): the lane stops reading its points (they are kept) and reads
  `center ± depth · wave`, clamped to 0..1 and mapped through the lane's `min`/`max`/`scale` like a point's
  value. `center` and `depth` are normalised; `center` is the param's static value as a position on its slider,
  which the host re-sends whenever the knob moves. `shape` is 0 sine, 1 triangle, 2 soft square (`dsp::lfo`),
  all starting at zero going up. The phase is `position / sample_rate · rate_hz`, a pure function of the
  timeline position, so a seek, a loop or a bounce reads the same wave in the same place. There are no
  breakpoints, so a device lane is read at each control segment start (about 1.5 kHz at 48 kHz: fine for
  sweeps, not an audio-rate modulator). `lfo: 0` returns the lane to its points. Unknown lanes are ignored.
- A lane replaces the value, it doesn't remember it: when one is disabled or removed the host re-sends the
  param's static value (the bridge does).

### Device kinds and params
**kind 1: Simple filter** (effect). This is the wade SVF, `dsp::svf`.

| param | id | range | default | notes |
|---|---|---|---|---|
| mode | 0 | 0..7 (rounded) | 0 | 0 lowpass, 1 highpass, 2 bandpass, 3 notch, 4 peak, 5 bell, 6 low shelf, 7 high shelf. Not smoothed. |
| cutoff | 1 | 20..20000 Hz | 1000 | Smoothed in the log2 domain, and clamped below Nyquist·0.99. |
| damping | 2 | 0.05..2 | 0.7071 | Smoothed linearly. Q = 1/(2·damping). |
| gain | 3 | -24..24 dB | 0 | Bell and shelf modes only (ignored by the others); smoothed linearly. A bell reaches the full gain at the cutoff; a shelf reaches half of it there (in dB). |

- Stereo is two independent filter states.
- Coefficients are updated per 32-sample sub-block, with the smoothed params evaluated at
  the sub-block start. Per-sample coefficient updates are fine later.

**kind 8: EQ** (effect). Four bands (0 low shelf, 1 bell, 2 bell, 3 high shelf) using the filter's bell/shelf SVF mixes,
run in one fused per-sample loop (L and R interleaved).

| param | id | range | default | notes |
|---|---|---|---|---|
| freq | band·3 | 20..20000 Hz | 100 / 500 / 2000 / 8000 | Smoothed in the log2 domain, clamped below Nyquist·0.99. |
| gain | band·3+1 | -24..24 dB | 0 | Smoothed linearly. A band at exactly 0 dB (ramp at rest) is skipped and its state cleared. |
| damping | band·3+2 | 0.05..2 | 0.7071 | Smoothed linearly. Q = 1/(2·damping). |
| output | 12 | -24..24 dB | 0 | Smoothed (segment-start value); 0 dB is skipped. |

- All bands at 0 dB and output 0 dB is a bit-exact passthrough.

**kind 3: Reverb** (effect). A Freeverb-style stereo reverb, `dsp::reverb`: 8 damped combs into 4
allpasses per channel (right channel offset for width), summed from a mono input.

| param | id | range | default | notes |
|---|---|---|---|---|
| mix | 0 | 0..1 | 0.3 | dry/wet crossfade; 0 is a bit-exact passthrough of the dry signal. Smoothed. |
| size | 1 | 0..1 | 0.5 | comb feedback `0.70 + 0.28·size`, i.e. the decay time. Smoothed. |
| damping | 2 | 0..1 | 0.5 | low-pass in the feedback path: higher is darker. Smoothed. |
| predelay | 3 | 0..200 ms | 0 | delay before the tail starts. Not smoothed, so moving it while audio passes can click. |

- Bypass clears the tail. The tail keeps ringing after the input stops (the chain runs even when
  a track is silent), so put it on a track or on the global fx lane freely.

**kind 4: Compressor** (effect). A stereo-linked feed-forward compressor, `dsp::compressor`: peak detector
on the louder channel, 6 dB soft knee, one shared gain for both channels.

| param | id | range | default | notes |
|---|---|---|---|---|
| threshold | 0 | -60..0 dB | -18 | Smoothed. |
| ratio | 1 | 1..20 | 4 | Smoothed. 1 means no compression. |
| attack | 2 | 0.1..100 ms | 10 | Not smoothed. |
| release | 3 | 10..1000 ms | 100 | Not smoothed. |
| makeup | 4 | 0..24 dB | 0 | Smoothed. |

- Under the threshold with no makeup the gain is exactly 1. Bypass resets the envelope.

**kind 5: Tremolo** (effect). Amplitude modulation by an LFO, `dsp::tremolo`: `gain = 1 - depth·(0.5 - 0.5·lfo)`,
so the gain swings between `1 - depth` and 1 and the effect only takes level away.

| param | id | range | default | notes |
|---|---|---|---|---|
| rate | 0 | 0.1..20 Hz | 4 | Smoothed (in log2). |
| depth | 1 | 0..1 | 0.5 | Smoothed. 0 is a bit-exact passthrough. |
| shape | 2 | 0..2 | 0 | 0 sine, 1 triangle, 2 soft square (edges a few ms long, so no clicks). Not smoothed. |
| spread | 3 | 0..1 | 0 | Right channel's LFO lags the left's by `spread` half-cycles: 0 is a plain tremolo, 1 is an auto-pan. Smoothed. |

- The LFO is free-running (not synced to the transport) and starts at its zero crossing going up. Bypass resets the phase.

**kind 6: Tape delay** (effect). A stereo echo, `dsp::delay`: a delay line read by the looper's variable-rate
resampler, with an SVF and a soft saturator in the feedback loop.

| param | id | range | default | notes |
|---|---|---|---|---|
| mix | 0 | 0..1 | 0.3 | dry/wet crossfade; 0 is a bit-exact passthrough of the dry signal. Smoothed. |
| time | 1 | 10..2000 ms | 375 | The read head's distance behind the write head. Glides (see below), not smoothed by the device. |
| feedback | 2 | 0..1.2 | 0.4 | Gain of one trip round the loop. Above 1 the echoes build until the saturator holds them (self-oscillation). Smoothed. |
| warble | 3 | 0..1 | 0.25 | Tape wow and flutter, the looper's: about ±30 cents at 1. Glides. |
| drive | 4 | 0..1 | 0 | Soft saturation in the loop (the looper's curve). Small signals pass at unity gain, so the tail still decays at `feedback` per echo; loud echoes are squashed. Smoothed. |
| filter | 5 | 0..2 (rounded) | 0 | The loop's SVF: 0 low-pass, 1 high-pass, 2 band-pass. Not smoothed. |
| cutoff | 6 | 100..20000 Hz | 4000 | Smoothed in the log2 domain. |
| resonance | 7 | 0..1 | 0 | 0 is Butterworth, 1 rings. Smoothed. |

- The wet signal is taken after the SVF, so the first echo has been filtered once, the second twice, and so
  on; saturation starts with the second echo. The resampler's own low-pass (about 0.16 of the sample rate) darkens
  every pass too.
- Changing `time` moves the read head rather than jumping it, so the echoes bend in pitch (up when the time
  shortens, down when it lengthens). The glide has a 0.2 s time constant and a speed cap of ±0.5, so the head never
  stops or reverses. Automated values glide too.
- Each channel has its own tape (dual mono). Bypass wipes the tape and the loop.

**kind 2: Finnwave synth** (instrument). The voice is `dsp::finnwave` → amp ADSR.

| param | id | range | default | notes |
|---|---|---|---|---|
| rolloff | 0 | 0.001..3 | 0.3 | base `b` |
| env→rolloff | 1 | 0..3 | 0.5 | `b_voice = rolloff + amount·(1−env)`, so the sound darkens as it decays |
| attack | 2 | 0..5000 ms | 5 | |
| decay | 3 | 0..5000 ms | 300 | |
| sustain | 4 | 0..1 | 0.6 | |
| release | 5 | 0..10000 ms | 200 | |
| gain | 6 | 0..2 | 0.5 | |

- **Voices:**
  - 64-voice polyphony.
  - Stealing takes the oldest voice, with a 64-sample fade-out to avoid clicks.
  - Frequency is `440·2^((pitch−69)/12)`, and velocity scales amplitude linearly.
- **ADSR:** segments are linear in amplitude for now (attack linear, decay and release
  linear to target). Exponential segments come later.
- Output is mono, written to both channels.

**kind 7: Lofi drum** (instrument). `dsp::lofidrum`: white noise → SVF low-pass (`dsp::svf`) → exponential
decay envelope → gain. A one-shot.

| param | id | range | default | notes |
|---|---|---|---|---|
| cutoff | 0 | 20..20000 Hz | 2000 | Smoothed in the log2 domain. |
| resonance | 1 | 0..1 | 0.3 | Damping runs from Butterworth (0.7071) at 0 to 0.04 (Q 12.5) at 1, which rings: a pitched, woodblock-ish click. Smoothed. |
| decay | 2 | 1..2000 ms | 60 | The envelope falls 60 dB over this time. Read per control block. |
| gain | 3 | 0..2 | 0.5 | Smoothed. |

- Velocity scales amplitude linearly. Pitch and note length are ignored: a hit always rings out.
- **Monophonic.** A new hit restarts the envelope; the old tail keeps sounding for 64 samples, fading out
  linearly, so a retrigger never clicks. Seek and stop fade the tail the same way.
- **Deterministic.** The noise (xorshift) is seeded from the note's start position (its timeline
  sample), so the same hit at the same place renders the same samples on every client and in every bounce.
- Output is mono, written to both channels.

## Host messages (worklet port, main → processor)
`{ type: 'call', fn: string, args: number[] }`
- The processor calls `exports[fn](enginePtr, ...args)`.
- Calls are applied in order, before the next `engine_process`.

`{ type: 'source', h, channels: Float32Array[], frames }` (buffers transferred)
- The processor calls `engine_source_alloc`, copies the channels in, then calls
  `engine_source_ready`.

`{ type: 'monitor', h: number, on: boolean }`
- The processor calls `engine_monitor(enginePtr, h, on)`, and while `on` copies the node's input
  (channel 0 to both sides if it is mono, an unconnected input being silence) into the input
  buffer before each block.

`{ type: 'callAt', at: number, fn: string, args: number[] }`
- Like `call`, but applied by the engine at timeline sample `at`. The processor keeps these in a queue ordered by `at` (then by
  arrival), and before each render block runs every call due (`at <= engine position`). If the transport is playing and the next
  call lands inside the block, the block is cut there (`engine_process` with fewer frames), so the call takes effect on exactly
  sample `at`: the first sample rendered afterwards is timeline sample `at`. Cutting a block restarts the 32-frame control grid of
  the rest of the block (clips are per-sample and unaffected; smoothed params and automation read their values at a slightly
  different instant, inaudibly).
- **In the past**: if the position is already at or past `at` (including after a seek or a jump over it), the call is applied
  immediately, before the next render. Stateless clips then play from the right place. A call whose `at` is ahead while the
  transport is stopped waits (it does not run until the position reaches it, and a `play` or `seek` to `at` or beyond runs it).
- **Ordering with `call`**: an ordinary `call` is applied the moment the message arrives, always before any scheduled call
  that has not fallen due, whatever order they were posted in. Scheduled calls are ordered among themselves by `at`, ties by
  arrival. A scheduled call may itself be `engine_play`/`engine_seek`; the queue then re-reads the position.
- Allocation: the message handler allocates (the queue entry); the render path only reads the head of the queue.
- The queue logic is `client/src/audio/schedule.ts` (`CallQueue`), shared with the tests. `EngineHost.callAt(at, fn, args)`.

- **With the cycle on**, the processor also cuts a block at the cycle's end (it watches `engine_set_loop` calls), so
  after the wrap the queue sees the position at `start`: a call due early in the next pass runs on its exact sample.
  Positions are timeline samples, not passes: a call whose `at` lies behind the playhead runs at once (it does not wait
  for the next pass), and one beyond `end` waits until a seek or the cycle being turned off lets the position reach it.

`{ type: 'callAtClear' }`
- Drops the scheduled calls that have not run yet (`EngineHost.clearScheduled()`).

`{ type: 'record', on: boolean, channels?: number, live?: number }`
- Start or end capturing the node's input (docs/engine.md §9.2). With `live` (non-zero, a handle made by
  `engine_source_live_alloc`) each captured block is also appended to that source, in the same `process()` call that advances the
  engine, before the block is rendered. Capture, and the live writes, end at a transport jump or stop, as always. The live
  source is not finalized by the worklet (the bridge does that when the take is bound to its sample). `live` of 0 or absent
  is the old behaviour.
- While capture is armed (from `on: true` until `on: false`) the processor keeps the engine's cycle off, whatever
  `engine_set_loop` calls arrive meanwhile, and restores the last one afterwards.

## Processor → main
`{ type: 'pos', pos: number, frame: number, playing: boolean }`, sent about 30 times a second while
playing, once after stop or seek, and at every cycle wrap (with `pos` = the cycle start). `frame` is the context frame (`currentFrame` clock) at which the engine stood at
`pos`, so a time on the audio clock (e.g. `AudioContext.getOutputTimestamp()`) can be placed on the timeline.

`{ type: 'recstart', pos: number }`: capture began; `pos` is the timeline sample of the first captured frame (the live source's
frame 0). `{ type: 'rec', channels, frames, final }`: a ~1 s chunk of the take, transferred.

`{ type: 'meters', master: [l, r], tracks: number[] }`: the meters (`engine_meters_read`), `tracks` flat as
`[handle, l, r, ...]`, about 30 times a second whether or not the transport plays (live notes and monitoring sound
while stopped). When every peak is 0 one all-zero message is sent, then none until something sounds again.
`EngineHost.onmeters`; `Playback.onmeters` maps the handles to doc track ids:
`{ master: [l, r], tracks: Map<trackId, [l, r]> }`.

`{ type: 'preview', h: number, pos: number, playing: boolean }`: the same for each preview, about 30
times a second while it plays, and once after it is played, stopped or seeked.
