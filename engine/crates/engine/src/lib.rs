//! engine.wasm: the real-time audio engine, exposed as plain `extern "C"` functions.
//!
//! There is no wasm-bindgen: the AudioWorklet scope lacks APIs its glue expects, and raw
//! exports keep the toolchain to `cargo` + the wasm32 target. JS talks to the engine through
//! an opaque pointer and reads audio through a `Float32Array` view on wasm memory.
//!
//! The exact contract (names, argument order, semantics) is `docs/engine-api.md`. The Rust
//! logic lives in [`engine::Engine`]; this file is only the C ABI veneer (booleans arrive as
//! `u32`, sample positions as integral `f64`).
//!
//! Real-time rule: `engine_process` and the parameter/transport/note calls never allocate.
//! Structural calls (upsert/remove, source alloc) may.

pub mod clip;
pub mod device;
pub mod engine;
pub mod handle_map;
pub mod source;
pub mod transport;
mod test_voice;

pub use engine::{Engine, BLOCK};
pub use test_voice::{PARAM_CUTOFF, PARAM_DAMPING, PARAM_FREQ, PARAM_GAIN, PARAM_GATE, PARAM_ROLLOFF};

/// Create an engine. Returns an owning pointer; free it with `engine_free`.
#[no_mangle]
pub extern "C" fn engine_new(sample_rate: f32) -> *mut Engine {
    Box::into_raw(Box::new(Engine::new(sample_rate)))
}

/// Pointer to the output buffer: `2 * 128` f32, planar (L block then R block).
/// The pointer is stable for the engine's lifetime (but wasm memory can be detached by
/// `memory.grow`, so JS must recreate its `Float32Array` view if `memory.buffer` changes).
///
/// # Safety
/// `e` must come from `engine_new` and not yet be freed.
#[no_mangle]
pub unsafe extern "C" fn engine_out_ptr(e: *mut Engine) -> *mut f32 {
    (*e).out_ptr()
}

/// Render `frames` (at most 128) frames into the output buffer.
///
/// # Safety
/// `e` must come from `engine_new` and not yet be freed.
#[no_mangle]
pub unsafe extern "C" fn engine_process(e: *mut Engine, frames: u32) {
    (*e).process(frames as usize);
}

/// Set a test-voice parameter (ids in `test_voice::PARAM_*`).
///
/// # Safety
/// `e` must come from `engine_new` and not yet be freed.
#[no_mangle]
pub unsafe extern "C" fn engine_set_param(e: *mut Engine, id: u32, value: f32) {
    (*e).set_param(id, value);
}

/// Destroy an engine created by `engine_new`.
///
/// # Safety
/// `e` must come from `engine_new`, and must not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn engine_free(e: *mut Engine) {
    if !e.is_null() {
        drop(Box::from_raw(e));
    }
}

// ---- transport -----------------------------------------------------------------------------

/// Start the transport at sample position `from_pos`.
///
/// # Safety
/// `e` must come from `engine_new` and not yet be freed (same for every function below).
#[no_mangle]
pub unsafe extern "C" fn engine_play(e: *mut Engine, from_pos: f64) {
    (*e).play(from_pos as i64);
}

#[no_mangle]
pub unsafe extern "C" fn engine_stop(e: *mut Engine) {
    (*e).stop();
}

#[no_mangle]
pub unsafe extern "C" fn engine_seek(e: *mut Engine, pos: f64) {
    (*e).seek(pos as i64);
}

#[no_mangle]
pub unsafe extern "C" fn engine_position(e: *mut Engine) -> f64 {
    (*e).position() as f64
}

#[no_mangle]
pub unsafe extern "C" fn engine_is_playing(e: *mut Engine) -> u32 {
    (*e).is_playing() as u32
}

// ---- sources -------------------------------------------------------------------------------

/// Returns a pointer to a planar buffer (channel 0 frames, then channel 1, ...). The host must
/// re-read `memory.buffer` afterwards, since memory may have grown.
#[no_mangle]
pub unsafe extern "C" fn engine_source_alloc(e: *mut Engine, h: u32, channels: u32, frames: f64) -> *mut f32 {
    (*e).source_alloc(h, channels, frames)
}

#[no_mangle]
pub unsafe extern "C" fn engine_source_ready(e: *mut Engine, h: u32) {
    (*e).source_ready(h);
}

#[no_mangle]
pub unsafe extern "C" fn engine_source_free(e: *mut Engine, h: u32) {
    (*e).source_free(h);
}

// ---- tracks, clips, notes, devices ----------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn engine_track_upsert(
    e: *mut Engine,
    h: u32,
    kind: u32,
    gain: f32,
    pan: f32,
    muted: u32,
    soloed: u32,
) {
    (*e).track_upsert(h, kind, gain, pan, muted != 0, soloed != 0);
}

#[no_mangle]
pub unsafe extern "C" fn engine_track_remove(e: *mut Engine, h: u32) {
    (*e).track_remove(h);
}

/// Create or update a loop slot on a looper track (track kind 2). `start`/`length` are the
/// loop region in timeline samples; `length < 64` means no region.
///
/// # Safety
/// `e` must come from `engine_new` and not yet be freed.
#[no_mangle]
pub unsafe extern "C" fn engine_looper_upsert(e: *mut Engine, h: u32, track: u32, speed: f64, start: f64, length: f64) {
    (*e).looper_upsert(h, track, speed, start as i64, length as i64);
}

/// A looper's level (linear, 0..2) and mute flag (non-zero = muted).
///
/// # Safety
/// `e` must come from `engine_new` and not yet be freed.
#[no_mangle]
pub unsafe extern "C" fn engine_looper_mix(e: *mut Engine, h: u32, gain: f32, muted: u32) {
    (*e).looper_mix(h, gain, muted != 0);
}

/// The looper's read head on the source tape (samples), or -1 while it isn't sounding.
///
/// # Safety
/// `e` must come from `engine_new` and not yet be freed.
#[no_mangle]
pub unsafe extern "C" fn engine_looper_head(e: *mut Engine, h: u32) -> f64 {
    (*e).looper_head(h)
}

#[no_mangle]
pub unsafe extern "C" fn engine_looper_remove(e: *mut Engine, h: u32) {
    (*e).looper_remove(h);
}

/// A pad (gate block): all of `track`'s loopers sound over `[start, start+length)` of the timeline.
///
/// # Safety
/// `e` must come from `engine_new` and not yet be freed.
#[no_mangle]
pub unsafe extern "C" fn engine_pad_upsert(e: *mut Engine, h: u32, track: u32, start: f64, length: f64) {
    (*e).pad_upsert(h, track, start as i64, length as i64);
}

/// Create (or retarget) a preview transport on a soundscape track. `mode` 0 plays the source
/// tape straight through, 1 plays the loopers continuously (no pads). Its position is private to
/// it: the timeline transport is untouched.
///
/// # Safety
/// `e` must come from `engine_new` and not yet be freed (same for every preview call below).
#[no_mangle]
pub unsafe extern "C" fn engine_preview_upsert(e: *mut Engine, h: u32, track: u32, mode: u32) {
    (*e).preview_upsert(h, track, mode);
}

#[no_mangle]
pub unsafe extern "C" fn engine_preview_remove(e: *mut Engine, h: u32) {
    (*e).preview_remove(h);
}

#[no_mangle]
pub unsafe extern "C" fn engine_preview_play(e: *mut Engine, h: u32, from_pos: f64) {
    (*e).preview_play(h, from_pos as i64);
}

#[no_mangle]
pub unsafe extern "C" fn engine_preview_stop(e: *mut Engine, h: u32) {
    (*e).preview_stop(h);
}

#[no_mangle]
pub unsafe extern "C" fn engine_preview_seek(e: *mut Engine, h: u32, pos: f64) {
    (*e).preview_seek(h, pos as i64);
}

#[no_mangle]
pub unsafe extern "C" fn engine_preview_position(e: *mut Engine, h: u32) -> f64 {
    (*e).preview_position(h) as f64
}

#[no_mangle]
pub unsafe extern "C" fn engine_preview_is_playing(e: *mut Engine, h: u32) -> u32 {
    (*e).preview_is_playing(h) as u32
}

#[no_mangle]
pub unsafe extern "C" fn engine_pad_remove(e: *mut Engine, h: u32) {
    (*e).pad_remove(h);
}

#[no_mangle]
pub unsafe extern "C" fn engine_clip_audio_upsert(
    e: *mut Engine,
    h: u32,
    track: u32,
    source: u32,
    start: f64,
    length: f64,
    source_offset: f64,
    gain: f32,
    fade_in: f64,
    fade_out: f64,
    fade_shape: u32,
) {
    (*e).clip_audio_upsert(
        h,
        track,
        source,
        start as i64,
        length as i64,
        source_offset as i64,
        gain,
        fade_in,
        fade_out,
        fade_shape,
    );
}

#[no_mangle]
pub unsafe extern "C" fn engine_clip_midi_upsert(
    e: *mut Engine,
    h: u32,
    track: u32,
    start: f64,
    bpm: f64,
    ppq: u32,
    length_ticks: f64,
) {
    (*e).clip_midi_upsert(h, track, start as i64, bpm, ppq, length_ticks);
}

#[no_mangle]
pub unsafe extern "C" fn engine_clip_remove(e: *mut Engine, h: u32) {
    (*e).clip_remove(h);
}

#[no_mangle]
pub unsafe extern "C" fn engine_note_upsert(
    e: *mut Engine,
    h: u32,
    clip: u32,
    tick: f64,
    dur_ticks: f64,
    pitch: u32,
    velocity: f32,
) {
    (*e).note_upsert(h, clip, tick, dur_ticks, pitch, velocity);
}

#[no_mangle]
pub unsafe extern "C" fn engine_note_remove(e: *mut Engine, h: u32) {
    (*e).note_remove(h);
}

#[no_mangle]
pub unsafe extern "C" fn engine_device_upsert(e: *mut Engine, h: u32, track: u32, kind: u32, order: f64, bypass: u32) {
    (*e).device_upsert(h, track, kind, order, bypass != 0);
}

#[no_mangle]
pub unsafe extern "C" fn engine_device_remove(e: *mut Engine, h: u32) {
    (*e).device_remove(h);
}

#[no_mangle]
pub unsafe extern "C" fn engine_param_set(e: *mut Engine, device: u32, param: u32, value: f32) {
    (*e).param_set(device, param, value);
}
