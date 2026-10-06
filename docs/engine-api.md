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
  gain/pan → master sum.

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
