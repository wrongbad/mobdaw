# Engine API contract (milestone 2 + slices of 4 and 6)

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
```
- The M1 test-voice functions (`engine_set_param`) may stay for `#/engine-test`.
- The test voice is only mixed in while its gate is on.

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

## Tracks
```
engine_track_upsert(e, h, kind: u32 /*0 audio, 1 midi*/, gain: f32, pan: f32 /*-1..1*/,
                    muted: u32, soloed: u32)
engine_track_remove(e, h)       // also stops rendering its clips/devices (bridge removes those too)
```
- **Gain:** linear. Changes are smoothed with a 10 ms linear ramp.
- **Pan:** equal-power, with −3 dB at center:
  - `L = cos((pan+1)·π/4)`
  - `R = sin((pan+1)·π/4)`
  - smoothed the same way as gain.
- **Solo:** if any track is soloed, non-soloed tracks are silent. Mute always wins.
- **Signal flow:** clips (audio) or instrument output (midi) → device chain in `order` →
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
                         fade_in: f64, fade_out: f64, fade_shape: u32 /*0 equal-power, 1 linear, 2 s-curve*/)
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

## MIDI clips and notes
```
engine_clip_midi_upsert(e, h, track: u32, start: f64, bpm: f64, ppq: u32, length_ticks: f64)
engine_note_upsert(e, h, clip: u32, tick: f64, dur_ticks: f64, pitch: u32, velocity: f32 /*0..1*/)
engine_note_remove(e, h)
```
- **Note timing:**
  - A tick maps to a sample as `start + round(tick · 60 · sr / (bpm · ppq))`, computed in
    f64.
  - Note-on and note-off are **sample-accurate**: sub-blocks split at event offsets.
  - Notes at or after `length_ticks` don't play. A note longer than the clip is cut off at
    the clip end.
- **Seek and stop** release every sounding voice. Starting playback in the middle of a note
  doesn't retrigger it (simple rule for now).
- MIDI events go to the track's **instrument**: the first device in `order` whose type is
  an instrument. Without one, the clip is silent.

## Devices
```
engine_device_upsert(e, h, track: u32, kind: u32, order: f64, bypass: u32)
engine_device_remove(e, h)
engine_param_set(e, device: u32, param: u32, value: f32)   // smoothed per engine.md §6.4
```
- Devices run in ascending `order` on their track.
- **Bypass:**
  - An effect passes audio through unchanged.
  - An instrument outputs silence.
- **Changing kind** on an existing handle resets the device.
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
- **Devices** (tracks and the master chain): evaluated at the start of every control segment, and segments
  are split at breakpoints, so a corner is sample-exact. The value is applied at once (`set_param_auto`): no glide.
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
| mode | 0 | 0..4 (rounded) | 0 | 0 LP, 1 HP, 2 BP, 3 notch, 4 peak. Not smoothed. |
| cutoff | 1 | 20..20000 Hz | 1000 | Smoothed in the log2 domain, and clamped below Nyquist·0.99. |
| damping | 2 | 0.05..2 | 0.7071 | Smoothed linearly. |

- Stereo is two independent filter states.
- Coefficients are updated per 32-sample sub-block, with the smoothed params evaluated at
  the sub-block start. Per-sample coefficient updates are fine later.

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
| drive | 4 | 0..1 | 0.3 | Soft saturation in the loop (the looper's curve). Small signals pass at unity gain, so the tail still decays at `feedback` per echo; loud echoes are squashed. Smoothed. |
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

## Host messages (worklet port, main → processor)
`{ type: 'call', fn: string, args: number[] }`
- The processor calls `exports[fn](enginePtr, ...args)`.
- Calls are applied in order, before the next `engine_process`.

`{ type: 'source', h, channels: Float32Array[], frames }` (buffers transferred)
- The processor calls `engine_source_alloc`, copies the channels in, then calls
  `engine_source_ready`.

## Processor → main
`{ type: 'pos', pos: number, playing: boolean }`, sent about 30 times a second while
playing, and once after stop or seek.

`{ type: 'preview', h: number, pos: number, playing: boolean }`: the same for each preview, about 30
times a second while it plays, and once after it is played, stopped or seeked.
