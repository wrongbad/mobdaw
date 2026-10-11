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
| `meta` | `schemaVersion: 2`, `sampleRate`, `guideBpm?` |
| `tracks` | `{ id, name, kind: 'audio'\|'midi'\|'soundscape', order, gain, pan, muted, soloed }` |
| `clips` | Audio clips: `{ id, trackId, kind:'audio', start, length, sourceHash, sourceOffset, gain, fadeIn, fadeOut, fadeShape }`. MIDI clips: `{ id, trackId, kind:'midi', start, bpm, ppq, lengthTicks }` |
| `notes` | `{ id, clipId, tick, durTicks, pitch, velocity }` |
| `devices` | `{ id, trackId, type, order, bypass, params: Y.Map<paramId, number> }` |
| `lanes` | Automation lanes, one per automated param: `{ id, enabled, order, scope, kind: 'synth'\|'effect'\|'looper', owner, param }`. `scope` is a track id, or `'master'` for the global fx chain; `owner` is the device or looper id; `param` is the device's param id (as a string) or the looper's field name (`gain`, `speed`, `sat`, `cutoff`, `warble`). The registry (`shared/src/params.ts`) resolves it to a range and scale. While `enabled` the lane *replaces* the param's value; the doc keeps the static value, and it comes back when the lane is disabled or deleted. |
| `points` | `{ id, laneId, pos (timeline samples), value (normalised 0..1 along the param's own scale), curve: 'linear'\|'hold' }`. `curve` shapes the segment *after* the point. |
| `samples` | Plain objects: `hash → { hash, name, duration, size, mime, status?: 'incoming'\|'missing', by?, peaks? }` (`by` is the recorder's username; `peaks` a base64 waveform). No `status` means the audio is in storage and anyone in the project can load it. See §9 for `incoming` and `missing`. |

- **Track kinds:**
  - An `audio` track sums its audio clips into its device chain.
  - A `midi` track feeds its MIDI clips to the first device in the chain, which must be an
    instrument.
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
  - This gives sample-accurate automation breakpoints within 32 frames, at a fraction of the
    cost of per-sample evaluation.
  - Note events are **sample-accurate**: sub-blocks split at event offsets.
- **Precision:**
  - Audio buffers are f32.
  - Positions, phase accumulators and time math are f64 or i64.
  - Long accumulators such as oscillator phase wrap in f64 so they don't drift over
    hour-long renders.
- **Denormals:** wasm has **no FTZ/DAZ control**, so subnormals are always enabled and can
  be slow. Every feedback state (filters, delays, reverbs) is flushed with an explicit
  `if x.abs() < 1e-20 { 0.0 }`, or gets a tiny alternating offset. This is enforced by a
  helper used in every recursive structure.
- **Summing** happens in f32. The master bus has no limiter by default; it shows a clip
  indicator and peak/RMS meters, sent to the UI at 30 Hz.

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
| area | choice | rationale |
|---|---|---|
| Automation | Keyframe points with direct interpolation between them, as in Logic. Ramp durations are entirely user-determined, with no hidden smoothing. Curves are `linear` or `hold` (step); per-segment bend comes later. Control sub-blocks **split at breakpoints**, so corners are sample-exact. | The user draws exactly what they get. The renderer never second-guesses the curve. |
| Param smoothing | Only for **discrete, non-automated** jumps (knob commits, remote drag overrides): a linear ramp to the target over 10 ms. Frequency-like params ramp in the log2 domain. | Prevents zipper noise from UI edits. Reaches the target in a fixed time, unlike a one-pole's infinite tail. Never applied to automation. |
| Clip fades | `fadeShape`: equal-power (sin/cos) default, linear, or S-curve (raised cosine). Every clip edge gets a 64-sample declick unless its fade is longer. | Equal-power keeps loudness constant through crossfades of uncorrelated material. The declick prevents edit clicks on cuts. |
| Filters | Port of **wade `state_variable_filter`** (Zavalishin TPT/ZDF SVF): `g = tan(ω/2)` prewarp via `set_exact`, damping `R`, simultaneous LP/BP/HP. Notch = LP+HP, peak = LP−HP, and shelves/bells come from mixing the outputs. The port adds denormal flushing on `s1`/`s2`. | Stable and artifact-free under per-sample modulation, unlike direct-form biquads. It's the owner's proven implementation. |
| EQ | Bells and shelves built from the same SVF's mixed outputs (Zavalishin multimode). | Same modulation robustness, and one tested core. |
| Delay | Fractional delay with 4-point cubic Hermite interpolation. Feedback path has a TPT one-pole tone filter. | Hermite is cheap and clean for modulated delay times. Allpass interpolation sweeps badly under modulation. |
| Compressor | Feed-forward, log-domain gain computer with soft knee, and a smooth decoupled peak detector (Giannoulis, Massberg & Reiss 2012). | The well-characterized modern design. Attack and release behave as specified. |
| Oscillators (synth) | Port of **wade `finnwave`**: a closed-form geometric series of `N = ⌊0.5/f⌋` harmonics with amplitudes `e^{-kb}`. Port changes, pending owner review: phase kept in f64 fundamental cycles; `e^{-b}` terms computed per block when the rolloff changes, not per sample; topmost harmonic crossfaded by fractional N. | **Exactly band-limited** (no aliasing at all, unlike PolyBLEP). The rolloff gives a natural low-pass timbre, and tying it to the envelope models frequency-proportional decay. |
| Pan | Equal-power pan law (−3 dB center). | Constant perceived loudness across the field. |
| Resampling | rubato synchronous FFT, f64, at import only. | See §5. |

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
- **A take is one continuous stretch of the timeline.** Seeking is ignored while recording,
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
