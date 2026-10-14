//! The bore (waveguide) synth as an engine device (kind 10): it speaks, rejects notes outside
//! its range, goes idle after release, and can be bypassed.

use engine::{Engine, BLOCK};

const SR: f32 = 48000.0;

fn render(e: &mut Engine, frames: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    let mut left = frames;
    while left > 0 {
        let n = left.min(BLOCK);
        e.process(n);
        out.extend_from_slice(&e.output().0[..n]);
        left -= n;
    }
    out
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
}

fn play(character: f32, pitch: u32) -> Vec<f32> {
    let mut e = Engine::new(SR);
    e.track_upsert(1, 1, false, false, false);
    e.device_upsert(1, 1, 10, 1.0, false);
    e.param_set(1, 0, character);
    e.clip_midi_upsert(1, 1, 0, 120.0, 960, 8000.0, 0.0);
    e.note_upsert(1, 1, 0.0, 960.0, pitch, 1.0);
    e.play(0);
    render(&mut e, 36_000)
}

#[test]
fn every_anchor_speaks_at_a_mid_range_note() {
    for c in [0.0, 0.25, 0.5, 0.75, 1.0] {
        let out = play(c, 60);
        assert!(out.iter().all(|v| v.is_finite()));
        let r = rms(&out[12_000..22_000]);
        assert!(r > 0.01 && r < 1.0, "character {c}: rms {r}");
    }
}

#[test]
fn notes_outside_the_range_are_rejected() {
    // far below what the delay lines hold
    assert!(play(0.0, 5).iter().all(|&v| v == 0.0));
    assert!(rms(&play(0.0, 60)) > 0.01);
}

#[test]
fn bypass_is_silent_and_release_ends_the_note() {
    let mut e = Engine::new(SR);
    e.track_upsert(1, 1, false, false, false);
    e.device_upsert(1, 1, 10, 1.0, true);
    e.clip_midi_upsert(1, 1, 0, 120.0, 960, 8000.0, 0.0);
    e.note_upsert(1, 1, 0.0, 960.0, 60, 1.0);
    e.play(0);
    assert!(render(&mut e, 12_000).iter().all(|&v| v == 0.0));
    let out = play(0.0, 60);
    // note is 0.5 s (24000 frames) plus a 120 ms release: quiet well after
    assert!(rms(&out[34_000..36_000]) < 0.01 * rms(&out[12_000..22_000]));
}
