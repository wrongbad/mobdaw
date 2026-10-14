# mobdaw DSP: performance and design principles

How DSP code in `engine/` should be written so the engine stays fast as projects grow. It complements
[`engine.md`](engine.md) (architecture, decisions) and [`engine-api.md`](engine-api.md) (contract). Like
`engine.md`, each rule says what we do, why, and what it costs, so it can be challenged.

The rules come from an audit of the engine (October 2026): reading the code, inspecting the compiled wasm, and
timing every block in wasm under V8. The code was then brought in line with them (see the git history); what remains is in §13. Measure with
`npm run bench` (§1).

---

## 1. Budget and measurement

- **The unit is ns per stereo frame.** At 48 kHz one core is 20,833 ns per frame, so `ns/frame × 0.0048` is the
  percentage of a core one instance costs.
- **Measure in wasm, not natively.** Native builds use the platform libm and different vectorization, and they
  hide the costs below. Time a `cdylib` built with `+simd128` under Node/V8, best of several runs, setup excluded.
- **Mobile is the real target.** Laptop numbers are a floor. Expect phones to be 2 to 4 times slower.

At the audit, and after the changes it led to (Intel i7-9750H, Node 24; `npm run bench` prints the audit column):

| block | audit ns/frame | now ns/frame | now % core |
|---|---|---|---|
| audio clip, playing | 22–27 | 1.0 | 0.005 |
| SVF filter device | 36 | ~18 | 0.09 |
| compressor | 77 | 65 | 0.31 |
| tremolo | 61 | 13 | 0.06 |
| reverb | 109 | 53 | 0.26 |
| tape delay (warble 0.25) | 282 | 100 | 0.48 |
| synth, 8 voices | 147 | 116 | 0.56 |
| looper voice (warble 0 / 0.5) | 111 / 222 | 59 / 137 | 0.28 / 0.66 |
| 16 tracks × (clip + filter, comp, trem, reverb, delay) | 10,870 | 2,520 | 12 |

What a few individual operations cost:

| operation (wasm) | ns |
|---|---|
| `f64::sin` | 21 |
| `f32::exp` | 16 |
| `f32::tanh` | 35 |
| indirect call (`fn` pointer) in an inner loop | ~3–4 per call, and it blocks inlining |

## 2. Wasm facts that drive everything

- **There are no transcendental instructions.** `sin`, `cos`, `tan`, `exp`, `exp2`, `ln`, `log2`, `powf`, `tanh`,
  `f64::round` and `rem_euclid` on floats (`fmod`) are all software calls. Each costs as much as dozens of
  multiply-adds.
- **SIMD is 128-bit.** That is f32x4 or f64x2. f64 code gets half the lanes, so keep f64 for phases and
  positions, not for audio arithmetic.
- **No FMA.** Baseline `simd128` has no fused multiply-add. `relaxed-simd`'s `relaxed_madd` is
  nondeterministic across machines, so it is banned (engine.md §1, deterministic rendering).
- **Denormals are always on.** On x86 hosts they are 10–100× slower. Apple silicon has no such penalty. We
  flush anyway because we run on both.
- **LLVM only vectorizes what it may reorder.** It won't vectorize a floating-point reduction or induction
  (`g += dg`) without fast-math, which we do not use. It will vectorize `g = g0 + dg * (i + 1) as f32`.

## 3. Data structures and traversal

- **Entities live in `HandleMap`s.** These are vectors sorted by handle, so iteration is deterministic and
  contiguous. Keep this. The rendered bits depend on summation order.
- **Render traversal follows derived lists, not lookups.** `rebuild_routing` runs on every structural change. It
  should store whatever `process` walks (device chains, a track's clips) as dense indices into the maps'
  storage, so the render loop never binary-searches. Chains, MIDI clips, lanes and
  the looper tape are stored this way (`HandleMap::get_index`).
- **The work is proportional to what is sounding, not to the project size.**
  - Clips: keep per-track lists sorted by start, plus a playhead cursor. Done: two binary searches per
    block find the overlapping clips.
  - Voices: only active voices are visited.
  - Devices and tracks sleep (§9).
- **Struct-of-arrays where a loop runs across many of the same thing.** Synth voices are the case to convert,
  so 4 voices can share an f32x4. *Blocked for now: finnwave fails its accuracy test in f32 (see §6), so voices
  stay f64; f64x2 voice pairs are untried.*

## 4. Blocks, buffers and in-place processing

- **Buffers are planar, preallocated and reused.** Devices process in place on `&mut [f32]` slices. Nothing in
  `process` allocates (`tests/no_alloc.rs` enforces it).
- **Process the longest run you can.** The control segment (≤ 32 samples) exists for automation and note timing.
  Only the code that needs it should be split by it.
  - Instruments render in segments split at notes.
  - Effects run over the whole block, split only at their *own* lanes' breakpoints, because effects never feed
    back into instruments. A device with lanes, or mid knob glide, runs in pieces of at most 32 frames, because
    devices read their smoothed values once per run.
  - Longer runs mean fewer coefficient recomputes and better vectorization.
- **Recompute coefficients only when they change.** Compute once per run, share between channels, and skip it
  while every ramp is at rest (a dirty flag).
- **Delay lines wrap without division.** Use power-of-two lengths with a mask, or split each block into at most
  two contiguous runs. Never use `%` or `rem_euclid` per sample.

## 5. Inner loops

A per-sample loop should contain loads, stores, adds, multiplies and selects only. In detail:

1. **No calls.** In particular, no `fn` pointers chosen outside the loop. *The filter and delay `pick` compiles
   to a `call_indirect` per sample.* Express modes as mix coefficients instead (§7), or as a `match` hoisted
   outside the loop with a separate loop in each arm.
2. **No transcendentals per sample** unless the algorithm truly needs them.
   - LFOs run at control rate with linear interpolation, or as a rotating phasor re-seeded each block (the
     pattern `finnwave` uses).
   - Gain computers use approximations (§6).
   - Nonlinearities use cheap shapes (§8).
3. **Lift conditionals.** Loop-invariant flags (`stealing`, `fading`, `mode`) choose a loop, they are not tested
   per sample. Event-driven state (a loop wrap, a fade edge, an envelope stage change) is handled by computing
   the run up to the next event and then running a branch-free loop over it.
4. **Write ramps in closed form.** `g0 + dg * (i + 1) as f32`, not `g += dg` (see §2).
5. **Interleave independent recurrences.** A recursive filter is limited by its dependency chain, not by
   arithmetic. Running L and R (or several bands, or several voices) in the same loop lets the CPU overlap the
   chains. Measured: the SVF goes from 25 to 18 ns per stereo frame from interleaving alone.
6. **Flush denormals once per block.** Do it on the recursive state at the end of the block, not on every
   sample. Values written into delay buffers are flushed when written.
7. **Split by event, not by sample.** Audio clips are the model: fade-in, then body (`dst += src * g`, one run
   per loop pass), then fade-out. The body path is about 17× faster than per-sample `sample_at`.

## 6. Math approximations

[wade's `math.h`](https://github.com/wrongbad/wade/blob/main/wade/math.h) has the shapes we reach for:

- `fast::exp` and `fast::tanh`: Schraudolph bit tricks, with the `exp(x/2)/exp(-x/2)` ratio for accuracy.
- `fast::sin2pi` and `fast::cos2pi`: a parabola plus a 0.225 correction, error about 1e-3.
- Quarter-wave and full-wave sine LUTs driven by a `u32` phase.
- `softsign` and `cubic_tanh`.

All of them are pure f32 or integer operations, so they are deterministic in wasm. To port them:

- In Rust, `as i32` saturates. The bit-trick functions still need their input clamped to keep the exponent in
  range.
- Use `f32::from_bits`/`to_bits` for the type punning.

**Use an approximation where its error is far below what the signal path can reveal.** Do not use one where the
algorithm relies on exact identities. Rules:

| use | approximation | why |
|---|---|---|
| LFOs: tremolo, warble, lane LFOs | `sin2pi`/`cos2pi`, or a `u32`-phase LUT | ~1e-3 shape error on a sub-audio modulator is inaudible. A `u32` phase wraps exactly with no `fract` or `fmod`. |
| Compressor dB↔linear, envelope gain | fast `exp`/`log2` | A 0.1 % gain error is ~0.01 dB. |
| Fade and pan curves | either | Evaluated per block, or error-tolerant. The mix device evaluates its pan law at the two edges of each run and ramps the coefficients linearly between them. |
| Filter coefficients (`tan` prewarp) | **exact** | Computed per run, not per sample, so it costs nothing to be exact. Errors near Nyquist detune the filter. |
| **finnwave** sin/cos | **exact (or exact-seeded rotation)** | The closed form relies on cancellation in the geometric-series numerator, divided by a denominator that is small near θ = 0. Approximate sines break the cancellation, and the error is amplified and spread above the harmonics as aliasing. The waveform is audibly degraded (as found with wade's `shapes.h`). Keep the f64 seed plus complex rotation. An f32 inner loop fails too, even with a cancellation-free denominator: rounding drift in the rotated phasors is amplified by about 1/b, reaching 2e-3 of peak (a −70 dB floor) at b = 0.001. Keep the loop in f64. |
| Saturators in the audio path | smooth shapes with a known slope (§8) | Bit-trick `tanh` has derivative kinks at every power of two, which add low-level harmonics and alias. In a feedback loop its slope at 0 must match `unity_gain`, or the decay rate shifts. |

Every approximation needs a test against the exact function: maximum error over the range used, plus a spectrum
check where it touches audio.

## 7. Filters: the SVF and EQs

- **One SVF core, in Simper's (Cytomic's) form.** This is the same TPT/ZDF filter as the wade port, with the algebra
  rearranged so the loop-carried chain is about 16 cycles instead of about 39:
  ```
  g = tan(pi fc / fs)   k = 2R   a1 = 1/(1 + g(g + k))   a2 = g a1   a3 = g a2
  v3 = x - ic2   v1 = a1 ic1 + a2 v3   v2 = ic2 + a2 ic1 + a3 v3   ic1 = 2 v1 - ic1   ic2 = 2 v2 - ic2
  out = m0 x + m1 v1 + m2 v2
  ```
- **Every response is a mix**, so one kernel serves all modes with no branch. `v1` is the band-pass and `v2` the
  low-pass. The existing bell and shelf mixes carry over unchanged.

  | mode | m0 | m1 | m2 |
  |---|---|---|---|
  | LP | 0 | 0 | 1 |
  | BP | 0 | 1 | 0 |
  | HP | 1 | −k | −1 |
  | notch | 1 | −k | 0 |
  | peak (lp − hp) | −1 | k | 2 |
  | allpass | 1 | −2k | 0 |
  | bell / low shelf / high shelf | as in `FilterDevice` | | |
- **Stacking for an EQ:**
  - **Fuse the bands into one sample loop** with channels interleaved. Measured on a 4-band bell EQ: 117 ns/frame
    as four separate passes, 38 ns/frame fused.
  - **Explicit SIMD only after that.** Put L, R × 2 bands in an f32x4, with a one-sample skew between bands so the
    serial dependency between them doesn't block the vector.
  - **Skip a band at exactly 0 dB** (A = 1 is the identity). Reset its state when it re-enters; the gain ramp
    starting from A = 1 keeps that click-free.
  - **Steeper LP/HP are cascades with per-stage Butterworth damping.** For 24 dB/oct that is R ≈ 0.383 and 0.924,
    not two identical 0.707 stages.
- **Known limit:** bilinear filters cramp near Nyquist. Bells and shelves above ~10 kHz are squeezed at 44.1/48 kHz.
  The shelf warp centres the midpoint but doesn't fix the shape. If that matters, oversample the EQ or use a
  decramped design.

## 8. Nonlinearities

- **Saturation aliases.** `tanh(d·x)` with `d` up to 10 makes harmonics far above Nyquist. Use first-order
  antiderivative anti-aliasing (ADAA, Parker et al. 2016; for `tanh` the antiderivative is `log cosh`) or 2×
  oversampling around the shaper.
- **Inside feedback loops the small-signal slope is a design parameter.** The delay's `unity_gain` assumes the
  shape's slope at 0. Any replacement shape must report its own slope.
- **Per-sample state such as drive is ramped, but the shape's derived constants are computed per run.**

## 9. Silence and sleep

- **A device that provably outputs zero is not processed.** The test: input all zero for the block, and the state
  is exactly zero (filters, once flushed) or the tail has decayed (a reverb N samples past its −120 dB time).
- A feedback delay at or above unity never sleeps, and neither does one with warble on (skipping would shift the
  warble phase of later echoes).
- A tail device only counts exactly-zero input, so a reverb after a delay sleeps only once the delay outputs
  exact zeros.
- A track whose instruments are idle, with no clips and every effect asleep, skips its chain and its gain loop.
  In real projects most tracks are silent most of the time, so this is the largest single saving.

## 10. Variable-rate reading (looper, tape delay)

- **The `Resampler` integrates an analog low-pass across the input**, which is held constant over each sample
  (zero-order hold) or ramped linearly (first-order hold). The filter is stepped by arbitrary time intervals, and
  that is what makes it a resampler for any speed.
- **The old step was a 3rd-order Taylor expansion, which limited both stability and accuracy.**
  - Stability: |p·dt| had to stay below ~√3, which capped the cutoff at 1 rad/sample, about 7.5 kHz at 48 kHz.
  - Accuracy: the truncation error depended on the fractional dt, which changes every output at non-integer
    speeds, so it added spurs at −70 to −80 dB.
- **What we do now: modal form, stepped exactly.**
  - Split H(s) into partial fractions: one complex one-pole per pole, `s' = p s + r u`.
  - The exact step for any dt is `s ← e^{p dt} s + r dt [φ1(p dt) u0 + φ2(p dt)(u1 − u0)]`, with
    `φ1(z) = (e^z − 1)/z` and `φ2(z) = (e^z − 1 − z)/z²` (use their series for small |z|).
  - It is unconditionally stable for any cutoff, and it allows zeros, so elliptic designs work.
  - The input ramps linearly across each interval (first-order hold) instead of holding. That gives sinc² image
    rejection instead of sinc.
  - The state is kept only at integer input positions. The output at a fractional position is *evaluated* from a
    small table over dt ∈ [0, 1], with no transcendentals per sample. The 4 modes of a 7th-order design fit in
    one f32x4.
  - Two designs. `Resampler::new()` keeps the old response (Chebyshev-I order 5, 2 dB, 1 rad, zero-order hold),
    stepped exactly. `Resampler::clean()` is Chebyshev-I order 7, 0.5 dB, 2.2 rad, first-order hold: −0.9 dB at
    8 kHz, −2 dB at 12 kHz, −20 dB at 19 kHz at speed 1. Both run faster than the old Taylor step (37 vs 65
    ns/frame at speed 1, 64 vs 148 at speed 4).
  - What we give up with `clean()`: worst-case aliasing rises to about −51 dB (19 kHz input at 1.37× speed) and
    −60 dB at 2×. An elliptic design would win it back; not done yet.
- **Character is chosen, not inherited.** The looper uses `clean()`. The tape delay keeps `new()`, whose low-pass
  is the "every pass darkens" sound; moving that into an explicit tone stage would let the delay read cleanly too.

## 11. Automation and control

- **Control is linear between control points, never stepped.** A lane is evaluated at both ends of a segment and
  ramped across it. Segments already split at breakpoints, so the ramp is exact.
  - Breakpoints use the left limit, so a `hold` point is still an exact step. LFO lanes ramp the same way.
- **Parameters that only set coefficients** (filter cutoff) may step per run. The TPT SVF is robust to that.
  Parameters that scale audio (gain, mix, depth) must ramp per sample, or at least change every ≤32 frames (the
  run length while a device glides).

## 12. Determinism checklist for any optimization

- Same operations in the same order on every client: no `HashMap` iteration and no relaxed SIMD.
- Approximations are pure f32/integer code with no platform intrinsics that differ between hosts.
- Changing an algorithm changes the rendered bits relative to older builds. That is fine, but note it in the
  commit, and update any golden-output tests deliberately.

## 12b. Long-running sessions: integer time, wrapped phase, anchored derivations

A tab can stay open for days (the engine keeps running for meters and live keys even stopped), so nothing may
depend on a number that only grows being precise.

- **Absolute time is an integer.** The transport and tape write indices are `i64` samples, ADSR and note counters
  are `u32`/`u64`, the SVF flush counter wraps (`wrapping_add`). Never keep a running time in `f32`
  (24-bit mantissa: unit precision is gone after ~5.8 min at 48 kHz); `f64` is exact far past any session
  (2^53 samples is millions of years) but a position as a float still loses sub-sample resolution (~1e-4 sample at
  2^40, 240 days), which is why float time is only ever derived locally.
- **Phase is wrapped every step.** Oscillator and warble phases are `f64` cycles folded with `fract()` per block;
  the tremolo phase is a `u32` (2^32 per cycle) advanced with `wrapping_add`. The looper phase is folded into
  `[0, len)`. A phase that is only ever added to and never wrapped is a bug.
- **Derived values are anchored.** Automation LFO lanes compute the wave from the integer transport position
  (`pos as f64 * cycles_per_sample`), never from a free-running accumulator, so play, seek, loop wrap and a bounce
  all agree. Device-internal LFOs keep wrapped phases that are reset on note-on or `reset()`.
- **Feedback paths flush denormals** (`flush_denormal`): reverb combs and allpasses, the tape delay write and DC
  blockers, SVF states, the compressor reduction, the drum envelope. The resampler's modal states are not flushed
  (a decaying one passes through the subnormal range in a few thousand samples and then reaches zero).
- Tests seed counters far out (`TapeDelay::n = 1 << 36`, `seek` to a week of samples, phases set to huge values)
  and compare against a fresh state instead of rendering for hours.

## 13. Open work

- **Resampler alias rejection.** `clean()` reaches about −51 dB (19 kHz input at 1.37× speed). Try a 7th-order
  elliptic design and first-order-hold droop compensation, then tighten the −45 dB spur bound in
  `dsp/tests/resampler.rs` to just under what is measured.
- **Looper voice event runs** (`dsp/src/looper.rs`): compute the run to the next wrap or seam, then a tight loop,
  with crossfade gains from a phasor.
- **Delay character.** Move the "every pass darkens" low-pass into an explicit tone stage, so the delay can read
  through `Resampler::clean()`.
- **Synth voices.** f32 fails (§6), so try f64x2 voice pairs.
- **Explicit f32x4 kernels.** EQ (L, R × 2 bands, one-sample skew), resampler modes, the reverb's L and R comb banks.
- **Sleep gaps.** A delay with warble never sleeps, and a tail device after another only sleeps once its input is
  exactly zero.
- **EQ device UI.** A multi-band curve instead of plain sliders.
- *(Quality, later)* Exponential ADSR segments and an FDN reverb (both change existing projects' sound), decramped
  bells and shelves near Nyquist.
