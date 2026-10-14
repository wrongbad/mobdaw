# To do

- **MIDI editor gesture cancel uses `undo.undo()`.** When a second pointer cancels a note drag, the editor rolls back with `undo.undo()` and clears the redo stack (`client/src/ui/noteEditor.ts`, dc763a1). If the drag hasn't recorded its own undo step by then, this undoes the user's previous edit instead. Fix: snapshot the affected notes at drag start and restore them on cancel without touching the undo stack. Add a test.

- **Resampler states are never flushed for denormals.** `dsp::resampler::Resampler::step` (used by the tape delay head and the looper heads) lets the modal state decay through the subnormal range when its input is silent; wasm has no FTZ. It is a bounded transient (thousands of samples) so it has not been seen to matter. If a long-session CPU spike shows up on a silent looper region, flush `s` every N steps (as `Svf` does).
