# Patch matching: automatic synth sound matching

Status: **plan, nothing built.** Python orchestrates; Rust runs the hot loops. This doc is self-contained and the plan of record.

Goal: find parameter settings for our engines (bore, subtractive, filters, EQ, reverb) that closely approximate General MIDI soundfont instruments.

Approach: analysis-by-synthesis. Render the soundfont as the target, render our engine with candidate parameters, score with a perceptual loss, search the parameters. Solve analytically what can be solved analytically; search the rest with a black-box optimizer; reuse results across the 128 programs; let an agent or human inject trial candidates between batches.

## Layers

| Layer | Where | Language | Role |
|---|---|---|---|
| 1. Engine calibration | `engine/crates/dsp` (`bore_cal.rs`, `bore_calibrate`) | Rust | Per-engine offline sweep and closed-form fit so raw knobs always speak. See `docs/bore.md`. |
| 2. Render + score worker | `engine/crates/match` (new) | Rust | Hot loop: render a population of candidates, compute loss and features. No policy. |
| 3. Optimizer, CLI, reports | `tools/match/` (new) | Python | CMA-ES (pycma), run dirs, suggestions, reports, plots, batch driver. |

Rule: anything per-sample or per-candidate-population is Rust. Python never touches audio buffers except to write plots and to load targets for analysis.

## Calibration is a dependency

Layer 1 must be usable before layer 3 runs on an engine. Without it the loss landscape is mostly silent or squealing plateaus and CMA-ES looks broken. The optimizer therefore searches in the **calibrated** knob space (`breath`, `aperture`, 0-1), never raw drive.

- Today (see `docs/bore.md`) about 70% of test points speak. Finish the factor-sweep analysis and refit before running the optimizer on bore.
- Recalibrating an engine invalidates stored runs for that engine. Each run records the calibration revision (the git hash of `bore_cal.rs`) in `config.yaml`; `report` warns on mismatch.
- A candidate outside its sounding region (note out of range, silent, or unstable) gets a fixed large penalty and is flagged in `trials.jsonl`, not scored by the spectral loss.

## Rust worker (`match` crate)

A binary `match-worker` that reads requests and writes responses as JSON lines on stdio. One long-lived process per optimizer run, so startup and target loading are paid once.

Why a subprocess and not pyo3: no Python build coupling in the Rust workspace, a crash or NaN in a render can't take down the optimizer, it's trivially debuggable by piping JSON by hand, and one request carries a whole population so per-call overhead is irrelevant. Revisit pyo3 only if profiling shows IPC matters. The request/response structs live in one Rust module (serde), and a binding would reuse them unchanged.

Requests:

- `load_target {id, wav_paths | probe_spec}`: load or cache target clips, precompute target STFTs, envelopes and features.
- `eval {engine, target_id, fidelity, candidates: [{id, params(real units)}]}`: render every candidate against every probe note (rayon over candidate × note), return per-candidate loss breakdown and a `speaks` flag.
- `render {engine, params, note, vel, dur_s, sr, out_wav}`: for audio export and the listening pass.
- `features {wav | engine+params+note}`: descriptive features (attack time, centroid over time, band errors, decay times, f0, inharmonicity, vibrato) for reports.
- `schema {engine}`: parameter names, units, ranges, scale (lin/log), defaults, discrete choices. Python builds its normalisation from this and nothing else, so there is one source of truth.

Responses are plain JSON; large arrays (spectrogram diffs for plots) are written to files and referenced by path.

Contents:

- Engine adapter trait: `render(params, note, vel, dur, sr) -> Vec<f32>` plus the schema. Bore first (wraps the device DSP), then subtractive, string.
- Loss: multi-resolution STFT (log + linear magnitude, ~256/1024/4096), mel weighting, dB RMS envelope term, attack/sustain/release segment weights. Returns a per-note × segment × band breakdown, not only a scalar.
- Determinism: noise sources seeded from the candidate/note, so identical params give identical loss.
- Fidelity levels: `lo` (1-2 notes, short, lower sr) and `full`. Chosen per request.
- Reuse the measurement code from `bore_calibrate` (onset, f0 error, stability) as the `speaks` gate rather than reimplementing it.

## Python orchestrator (`tools/match`)

Python depends on numpy, pycma, pyyaml, matplotlib, and `soundfile`/`pyfluidsynth` for target rendering. It runs offline and is not shipped.

- **Parameter space:** read from the worker `schema`. Normalise to [0, 1], log scale for Hz/s/Q. The CLI and suggestion files always speak real units.
- **Optimizer:** pycma for continuous params (10-40 dims). Discrete choices via `branch` (or enumerate short searches). Staged search: exciter/structure, filter/envelope, modulation/velocity, then a joint polish. Multi-fidelity with successive halving using `fidelity`.
- **State:** `trials.jsonl` is the source of truth; `state.pkl` is a cache and can be rebuilt by replaying.
- **Batches:** one `eval` request per generation (population in one message), so the worker parallelises across cores.

### Run directory (one per target patch)

Under `docs/match/runs/<label>/`. The tree is on disk but git-ignored; only `config.yaml`, `best.json` and `report.md` are tracked (see `.gitignore`). `trials.jsonl`, `state.pkl`, `plots/` and `audio/` are raw and untracked, so back that directory up outside git. The shippable result of a run is the final parameter set, committed into the presets or a small patch file, not the run directory:

```
config.yaml   target, engine, calibration revision, param schema, loss weights, stages
state.pkl     CMA-ES object (cache)
trials.jsonl  every candidate: params, loss breakdown, source, note, generation
best.json     best params, real units
report.md     latest report
plots/        spectrograms, difference spectrograms, envelope overlays
audio/        target + best render per probe note
```

### Provenance and local-only data

Run data is a **local, opportunistic cache** to save time. It is never the source of truth and can always be regenerated; do not rely on it existing in a fresh clone.

Every run (calibration or matching) writes its provenance into its tracked summary (`fit.md`, `config.yaml`): git commit hash (plus a dirty flag), a hash of the DSP source it depends on, the tool and its arguments, grid or probe-suite version, loss version, RNG seeds, date, and the machine. A run with a dirty tree is marked as such and should not be trusted as a baseline. `report`/`verify` compare the recorded DSP hash with the current one and say whether the cached data is still valid or must be regenerated.

Each trial records `source` (`cma`, `suggest`, `branch:<name>`) and an optional `note`.

### Commands

```
match init    <run> --target sf2:<file>:<program> --engine bore
match run     <run> --gens 20
match resume  <run> --gens 20 [--suggest file.yaml] [--set k=v] [--nudge k=*1.3]
match branch  <run> --engine subtractive --gens 30 --as <new>
match eval    <run> --suggest try.yaml
match report  <run>
match compare <runA> <runB>
```

Suggestions are ordinary candidates, injected into the next generation (`es.inject(X, force=True)`, at most 4 of 16 slots), scored by the same loss and kept or dropped by selection. Unknown names or out-of-range values are a hard error. Large jumps and any discrete or structural change go through `branch`.

Exit codes: 0 budget reached, 10 stalled, 11 converged (sigma collapsed), 12 a suggested trial became best, 1 error. The last stdout line is the stop reason and the report path.

### Report

Text-first: header (generation, trial count, best loss and trend, sigma, verdict), loss breakdown table (note × segment, worst cell flagged), target-vs-best feature diffs for the worst note, missing features (vibrato, noise, inharmonicity, pitch drop), best params with the most-changed highlighted, suggestions scoreboard (new best / beat median / worse), and paths to plots and audio. Feature diffs come from the worker `features` request.

## Matched vs hand-tuned presets

Two kinds of preset, kept in separate files so a re-run can never overwrite ear work:

| | Matched (auto) | Hand-tuned |
|---|---|---|
| File | generated `client/src/content/presets.matched.ts` (do not edit) | the normal `presets.ts` groups |
| Reference | locked to the GM soundfont program, probe suite and loss version | none; a human's taste |
| Written by | the batch driver, from `best.json` of a run | a person (or an agent on request) |
| Re-run | regenerated freely | never touched by the tooling |

Each matched preset records its key: GM program, engine, calibration revision, loss/probe-suite version, final loss, and the run label. Matching runs for the engine start from the previous matched params (incremental build; see `docs/bore.md`, "Priors and incremental recalibration").

A hand-tuned preset that started from a matched one says so in a structured comment above it:

```ts
// basedOn: gm=37 rev=<calibration rev> matched=<matched preset id>; brighter, shorter release
```

`match presets --stale` lists hand-tuned presets whose `basedOn` target has since been re-matched or re-calibrated (revision differs), with a diff of the params that moved. The tool only reports. The human decides whether to re-apply their tweaks (the "brighter" delta, expressed as nudges) on top of the new matched preset. Keeping the delta as nudges against the matched base, rather than as absolute values, is what makes that re-apply cheap.

## Analytic initialisation

Done in the Rust worker where it touches audio (so there is one analysis implementation); Python only consumes the results as the CMA-ES start.

- Amplitude envelope: fit ADSR or a multi-segment envelope to the target's dB RMS.
- EQ (final stage): ratio of long-term average spectra, smoothed, closed-form band gains.
- String: partial peak-picking gives f0 and inharmonicity B; per-partial decay times give loss params; comb-like gaps give pluck position.
- Tube/bore: resonances and odd/even harmonic balance give bore type and length; these overlap with the calibration model, so share the fitted forward model rather than duplicating it.
- Reverb: off during matching; add afterwards from an RT60 estimate.

## Probe suite

Per GM program, from a good soundfont (GeneralUser GS or FluidR3): 3-4 pitches across the range, 2 velocities (64, 120), a short and a held note. Cleaned: dry (no chorus/reverb sends), mono, onset-aligned, loudness-normalised. About 12-16 clips of 1-3 s. GM drums are out of scope for now.

Engine defaults per family: plucked/struck → string; reeds/pipes/brass → bore; synth leads and pads → subtractive; ambiguous → short search in each, keep the winner. Warm-start from a neighbour in the same family of 8.

## Implementation order

1. Finish bore calibration (factor-sweep analysis, refit, verify). Gate for step 5.
2. Probe-suite renderer: soundfont → normalised, aligned WAVs (Python + fluidsynth).
3. `match` crate skeleton: engine adapter trait, `schema`, `render`, stdio JSON loop. Bore adapter. Rust tests for determinism and schema round-trip.
4. Loss and features in Rust, with the per-segment/band breakdown. Reuse the calibration `speaks` gate.
5. Python optimizer core: normalisation, pycma loop, `trials.jsonl`, checkpoint/resume.
6. CLI (`init/run/resume/eval/report/branch/compare`), suggestion parsing, exit codes.
7. Report generator and plots.
8. Analytic initialisers (envelope, EQ, string, tube).
9. Staging and multi-fidelity.
10. Batch driver over the 128 programs with family warm-starts.
11. Later: inverse model for initialisation (random patches rendered by the worker, small network); differentiable proxy for the subtractive core.

## Pitfalls

- Normalise loudness and onset-align targets and renders, or the loss measures gain and offset.
- Don't let suggestions always set the CMA-ES mean; keep most of each population optimizer-sampled.
- If loss weights change mid-run, judge final results with a fixed reference loss and by listening.
- Require real units in suggestions; reject ambiguity.
- Soundfont artifacts (baked reverb, loop points, velocity-layer switches): strip what can be stripped, don't chase the rest.
- Cheap-fidelity drift: re-score the best at `full` fidelity before accepting.
