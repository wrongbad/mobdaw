# Bore: a unified waveguide wind/string synth

Status: **draft playable; calibration improving.** Phases 1-4 have landed: DSP core (`bore.rs`), calibration (`bore_cal.rs`, linear fits, 5 character anchors), engine device kind 10 (`boresynth.rs`), and ten presets (winds / strings groups). Calibration quality: 79% of (anchor, bore, position, note, breath 0/.5/1) test points speak (`bore_calibrate verify`, docs/bore/runs/2026-10-14-combined/verify.txt), up from 70% after adding stiffness/damping/decay correction terms from the factor sweep (docs/bore/runs/2026-10-14-factors/analysis.md). The drive band edges and loudness are still roughly modelled; levels vary between notes and the extremes of `breath` can fall silent or squeal. Next: the user tunes the presets by ear.
This doc is the plan of record across sessions; update it as phases land.
The automatic patch-matching optimizer that consumes this calibration is planned in `docs/matching.md` (Python orchestrates, a Rust worker runs the hot loops). Calibration is its prerequisite.

### Deviations from the plan
- `bore` is a two-way selector (closed / open), not a continuous 0..1; the calibration is per bore.
- Eight voices per device.
- Position and bore are read at note start; the other knobs glide.
- The fit is per character anchor (reed, reed/jet, jet, jet/bow, bow) with linear interpolation in `character`, features `note, fold, open, stiffness, damping, ln loss(decay)`.

### Calibration log
- 2026-10-14-draft: first sweep with the current tool (1000 cells, 920 live) and linear fit emitted into `bore_cal.rs`. Summaries: docs/bore/runs/2026-10-14-draft/ (`fit.md`, `verify.txt`; raw CSV/SVG are on disk only, git-ignored). The earlier runs in docs/bore/runs/2026-10-14-first used an older CSV format.
- 2026-10-14-combined: combined pinned sweep (1000 cells) + factor sweeps (17x280 cells varying stiffness/damping/decay one at a time) refitted together. The stiffness/damping/decay features now have non-zero coefficients. Verify: 923/1170 (79%), up from 824/1170 (70%). Factor sweep analysis in docs/bore/runs/2026-10-14-factors/analysis.md; decay has the largest effect, stiffness is moderate, damping is minimal.

Sources: wade `wip/simple_bow.h` and `wip/simple_flute.h` (our own code, free to reuse), and STK `Saxofony.cpp` (MIT-style). The implementation is new Rust in `engine/crates/dsp`, using these as reference.

## Idea

All three sources are the same instrument: **one delay-line loop (bore or string) excited at one point by a nonlinear valve.**

```
          drive (breath pressure / bow speed)
           + noise + vibrato, slewed by a gate
                         │
                         ▼
   ┌──── delay A ────[ junction at position p ]──── delay B ────┐
   │                y = Δ·g(Δ),   Δ = drive − wave at p           │
   └── termination: reflection ±r, then lowpass damping ─────────┘
                      output = DC-blocked loop signal
```

- Saxofony: the loop is split into two delays at `position` (0.5 sounds like a clarinet, near the end like a sax). The termination is −0.95 through a lowpass; the junction is a reed table.
- simple_bow: one delay with an insert tap at `bow_x`, reflection −0.95, an FIR damper, and a bow-friction junction.
- simple_flute: two junctions (blow + bow) on the same delay at movable positions.

### One junction formula

Every nonlinearity is **Δ times an opening g(Δ) ∈ [0, 1]**:

| Curve | g(Δ) | Character |
|---|---|---|
| reed | `clamp(aperture − stiffness·Δ, 0, 1)` | one-sided valve, closes under pressure; buzzy, odd-heavy |
| jet | `1 − Δ²` (y = Δ − Δ³) | symmetric soft saturation; breathy, pure |
| bow | `force·(0.3 + 1/(1+4|Δ|)) / |Δ|`, capped at 1 | stick-slip; sawtooth-like |

`character` morphs g between reed → jet → bow, so hybrids in between come for free. Breath pressure and bow speed are the same signal: a gated, slewed drive plus noise plus vibrato, with a velocity burst decaying into the sustained level (wade's `velbias`).

## Parameters (v1)

| Param | Range | Maps to |
|---|---|---|
| character | 0 reed … 0.5 jet … 1 bow | g(Δ) morph |
| stiffness | 0–1 | reed slope / jet curvature / bow friction falloff |
| aperture | 0–1 | reed offset / bow force (calibrated, see below) |
| position | 0–1 | junction position along the loop |
| bore | 0 closed … 1 open | termination reflection sign (closed: odd harmonics) |
| damping | 0–1 | loop lowpass |
| decay | 0–1 | reflection magnitude (ring after release) |
| breath | 0–1 | drive level (calibrated, see below) |
| noise | 0–1 | turbulence on the drive |
| vibrato rate / depth | Hz / 0–1 | drive LFO (breath vibrato) |
| vibrato pitch | 0–1 | same LFO retunes the loop, 60 cents peak (string / voice vibrato); not part of the calibration |
| vibrato delay | ms | both vibratos fade in from the note start |
| bell | 0–1 | even harmonics above ~1.2 kHz, outside the loop (a closed bore alone is odd-only at every frequency, so it sounds like a square wave; a clarinet's evens return above its ~1.5 kHz tone-hole cutoff). A tone-hole allpass in the loop was tried first and dropped: its inharmonic upper resonances pulled the pitch ±100+ cents unpredictably. |
| attack / release | s | gate slew |

A second junction (simple_flute's blow + bow) is out of scope for v1.

**Note range:** notes outside the working range are rejected (no voice). The low bound comes from the max delay length; the high bound is where tuning or stability fails in calibration.

## Calibration (the hard part)

Raw physical controls only sound in a narrow region. A bow speaks only in a slice of force × velocity that moves with pitch and position; a reed has a pressure threshold, then squeals. The user must never hunt for that sweet spot. So the user-facing `breath` and `aperture` knobs are **normalised**: 0–1 maps into the sounding region for the current note and settings, and output gain is normalised to roughly equal loudness. The mapping is precomputed offline.

### Offline sweep tool

A Rust binary (e.g. `engine/crates/dsp/src/bin/bore_calibrate.rs`, or an `xtask`) renders the DSP core directly, with no engine or wasm:

- **Grid:** character anchors (reed, reed/jet, jet, jet/bow, bow) × bore (closed, open) × position (a few points) × MIDI note (every 2–3 semitones across the candidate range) × raw drive × raw aperture/force (about 12–16 steps each). Hold release, noise and vibrato at defaults. Render about 300–500 ms per cell. Run in parallel (rayon); expect minutes, not hours, and keep the grid coarse.
- **Measurements per render:**
  - Onset time: the time for the envelope to reach −6 dB of its steady level.
  - Steady RMS and peak.
  - Pitch: f0 by autocorrelation or YIN on the steady part, and its error in cents vs the target note.
  - Stability: f0 jumps (octave or harmonic flips = squeaks), the spread of the RMS envelope, NaN/inf, and a noise-to-harmonic ratio.
  - "Speaks" = onset under a limit, f0 within ±N cents of the target, and stable.
- **Per (anchor, bore, position, note) cell, derive:**
  - The sounding region in (drive, aperture) and a monotone path through it from "just speaks" to "just before squeal". The user knob walks along that path.
  - A loudness gain that flattens steady RMS along the path and across notes.
  - A tuning correction in cents/samples for the loop's phase delay, measured rather than computed (Saxofony subtracts `filter.phaseDelay(f)` analytically; measuring also catches the junction's effect).
  - The note range where the cell speaks at all.
- **Output: closed-form curves, not tables.** Each derived quantity (the region's low and high bound for drive and aperture, the loudness gain, the tuning correction, the note-range limits) is fitted as a closed-form function of the inputs (note or log-frequency, character, position, bore).
  - Start with a **linear approximation**: least squares over the sweep. Report the residuals per quantity, and plot them against each input.
  - Only where the residuals show clear structure, pick an appropriate curve: for example exponential or power-law in pitch, a quadratic in position, or a piecewise fit across the reed/jet/bow anchors. Keep each formula small and explain the choice.
  - The fitted coefficients go into the DSP code as a few named constants, with a comment naming the generator, its grid and the fit error. The sweep tool stays in the repo so the fit can be redone whenever the DSP changes.
- **Regression test:** for every preset and every note in its range, a short render speaks (onset, pitch and stability within limits). This catches DSP edits that silently break calibration.

Open questions for the calibration phase:
- Whether `stiffness` and `damping` also shift the region enough to need a table axis, or whether a small correction suffices.
- Whether vibrato and noise at preset levels push cells out of the sounding region; if so, calibrate with them on.
- Which inputs each fitted quantity actually depends on; drop the terms that don't matter.

## Priors and incremental recalibration

Goal: the fitted curves (`bore_cal.rs`) and the presets are the only durable artifacts; raw sweep data is disposable (git-ignored, see CLAUDE.md). A prior makes a re-run an incremental build:

- **Key.** Each fit records what it was derived from: a hash of the DSP source it depends on (`bore.rs`, the device), the grid, and the fit error. Emit this into a small tracked data file read by the sweep tool as well as the code.
- **Verify first.** On a key mismatch run a sparse `verify` (a few hundred cells). If the speak rate and residuals are within tolerance, re-stamp the key and stop. Otherwise sweep a narrow band around the prior's predicted edges and refit.
- **Guard.** Always add ~10% of cells spread over the full grid. A large miss there means the prior is invalid (a regime change, as for the open bore below MIDI 33) and triggers a full sweep.
- **Limits.** The prior guides *where to sample*; it is not a warm start for the coefficients if the model form changes.
- **Presets.** Hand-tuned presets sit on top of the knob mapping, so a recalibration can change how they sound. See `docs/matching.md`, "Matched vs hand-tuned presets", for how they are separated and flagged.

### Run provenance
Calibration runs record provenance in their `fit.md`/`verify.txt`: commit hash and dirty flag, DSP source hash, tool arguments, grid, date and machine (details in `docs/matching.md`, "Provenance and local-only data"). Run data (CSV, SVG, logs) is a local cache that can be regenerated; only the summaries are tracked. Existing runs predate this: `2026-10-14-pinned` and `-draft` correspond to commit `1a69c36`'s tool, `-factors` to `439be4f`, `-first` is obsolete.

## Phases

1. **DSP core** (`engine/crates/dsp`): fractional delay loop with a movable junction, the morphable g(Δ), termination and damping, DC block, drive (gate slew, noise, vibrato, velocity burst). Unit tests: no NaN, bounded output, silence when not driven, each anchor oscillating at some raw setting.
2. **Calibration tool and tables**: as above. Iterate on the DSP until each anchor has a usable region across a reasonable note range.
3. **Engine device**: a new instrument kind behind the normal device interface (params, smoothing, sleep/glide reporting like the other devices), with note-range rejection and the calibrated mappings. Register it in `shared/src/devices.ts`. Docs: `engine-api.md`, `dsp.md`.
4. **Presets** (`client/src/content/presets.ts`, new "winds" and "strings" groups if it reads better):

   | Preset | character | bore | position | Notes |
   |---|---|---|---|---|
   | Clarinet | reed | closed | 0.5 | stiff reed, low noise, light vibrato |
   | Alto sax | reed | open | 0.2 | softer reed, noise 0.2, vibrato 5.7 Hz |
   | Breathy flute | jet | open | 0.1 | high noise, slow attack, gentle vibrato |
   | Shakuhachi | jet | open | 0.25 | very high noise, strong pitch wobble |
   | Bottle | jet | closed | 0.5 | short decay, high damping |
   | Cello | bow | open | 0.12 | medium force, slow attack, ~5 Hz vibrato |
   | Fiddle | bow | open | 0.08 | high force, bright, fast attack |
   | Glass harmonica | bow/jet | open | 0.3 | low force, long decay, no vibrato |
   | Reed organ | reed/jet | closed | 0.4 | steady drive, no vibrato |
   | Growl lead | reed | open | 0.15 | max stiffness, high breath, overblown |

5. **Tuning by ear** (user): adjust presets and, if needed, the calibration targets.
- 2026-10-14-pinned: same grid with stiffness/damping/decay held at 0.5/0.3/0.7 (`sweep --pin`). The spread of the band edges and the level collapses (lo edge 0.03-0.14 ln units, from 0.3-0.7), so the earlier poor fits were interaction, not model error in note/position/bore. Two other findings: (1) an open bore below MIDI 33 is a different regime (band top runs off the grid, level flips), so the fit now leaves it out (`OPEN_NOTE_MIN`); (2) a few cells per row flip to another mode ("wolf" notes), so the fits are now robust (IRLS, near-L1) instead of plain least squares. Next: one-factor-at-a-time sweeps (2026-10-14-factors) to model stiffness / damping / decay.

## Where we left off (2026-10-14)

- Playable draft landed: engine device (kind 10), ten presets, SLOW regression, and fitted calibration from the pinned sweep (1a69c36).
- Factor sweeps (stiffness/damping/decay one-at-a-time) analysed: decay has the largest effect on drive band edges and level (up to 1.07 shift in ln drive hi, non-linear, anchor-dependent); stiffness is moderate (~0.7-0.8); damping is minimal. Full analysis: docs/bore/runs/2026-10-14-factors/analysis.md.
- Combined fit (pinned + factor sweeps, ~5400 live cells) emitted into `bore_cal.rs`. Verify: **923/1170 (79%)**, up from 824/1170 (70%). The stiffness/damping/decay coefficients are now populated.
- Next: the user tunes the presets by ear. Further calibration gains would likely require non-linear correction terms for decay's effect on drive hi / rms (R² = 0.25-0.36 with the current linear model).
