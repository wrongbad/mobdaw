# mobdaw audio engine: design

A serious DSP engine written in Rust and compiled to WebAssembly (wasm). It renders the
whole project live, on every client, from the shared Yjs document. Only source audio is
stored or transferred; effects, synths and automation are always rendered.

This doc records **decisions and their rationale**, so they can be challenged. Each one says
what we chose, why, and what we gave up.

---

## 1. Principles
- **The Yjs doc is the only source of truth.**
  - The engine never reads Yjs. A TypeScript **bridge** turns doc changes into engine
    commands.
  - Everyone renders the same doc, so everyone hears the same thing.
- **The root clock is integer samples at a fixed project sample rate.** Every global position
  is an integer sample index. There is no global tempo.
- **Rendering is deterministic.** The same doc and the same sources produce bit-identical
  output on any client. Wasm float arithmetic is deterministic as long as we avoid relaxed
  SIMD and never depend on NaN payloads. As a result, an offline bounce on any machine
  matches what everyone heard.
- **The real-time path is sacred.**
  - The audio thread never waits on I/O, never locks, and avoids allocation (see §6.3 for
    the one known compromise).
  - Anything expensive happens at import or in workers.

## 2. Time model
- **Project sample rate (`meta.sampleRate`):**
  - Chosen at project creation from 44100, 48000, 88200 or 96000. The default is 48000.
  - **Immutable.** Changing it would mean rescaling every position, which isn't worth
    supporting.
- **Global positions** are integer samples:
  - clip start and length
  - audio source offset
  - fades
  - automation point positions
  - Yjs stores them as JS numbers (exact up to 2^53 samples, which is about 5,900 years at
    48 kHz). Rust uses `i64`.
- **MIDI clips carry their own clock**: `bpm` (f64) and `ppq` (default 960).
  - Notes and clip length are in clip-local **ticks**.
  - At render time, a tick maps to a global sample as
    `clip.start + round(tick * 60 * sampleRate / (bpm * ppq))`. The mapping is computed in
    f64 and rounded once per event, so it's deterministic.
  - Changing `bpm` keeps the start fixed and moves the end. Polytempo comes for free.
  - A clip may **loop** (`loopTicks`): its first `loopTicks` repeat until `lengthTicks`. The extent stays
    in ticks, so changing `bpm` rescales it like any other MIDI clip.
- **Pass, extent and forever are shared by audio and MIDI clips.** The *extent* is the clip's finite length on the
  timeline (`length` / `lengthTicks`), the *pass* is the pattern that repeats (`loopLength` in samples / `loopTicks`),
  and a clip loops when its extent exceeds its pass. `forever` (only while looping) repeats the pass past the extent
  for as long as the transport runs; the host sends the engine a 24-hour length for it, and the extent stays the
  finite part for scroll bounds and export.
  - An audio pass is the source frames `[sourceOffset, sourceOffset + loopLength)`. `loopPhase` is where in the pass
    the clip's start falls, so timeline sample `t` reads pass position `((t - start) + loopPhase) mod loopLength`.
    That makes a split exact: the right half keeps `sourceOffset` and `loopLength` and takes
    `loopPhase = (loopPhase + cut) mod loopLength`.
  - Audio playback stays **stateless**: the output is a pure function of the timeline position, the clip and the
    source. The seam between passes is part of that function (see `docs/engine-api.md`, "Audio clips").
- **No global grid.** The UI snaps to:
  - clip edges
  - the selected MIDI clip's grid
  - an optional UI-only "guide BPM"
- **Tempo-synced effects** start in milliseconds only. Syncing to a clip's BPM is deferred.
- Deferred: **warp markers**, which would map clip time to sample positions so MIDI can
  follow a drifting live take. They fit this model later.

## 3. Shared document schema (v2)
Every map is **flat and keyed by id**. Children reference their parent by id, and ordering
uses fractional `order` numbers. As a result:
- concurrent inserts and edits merge cleanly
- moving something is a single field write
- the bridge can diff each map independently

| map | key → value (Y.Map unless noted) |
|---|---|
| `meta` | `schemaVersion: 2`, `sampleRate` |
| `tracks` | `{ id, name, kind: 'audio'\|'midi'\|'soundscape', order, gain, pan, muted, soloed, role?: 'click' }` |
| `clips` | Audio clips: `{ id, trackId, kind:'audio', start, length, sourceHash, sourceOffset, gain, fadeIn, fadeOut, fadeShape, loopLength?, loopPhase?, forever? }`. MIDI clips: `{ id, trackId, kind:'midi', start, bpm, ppq, lengthTicks, loopTicks?, forever?, view?: 'drums' }` |
| `notes` | `{ id, clipId, tick, durTicks, pitch, velocity }` |
| `devices` | `{ id, trackId, type, order, bypass, params: Y.Map<paramId, number>, keyLo?, keyHi? }`. `keyLo`/`keyHi` (MIDI 0..127, default 0 and 127) are an instrument's note range; they are not params. |
| `lanes` | Automation lanes, one per automated param: `{ id, enabled, order, scope, kind: 'synth'\|'effect'\|'looper', owner, param }`. `scope` is a track id, or `'master'` for the global fx chain; `owner` is the device or looper id; `param` is the device's param id (as a string) or the looper's field name (`gain`, `speed`, `sat`, `cutoff`, `warble`). The registry (`shared/src/params.ts`) resolves it to a range and scale. While `enabled` the lane *replaces* the param's value; the doc keeps the static value, and it comes back when the lane is disabled or deleted. |
| `points` | `{ id, laneId, pos (timeline samples), value (normalised 0..1 along the param's own scale), curve: 'linear'\|'hold' }`. `curve` shapes the segment *after* the point. |
| `samples` | Plain objects: `hash → { hash, name, duration, size, mime, status?: 'incoming'\|'missing', by?, peaks? }` (`by` is the recorder's username; `peaks` a base64 waveform). No `status` means the audio is in storage and anyone in the project can load it. See §9 for `incoming` and `missing`. |

- **Track kinds:**
  - An `audio` track sums its audio clips into its device chain.
  - A `midi` track feeds its MIDI clips to every instrument in the chain whose note range holds the
    pitch; the instruments are summed and the effects run on the sum.
  - Separate kinds keep the engine and UI simple. Mixed tracks may come later.
- **Cascading deletes:** deleting a parent deletes its children in the same `transact`.
- **Concurrent orphans** (for example, A adds a note while B deletes its clip) are
  **ignored by the bridge** and swept opportunistically by the next editor transaction.
- **Live parameter drags:**
  - The local engine applies each value immediately, every frame.
  - Collaborators receive the in-progress value through **awareness** as
    `{ dragging: { deviceId, paramId, value } }`. Their engines apply it as a transient
    override.
  - **Only the final value is committed to the doc**, as one write and one undo step.
  - If a user disconnects mid-drag, the override expires and the last committed value
    stands.
- **v1 → v2 migration** (seconds → samples) happens in the bridge at load time:
  - It applies once, when `meta.schemaVersion` is absent.
  - It sets `sampleRate = 48000`, rounds the positions, and gives tracks `kind: 'audio'`.

## 4. Threads and data flow
```
 main thread                      AudioWorklet thread               stream worker
 ───────────                      ───────────────────               ─────────────
 Yjs doc ─▶ bridge ──commands──▶  engine.wasm  ◀──PCM chunks──────  OPFS reads (sync handle)
   ▲          │      (port)        process(128)    (transferable)        ▲
   │          ▼                        │                                 │ download once
 UI / awareness ◀──meters/pos──────────┘                            S3 ─────┘
                                                                     import worker
                                                                     ─────────────
                                                             file ─▶ import.wasm (decode,
                                                                     resample, peaks) ─▶ OPFS ─▶ S3
```
- **Messaging uses `postMessage` first, with no SharedArrayBuffer (SAB).**
  - SAB requires cross-origin isolation (COOP/COEP headers). Those risk breaking Google
    Sign-In popups and S3 fetches.
  - Commands are small and infrequent. Streaming chunks are about 1 s, transferred
    zero-copy.
  - Ring buffers in SAB are a later optimization. The protocol is designed so swapping
    transports doesn't change the engine.
- **Streaming:**
  - For every clip that overlaps the next `READ_AHEAD` (2 s) window, the engine reports a
    *demand*: source, frame range.
  - The stream worker answers with f32 chunks, which the engine keeps in a per-source chunk
    cache with a fixed budget and LRU eviction.
  - A chunk that's missing when needed renders silence and raises an underrun counter. The
    engine never blocks.
  - Seeks prefetch the window around the new playhead before starting transport. If the
    data isn't ready after 150 ms, playback starts anyway.

## 5. Import pipeline (worker + `import.wasm`)
1. **Probe** the file with **Symphonia**, a pure-Rust streaming decoder (WAV, FLAC, MP3, AAC,
   Ogg, AIFF).
2. **Fast path:** the file is PCM WAV (16-bit, 24-bit or f32) already at the project rate.
   - **Store the original bytes untouched (bit-exact).**
   - The stream worker converts to f32 when reading.
3. **Everything else:** decode, then resample (if needed), then write a **32-bit float WAV**
   at the project rate.
   - Why f32: no re-quantization, which means no dither decision, and it's the engine's
     native format.
   - Cost: about 33% more storage than 24-bit, which is negligible on S3.
   - Compressed formats get decoded to f32 too. That's a deliberate trade of storage for
     zero decode cost at playback.
4. **Resampling with [rubato](https://github.com/HEnquist/rubato)**, in f64, using the
   **synchronous FFT resampler**:
   - Every project/source rate pair is a ratio of small integers (for example
     48000/44100 = 160/147). A synchronous resampler is exact for these and much faster than
     an asynchronous sinc resampler.
   - The anti-aliasing filter is rubato's windowed-sinc design.
   - Validation: native `cargo test` with sweep and multitone input, asserting passband
     ripple, stopband rejection and THD+N thresholds. This is where the DSP gets argued.
   - The resampler sits behind a `Resampler` trait, so it can be swapped.
   - The resampler's delay is compensated at import, so output frame 0 is aligned with input
     time 0. **No runtime latency compensation is needed anywhere for sources.**
5. **Hash** the stored bytes with SHA-256 while streaming, upload them to S3 (existing flow),
   and move the OPFS file to `sources/<hash>`.
6. **Peaks:** compute multi-resolution min/max pyramids in the same pass, then write them to
   OPFS as `peaks/<hash>`.
   - The base level is 256 frames per bin, and each level up is ×4.
   - Peaks are computed locally by every client on first fetch, and are not uploaded. They
     are cheap and can always be derived.
7. **Metadata** goes into the doc's `samples` map: frames, channels, format, size.

**OPFS replaces the Cache API** for sources. Its synchronous access handles in workers give
fast random reads into multi-GB files. Downloads from S3 are streamed into OPFS.

## 6. Engine internals (`engine.wasm`, runs in the AudioWorklet)
### 6.1 Hosting
- The main thread compiles a `WebAssembly.Module` and passes it to the worklet in
  `processorOptions`. The worklet instantiates it synchronously.
- **No wasm-bindgen.** The worklet scope lacks `TextDecoder` and other APIs that the glue
  code expects in some browsers.
  - The engine exposes plain `extern "C"` functions.
  - JS reads I/O through `Float32Array` views over wasm memory, recreated after
    `memory.grow`.
  - The same raw-exports style is used for `import.wasm`, so the toolchain is only `cargo`
    plus the `wasm32-unknown-unknown` target, with no `wasm-bindgen-cli`.
- **Build:** `cargo build --release --target wasm32-unknown-unknown`, with `+simd128`
  enabled. Vite imports the `.wasm` files as URLs.

### 6.2 Processing model
- The block size is 128 frames, which is the Web Audio render quantum.
- Within a block, **control is evaluated at 32-frame sub-blocks** (1.5 kHz control rate at
  48 kHz), with per-sample linear ramps inside each sub-block.
  - Instruments run in sub-blocks split at note events. Effects run over the whole 128-frame block, split
    only at the breakpoints of lanes that drive them (and into 32-frame pieces when they have lanes or a
    knob glide is in progress, since devices read their smoothed values once per run). Track
    gain/pan ramps linearly across the block.
  - Automation lanes evaluate at both ends of a sub-block and ramp across it.
  - This gives sample-accurate automation breakpoints within 32 frames, at a fraction of the
    cost of per-sample evaluation.
  - Note events are **sample-accurate**: sub-blocks split at event offsets.
- **Sleep:** an effect that provably outputs zero (silent input, and its state is zero or its tail has fallen
  below -120 dB) is skipped, and so is a track whose input is silent, whose instruments are idle and whose
  effects all sleep. Its gain ramps still advance. See [`dsp.md`](dsp.md) §9.
- **Precision:**
  - Audio buffers are f32.
  - Positions, phase accumulators and time math are f64 or i64.
  - Long accumulators such as oscillator phase wrap in f64 so they don't drift over
    hour-long renders.
- **Denormals:** wasm has **no FTZ/DAZ control**, so subnormals are always enabled and can
  be slow. Recursive state (filters, compressor, DC blockers, reverb and delay buffers) is flushed
  with `flush_denormal` (`if x.abs() < 1e-20 { 0.0 }`): once per block for filter and detector states
  (every 16 samples inside the per-sample `Svf::process`), and on write for values stored in delay lines.
- **Summing** happens in f32. The master bus has no limiter by default.
- **Meters:** post-fader peaks (linear `max |x|` per channel) for every track and the master, accumulated in the
  render loop and read (and reset) by the worklet about 30 times a second (`engine_meters_read`, docs/engine-api.md).
  - Where: a track's peak is taken in its gain/pan loop, on the very values it adds to the master sum, so it costs no
    extra pass; the master's after the global fx chain. A sleeping track does no work and reads 0.
  - How: the max runs over the bits of `|x|` as `u32` (non-negative floats order like their bit patterns), because an
    integer max reduction vectorizes in wasm and a float one does not without fast-math (dsp.md §2). Measured in wasm:
    about 0.4 ns per stereo frame per sounding track (0.002 % of a core at 48 kHz), nothing for sleeping ones.
  - Peaks only, no RMS: the UI does decay and hold. RMS would need a per-sample square and sum per track.
  - The worklet stops posting while everything reads 0 (one all-zero message first), so a silent project costs one
    wasm call per ~1600 frames.
- **Transport cycle** (`engine_set_loop`, the doc's `meta.loop`): the engine wraps from `end` to `start` inside
  `engine_process`, splitting the block at the exact sample, rather than the host seeking between blocks.
  - Why in the engine: the host can only act between blocks, so a host-side seek would land up to 127 samples late
    and jitter every pass. An offline bounce of a cycle, and the tests, get the same wrap for free.
  - The wrap is a seek for the stateless parts (clips, lanes, pads), and releases clip notes, whose note-offs are
    scheduled in absolute timeline samples and would never come after the clock jumps back. Live keys and effect tails
    carry on: a reverb rings across the wrap as it would across a seek, so a pass is not bit-identical to the first one
    while tails from the previous pass are still sounding.
  - The worklet cuts its blocks at the cycle end as well, so scheduled calls (`callAt`) and the position report see the
    wrap; the bridge's clock wraps its extrapolated position the same way, so the playhead wraps without waiting for a
    report.
  - Not while recording: a take is one continuous stretch of the timeline (§9.1), so the bridge turns the cycle off for
    the take (the Recorder reports start and end) and the worklet holds it off while capture is armed. Looped
    (take-per-pass) recording is out of scope.

### 6.3 State and real-time safety
- The engine stores tracks, clips, devices and other entities in **arenas indexed by `u32`
  handles**. The bridge keeps the string id → handle map.
- Commands are applied at block start.
- Arenas and the voice pool are **preallocated** with generous capacity.
- **Known compromise:** structural commands, such as adding a device, can allocate on the
  audio thread if capacity is exceeded.
  - With wasm's allocator this is fast but not bounded.
  - The fix would be to build structures in a second wasm instance and hand them over
    through a SAB, which is deferred together with SAB.
  - Parameter changes, transport and note events **never** allocate.

### 6.4 DSP choices (defaults, open to challenge)
How DSP code is written for speed (inner loops, approximations, filter stacking, the resampler) is in
[`dsp.md`](dsp.md).

| area | choice | rationale |
|---|---|---|
| Automation | Keyframe points with direct interpolation between them, as in Logic. Ramp durations are entirely user-determined, with no hidden smoothing. Curves are `linear` or `hold` (step); per-segment bend comes later. Control sub-blocks **split at breakpoints**, so corners are sample-exact. | The user draws exactly what they get. The renderer never second-guesses the curve. |
| Param smoothing | Only for **discrete, non-automated** jumps (knob commits, remote drag overrides): a linear ramp to the target over 10 ms. Frequency-like params ramp in the log2 domain. | Prevents zipper noise from UI edits. Reaches the target in a fixed time, unlike a one-pole's infinite tail. Never applied to automation. |
| Clip fades | `fadeShape`: equal-power (sin/cos) default, linear, or S-curve (raised cosine). Every clip edge gets a 64-sample declick unless its fade is longer. | Equal-power keeps loudness constant through crossfades of uncorrelated material. The declick prevents edit clicks on cuts. |
| Filters | **TPT/ZDF state-variable filter** (Zavalishin; the wade `state_variable_filter`), computed in Simper/Cytomic form: `g = tan(ω/2)` prewarp, damping `R`, states `ic1`/`ic2`. Every response is one mix `m0·x + m1·bp + m2·lp` (LP, BP, HP, notch, peak, bells, shelves), so one branch-free kernel serves all modes; coefficients are computed once per run and shared by both channels. | Stable and artifact-free under per-sample modulation, unlike direct-form biquads. Simper's algebra is the same filter with a shorter dependency chain (see [`dsp.md`](dsp.md) §7). |
| EQ | Device kind 8: low shelf, two bells and a high shelf from the same SVF mixes, run in one fused per-sample loop with both channels interleaved. A band at exactly 0 dB is skipped. | Same modulation robustness and one tested core; fusing the bands is about 3x cheaper than chaining filter devices. |
| Delay | Tape echo: the read head is the variable-rate `Resampler` (its default design, below), so time changes bend pitch like a tape head. The feedback loop has an SVF tone filter, a rational-tanh saturator with unity small-signal gain, and a DC blocker. | A moving tape head instead of a crossfading or Hermite tap. The resampler's own low-pass is part of the sound: every pass darkens. |
| Compressor | Feed-forward, log-domain gain computer with soft knee, and a smooth decoupled peak detector (Giannoulis, Massberg & Reiss 2012). | The well-characterized modern design. Attack and release behave as specified. |
| Oscillators (synth) | Port of **wade `finnwave`**: a closed-form geometric series of `N = ⌊0.5/f⌋` harmonics with amplitudes `e^{-kb}`. Port changes, pending owner review: phase kept in f64 fundamental cycles; `e^{-b}` terms computed per block when the rolloff changes, not per sample; topmost harmonic crossfaded by fractional N. | **Exactly band-limited** (no aliasing at all, unlike PolyBLEP). The rolloff gives a natural low-pass timbre, and tying it to the envelope models frequency-proportional decay. |
| Pan | Equal-power pan law (−3 dB center). | Constant perceived loudness across the field. |
| Resampling | rubato synchronous FFT, f64, at import only. | See §5. |
| Variable-rate reading | `dsp::Resampler`: an analog low-pass in modal (partial-fraction) form, stepped exactly over arbitrary intervals; state at integer input positions, fractional output from a table. `Resampler::new()` (the tape delay) is Chebyshev-I order 5, 2 dB, 1 rad, zero-order hold. `Resampler::clean()` (the looper) is Chebyshev-I order 7, 0.5 dB, 2.2 rad, first-order hold. | Exact stepping removes the spurs of the old Taylor truncation and lets the cutoff rise to about 15 kHz at 48 kHz without instability (see [`dsp.md`](dsp.md) §10). |

Every DSP block lives in a **`dsp` crate with no wasm dependencies**, unit-tested natively
with `cargo test`: frequency response, stability under modulation, null tests and THD.

## 7. Repo layout
```
engine/                       Cargo workspace
  crates/dsp/                 pure DSP library (no_std-friendly, native tests)
  crates/engine/              real-time engine → engine.wasm (extern "C" API)
  crates/import/              Symphonia + rubato + WAV writer + peaks → import.wasm
client/src/audio/
  engine-host.ts              AudioWorklet node and processor, wasm hosting
  bridge.ts                   Yjs → engine commands, id↔handle maps
  stream-worker.ts            OPFS reads, S3 → OPFS downloads
  import-worker.ts            runs import.wasm
```
- Root `npm run build:wasm` runs cargo for both wasm crates and copies the artifacts to
  `client/src/audio/wasm/`.
- `npm run dev` runs it first. A `cargo watch` integration is optional later.

## 8. Milestones
Each milestone ends with something audible, and with `cargo test`, the TS typecheck and the
existing server tests passing.
1. **Toolchain and a hello-world.** The engine crate builds to wasm, is hosted in an
   AudioWorklet in the existing client, and plays a test tone. This proves the build
   pipeline, Vite integration and the worklet hosting pattern.
2. **Schema v2, the bridge, and audio clip playback in Rust.**
   - Includes the v1→v2 migration, clip split, and fades with declick.
   - Sources are still loaded whole for small files only (the 200 MB limit stays).
3. **Import pipeline and streaming:**
   - `import.wasm` (Symphonia, rubato, f32 WAV, peaks)
   - the OPFS source cache and the stream worker
   - waveform drawing from peaks
   - hour-long playback; this removes the 200 MB limit
4. **Device chains:** gain/pan, SVF filter, SVF EQ, delay and compressor, with live
   parameters (local immediate, collaborators via awareness, commit on release).
5. **Automation lanes and points.** (done: see engine-api.md "Automation")
6. **MIDI clips (per-clip BPM) and a synth:** finnwave oscillators, then the SVF, then an
   amp envelope, with rolloff modulatable by the envelope.
7. **Offline bounce/export:** the same engine in a worker, faster than real time, written to
   a WAV file.
8. **Recording** (§9).

## 9. Recording
Record from the microphone into an audio track, sample-aligned with the timeline, and share
the take only when the person who recorded it chooses to.

### 9.1 What the user does
- **R arms a track.** Arming is only on that user's screen; it's never written to the doc,
  because it's about *their* microphone. Only one track is armed at a time; arming another
  disarms the first. R appears on audio tracks only (MIDI recording comes later). The first
  arm asks for microphone access.
- **● (next to play, or shift+space) records.** Playback and capture start together from the
  playhead; pressed while playing, capture starts there (punch in). Plain play never records.
- **Stop ends the take.** It becomes an audio clip on the armed track, as one undo step.
- **A take is one continuous stretch of the timeline.** The transport cycle is suspended while recording (§6.2),
  seeking is ignored while recording,
  and the worklet ends capture if the engine position ever jumps (or the transport stops), so
  audio can't land in the wrong place.
- **Length limit:** a take stops itself just under the playback limit (`PLAYBACK_MAX_BYTES`,
  about 17 minutes of stereo at 48 kHz), so it can always be played back. This goes away with
  streaming.
- Viewers, and accounts that are read-only, can't arm.

### 9.2 Capture
- **Microphone:** `getUserMedia` with `echoCancellation`, `noiseSuppression` and
  `autoGainControl` off (call-style processing ruins music). **Channels follow the device:**
  after permission, apply `channelCount = getCapabilities().channelCount.max`. A stereo mic
  records stereo; reducing it to mono is an editing operation, not a capture setting.
- **In the engine's worklet.** The mic source connects to the engine's `AudioWorkletNode`
  (one input, `channelCountMode: 'max'`). While recording, `process()` copies `inputs[0]`
  into a buffer in the same call that advances the engine position, so every captured frame
  maps to a known timeline sample, with no clock matching between threads. Chunks (~1 s)
  are posted to the main thread, as transferables. Input audio reaches the wasm engine only
  while a track is **monitored** (below); otherwise it is not heard (use direct monitoring on the interface).
- **Input monitoring.** The `i` button on the armed track plays the microphone through that
  track's effects, gain and pan (`engine_monitor`, docs/engine-api.md). It is local UI state, off by
  default, and ends when the track is disarmed. It is heard one engine block plus the browser's
  input and output latency late, so direct monitoring is still better for tight playing; use
  headphones, or the speakers feed back into the mic.
- **Latency.** A take arrives late by output latency + input latency. The clip is placed at
  `start = position at record start - round((outputLatency + baseLatency + inputLatency + manual) * rate)`,
  where `inputLatency` is `track.getSettings().latency` (0 when the browser doesn't say) and
  `manual` is a per-device offset in ms kept in `localStorage` (set from the right-click
  menu on ●). Anything that would land before sample 0 is trimmed off the front of the take
  (`sourceOffset`). Automatic loopback calibration comes later.
- **Live take (the loop pedal's source).** `record` can also write every captured block into a *live source*
  (`engine_source_live_*`, docs/engine-api.md): a growing source in the engine, in chunks, silent past the frames written.
  The persistence path above is unchanged and still gets every chunk. Clips can play the take while it is being recorded.
  - **Timeline alignment.** Live frame `i` is the input captured at timeline sample `recstart + i`, where `recstart` is the
    worklet's `recstart` position (the timeline sample of the first captured frame). That input reached the engine
    `latency` samples (the Recorder's `latency()`) after the performer produced it, so what the performer *played* at timeline
    time `T` sits in frame `T - recstart + latency`. A clip window meant to line up with the timeline therefore needs
    `sourceOffset = (windowStart - recstart) + latency`, which is what `placeTake` does for a saved take
    (`start = recstart - latency`, same source). The live clip and the later doc clip then play the same audio at the same place.
  - **What is audible when.** At timeline position `p` the live source holds about `p - recstart` frames, so a window `[s, s+P)`
    (source frames) is complete once `p >= recstart + s + P`. A loop made at a boundary `B` over the previous pass, with
    `sourceOffset = (B - P - recstart) + latency`, is therefore complete from `B` on whenever `latency < P`; the part of the window
    not yet written (the last `latency` samples, if `P` were shorter) is silent.
  - **Finishing.** `finishTake(..., onHash)` calls `onHash(hash)` once the WAV is hashed, before the sample and clip are
    written to the doc; the pedal binds the live source there (`Playback.bindLiveSource`). The bridge then neither decodes nor
    loads that sample, and doc clips use the live source's handle. The live audio is the unquantized float input while the
    sample is its 16-bit WAV, so a replay in another session differs by the 16-bit rounding only.
  - **Headroom.** The Recorder reserves 30 s up front and tops up with every ~1 s chunk (a message to the worklet, which
    allocates); a main thread stalled for more than 30 s would drop frames (appends beyond the reserve are dropped).
- **Scheduled calls.** `EngineHost.callAt(at, fn, args)` applies an engine call on exactly timeline sample `at` (the worklet cuts
  its render block there); see docs/engine-api.md, "Host messages". Triggers from a foot switch are timestamped, quantized to a
  boundary, then scheduled with it, so they do not depend on when the message arrives.
- **Engine-only clips.** The bridge can hold audio clips that are not in the doc yet (`Bridge.liveClip`, `updateLiveClip`,
  `removeLiveClip`), now or scheduled. A doc clip with the same track, source, `start` and `sourceOffset` adopts such a clip when
  it is written (`adoptLiveClip` does it by id), so the engine keeps one clip on one handle and the doc's upsert is the same
  no-op as always.
- **Format:** 16-bit PCM WAV at the project sample rate, with the device's channel count.
  Decoding needs no resampling, and it costs ~5.8 MB/min per channel at 48 kHz.
  Device settings (bit depth, input choice, channel picking) come later.
- **Crash safety:** a header (track, start position, latency) and each chunk are appended to
  the `takes` store in `mobdaw-local` (IndexedDB) as they arrive. The recording tab holds a
  Web Lock named for the take until it's saved. On the next open of the project, backups whose
  lock is free are finished as normal takes, named "Recovered take", so a take another tab is
  still recording (or recovering) is never touched. Without Web Locks, a backup idle for 10 s
  counts as abandoned. The rows are deleted once the take is saved, and with the project
  (local projects; cloud projects this device deletes or leaves).
- To verify: whether every browser (Firefox historically) accepts a mic source in a context
  at a different rate from the device. If one doesn't, resample in the capture path.

### 9.3 Incoming takes (cloud projects)
A take is staged on the recorder's device and uploaded only when they choose, so they can
trim junk off it first. It is still a **normal clip in the doc** from the moment recording
stops, so trimming, moving and fx are ordinary, collaborative, undoable edits, even for
people who can't hear the audio yet.

- **On stop:** hash the WAV, store it on the device (the same per-project audio store local
  projects use), and in one transaction add the sample with `status: 'incoming'`, `by` (the
  recorder's user id, which never changes; usernames can), `byName` (their name, for the
  label), `peaks` (a low-resolution waveform, base64 via `peaksToBase64`) and the clip.
- **Playback:** the bridge does not request `incoming` sources, except on the recorder's own
  device, where it loads them from on-device storage. Everyone else hears silence there and
  sees the clip drawn from `peaks`, labelled "incoming from <name>".
- **UI:** an incoming clip pulses (a static dashed outline under `prefers-reduced-motion`),
  labelled "local only" for its recorder. Its menu offers **Upload** (`uploadToProject`, then
  clear `status`; every engine then fetches it; the staged copy is then deleted from the
  device) and **Discard** (delete the sample and every clip using it, in one transaction,
  after a confirm). Discard is not undoable: the samples map isn't in the undo scope, so undo
  would bring the clips back without their audio. An **Upload all** action covers a session's
  worth of takes. Read-only accounts can't edit the doc at all, so they get no menu; their
  takes stay on the device until they can upload or discard again.
- **Undone takes:** undoing a take removes its clip but leaves the sample (redo needs it).
  Upload all only uploads takes some clip plays, and when the project next opens (no undo
  history left), the recorder's unused incoming samples and their staged audio are deleted.
- **The whole file is uploaded**, not just the trimmed part: trims change the clip's
  `sourceOffset` and `length`, not the audio. Consolidating before upload (which changes the
  hash) can come later.
- **Lost staging:** if the recorder's device no longer has the audio (storage cleared, or
  another computer), the clip shows "incoming from <name>, not on this device" and any
  editor can discard it.
- **`missing`** reuses the same placeholder for audio whose upload was deleted:
  silence, peaks if known, labelled "audio deleted". The server sets it: when an upload is
  deleted (by its owner, or with their account), each project that no longer has anyone's copy
  of that file gets `status: 'missing'` on the sample, through a Hocuspocus direct connection
  (`markMissing`, best effort; the admin CLI, which has no live server, doesn't). Importing the
  same file again replaces the sample and clears it.
- **Copying to this device** (`collectCloud`): the recorder's own incoming takes come from the
  device and are ready in the copy; other people's stay `incoming` (silent) there.
- **Local projects skip all of this:** on stop, the take is imported directly (`importFile`
  already stores audio on the device) and gets no `status`.

### 9.4 Collaboration: a soft lock
Yjs has no locks: it accepts and merges every update. A server-enforced lock would mean
rejecting updates in Hocuspocus, which can't be done partially and leaves the rejected
client diverged, so we don't.

- While recording, the recorder publishes `recording: { trackId, start }` in **awareness**.
- Collaborators' UI treats that track as read-only (no deleting it, editing its clips or
  changing its fx), shows "<name> is recording", and draws the growing region from `start`
  to the recorder's playhead (also in awareness).
- It releases itself: awareness is cleared when the connection closes, so a crashed tab
  can't hold a lock.
- It isn't airtight: edits made before the lock arrives merge as usual. Recording only adds
  one clip, so the one damaging race is the track being deleted mid-take; at stop, if the
  track is gone, the take goes into a new track with the same name.
- The lock covers recording only. Once stopped, the take is a normal clip and `incoming`
  says it isn't shared yet.

## 10. Drum grid and the metronome

- **Drum grid**: a MIDI clip with `view: 'drums'` opens a step grid instead of the piano roll (same notes, same
  looping, same export). Rows are the track's instruments whose range is a single note (`keyLo === keyHi`), in
  synths-lane order; wide-range synths get no row. "+ add drum" adds a lofi drum on the lowest unused key from 36 up.
  A cell toggles a one-step, velocity-1 note. Notes at pitches without a single-note instrument are hidden but kept.
- **Several instruments per track**: a note goes to every non-bypassed instrument whose range contains its pitch;
  their outputs are summed before the track's effect chain.
- **Metronome button** (top bar): creates a MIDI track with `role: 'click'` (accent + tick lofi drums and a looping
  drum clip at 120 bpm, 4/4) in one undo step; afterwards it toggles that track's mute. Click tracks ignore solo
  (their own mute still counts). There is no count-in feature: start the song at bar 2, mute the click, and the
  export trims the lead-in (export covers only audible clips).

### Loop pedal principles (for later work)

- **Triggers resolve on the audio side, at exact samples.** A pedal press is timed by the audio thread, not the UI;
  the doc records the result afterwards (the clip's `start`, `length`, `loopLength`, `loopPhase`). Because playback is
  stateless, upserting the identical clip is a no-op, so what was heard live replays identically.
- **The seam rule uses only past audio.** The pass tail crossfades with the pre-roll before the pass start, never with
  audio after the pass end, so the seam can be computed while the loop is still being recorded.
- **Quantize boundaries** come from the click track's repeat seams when there is one, else the first live loop's pass
  defines them.

### Loop pedal (as built)

A MIDI foot controller (Web MIDI; `client/src/midi.ts`) drives the timeline like a loop station while one continuous take of the
whole session is captured into a live source. The logic is `client/src/audio/pedal.ts` (pure, tested with fake times);
`client/src/ui/pedalSession.ts` carries it out.

- **Where a press is.** A press is placed where the performer *heard* the timeline: the event's `timeStamp` (performance.now) is
  mapped through `AudioContext.getOutputTimestamp()` (the context time at the speaker, output latency included) and the
  engine's last `pos` report (`pos` at context `frame`) to a timeline sample (`heardPosition`).
- **Quantizing.** A press snaps to the next boundary of the grid, or to the one just before it when it is at most 150 ms late
  (never more than a quarter period). The grid is the click track's looping clip (origin = its start, period = its pass) if the
  project has one, else the first loop of the session (origin = where it began, period = its length).
- **Actions.** Loop (idle: begin the take and mark the layer start; next: close the layer at a boundary, which sounds the loop
  from there as a `forever` engine-only clip of the window `[start, end)` of the take, `sourceOffset = (start - recstart) + latency`;
  next: a new layer on a new track "loop n"), stop last, stop all (with nothing looping: end the session), undo (cancel the layer
  being recorded, else remove the latest loop).
- **Applying.** Playback is stateless, so adding a loop and removing one are applied at once, and a stop is scheduled at its
  boundary (`callAt`); an undo clears the queue and schedules the remaining stops again.
- **Session end** (pedal off, transport stop, or stop all with nothing looping): the take is saved with `finishTake` (binding the live
  source) on its own muted "pedal take" track, and the surviving loops are written in the same transaction as audio clips with
  the same track / source / start / sourceOffset, which the bridge adopts. A loop still going stays `forever`, with an extent of
  whole passes covering what was heard (at least two); a stopped one has `length = stop - start`.

