# To do

- **Resampler states are never flushed for denormals.** `dsp::resampler::Resampler::step` (used by the tape delay head and the looper heads) lets the modal state decay through the subnormal range when its input is silent; wasm has no FTZ. It is a bounded transient (thousands of samples) so it has not been seen to matter. If a long-session CPU spike shows up on a silent looper region, flush `s` every N steps (as `Svf` does).

- **Presets don't record the calibration they were tuned against.** The bore knobs (`breath`, `aperture`) are mapped through `bore_cal.rs`, so refitting the calibration silently changes how every tuned preset sounds (`client/src/content/presets.ts`, `engine/crates/dsp/src/bore_cal.rs`). Fix: stamp a calibration revision in `bore_cal.rs`, record it in each bore preset (`basedOn`/`rev` comment or field), and add a check that flags presets whose revision differs. See `docs/matching.md`, "Matched vs hand-tuned presets".
