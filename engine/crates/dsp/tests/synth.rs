use dsp::synth::{self, Synth, STEAL_FADE};

const SR: f32 = 48000.0;

fn render(s: &mut Synth, n: usize) -> Vec<f32> {
    let mut v = vec![0.0; n];
    s.render_add(&mut v);
    v
}

fn quick_params(s: &mut Synth) {
    s.set_param(synth::P_ATTACK_MS, 0.0);
    s.set_param(synth::P_DECAY_MS, 0.0);
    s.set_param(synth::P_SUSTAIN, 1.0);
    s.set_param(synth::P_RELEASE_MS, 10.0);
    // let the 10 ms smoothing ramps land
    render(s, 1024);
}

#[test]
fn note_sounds_then_releases_to_silence_and_frees_the_voice() {
    let mut s = Synth::new(SR);
    quick_params(&mut s);
    s.note_on(69, 1.0, 2000);
    let a = render(&mut s, 2000);
    assert!(a.iter().any(|x| x.abs() > 0.01));
    s.release_due(2000);
    let b = render(&mut s, 480); // 10 ms release
    let c = render(&mut s, 64);
    assert!(b.iter().any(|x| x.abs() > 0.0));
    assert!(c.iter().all(|&x| x == 0.0));
    assert_eq!(s.active_voices(), 0);
}

#[test]
fn velocity_scales_amplitude_linearly() {
    let peak = |vel: f32| {
        let mut s = Synth::new(SR);
        quick_params(&mut s);
        s.note_on(60, vel, i64::MAX);
        render(&mut s, 4800).iter().fold(0.0f32, |p, x| p.max(x.abs()))
    };
    let (full, half) = (peak(1.0), peak(0.5));
    println!("peak at vel 1.0: {full:.4}, vel 0.5: {half:.4}");
    assert!((half / full - 0.5).abs() < 1e-3);
}

#[test]
fn more_notes_than_voices_neither_panics_nor_exceeds_the_pool() {
    let mut s = Synth::new(SR);
    for i in 0..200u32 {
        s.note_on(36 + i % 48, 0.8, i64::MAX);
        let out = render(&mut s, 32);
        assert!(out.iter().all(|x| x.is_finite()));
        assert!(s.active_voices() <= 64);
    }
    println!("200 notes into 64 voices: {} active", s.active_voices());
    assert_eq!(s.active_voices(), 64);
}

#[test]
fn stolen_voice_fades_over_64_samples_before_the_new_note_starts() {
    let mut s = Synth::with_voices(SR, 1);
    quick_params(&mut s);
    s.set_param(synth::P_GAIN, 1.0);
    render(&mut s, 1024);
    s.note_on(57, 1.0, i64::MAX);
    let before = render(&mut s, 256);
    let ref_peak = before.iter().skip(64).fold(0.0f32, |p, x| p.max(x.abs()));
    s.note_on(64, 1.0, i64::MAX); // steals the only voice
    let out = render(&mut s, 160);
    let rms = |r: &[f32]| (r.iter().map(|x| x * x).sum::<f32>() / r.len() as f32).sqrt();
    let (first, last) = (rms(&out[..16]), rms(&out[48..64]));
    println!("steal: peak before {ref_peak:.3}, rms first16 {first:.4}, last16 {last:.4}, out[63]={:.5}", out[63]);
    assert!(last < 0.3 * first, "fade not decaying");
    assert!(out[63].abs() < 0.05 * ref_peak);
    assert!(out[STEAL_FADE as usize..].iter().any(|x| x.abs() > 0.01), "new note never started");
}

#[test]
fn rolloff_modulation_darkens_as_the_note_decays() {
    // With env->rolloff at 3 and a fast decay to sustain 0, the late signal must have far less
    // high-frequency content than the early signal at the same pitch.
    let mut s = Synth::new(SR);
    s.set_param(synth::P_ATTACK_MS, 0.0);
    s.set_param(synth::P_DECAY_MS, 400.0);
    s.set_param(synth::P_SUSTAIN, 0.0);
    s.set_param(synth::P_ENV_TO_ROLLOFF, 3.0);
    s.set_param(synth::P_ROLLOFF, 0.05);
    render(&mut s, 1024);
    s.note_on(48, 1.0, i64::MAX);
    let early = render(&mut s, 2400);
    render(&mut s, 12000);
    let late = render(&mut s, 2400);
    // Sum of squared first differences / sum of squares ~ spectral centroid proxy.
    let bright = |x: &[f32]| {
        let d: f32 = x.windows(2).map(|w| (w[1] - w[0]).powi(2)).sum();
        d / x.iter().map(|v| v * v).sum::<f32>().max(1e-20)
    };
    println!("brightness early {:.3}, late {:.3}", bright(&early), bright(&late));
    assert!(bright(&late) < 0.5 * bright(&early));
}
