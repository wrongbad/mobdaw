//! Resampler + stateless loop voice.
use dsp::{LoopParams, LoopVoice, Resampler};
use std::f64::consts::PI;

const SR: f64 = 48000.0;

fn sine(f: f64) -> impl Fn(i64) -> f32 {
    move |i| (2.0 * PI * f * i as f64 / SR).sin() as f32
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
}

/// Run the resampler over `n` outputs at `speed` from input index `from`.
fn resample(speed: f64, f: impl Fn(i64) -> f32, n: usize) -> Vec<f32> {
    let mut rs = Resampler::new();
    rs.restart(-200);
    let scale = (1.0 / speed).min(1.0) as f32;
    let mut inp = |i: i64| (f(i), f(i));
    (0..n).map(|k| rs.advance(&mut inp, k as f64 * speed, scale).0).collect()
}

#[test]
fn resampler_passes_a_midband_sine_at_unit_speed() {
    let y = resample(1.0, sine(1000.0), 4000);
    let g = rms(&y[1000..]) / (0.5f64).sqrt();
    println!("1 kHz gain at 1x: {g:.3}");
    assert!((0.7..1.3).contains(&g), "gain {g}"); // Chebyshev ripple is +-2 dB
}

#[test]
fn resampler_is_unity_at_dc() {
    let y = resample(1.0, |_| 1.0, 4000);
    assert!((y[3999] - 1.0).abs() < 1e-3, "{}", y[3999]);
}

#[test]
fn resampler_attenuates_what_would_alias_when_speeding_up() {
    // 15 kHz at 2x would fold to 18 kHz (mirror about 24k): the filter cutoff drops with speed.
    let fast = resample(2.0, sine(15000.0), 6000);
    let slow = resample(1.0, sine(1000.0), 6000);
    let (a, b) = (rms(&fast[1000..]), rms(&slow[1000..]));
    println!("15 kHz @2x rms {a:.4} vs 1 kHz @1x rms {b:.4}");
    assert!(a < 0.15 * b, "aliasing energy {a} vs {b}");
}

fn params(speed: f64, start: i64, length: i64) -> LoopParams {
    LoopParams { speed, start, length, sample_rate: SR }
}

/// A band-limited tape: two sines.
fn tape(i: i64) -> (f32, f32) {
    let a = sine(440.0)(i);
    let b = sine(1234.5)(i);
    (0.6 * a + 0.3 * b, 0.3 * a + 0.6 * b)
}

/// A slow ramp: the output value says exactly where in the tape the read head is.
fn ramp(i: i64) -> (f32, f32) {
    (0.25 + i as f32 * 1e-5, 0.25 + i as f32 * 1e-5)
}

/// Render `n` samples from timeline `t0` in blocks, with `p_at(t)` giving the params for each block.
fn render_with(
    v: &mut LoopVoice,
    trigger: i64,
    t0: i64,
    n: usize,
    block: usize,
    mut p_at: impl FnMut(i64) -> LoopParams,
    mut src: impl FnMut(i64) -> (f32, f32),
) -> Vec<f32> {
    let mut out = Vec::new();
    let mut t = t0;
    while out.len() < n {
        let m = block.min(n - out.len());
        let (mut l, mut r) = (vec![0.0; m], vec![0.0; m]);
        v.render_add(&p_at(t), trigger, t, &mut src, &mut l, &mut r);
        out.extend(l);
        t += m as i64;
    }
    out
}

fn render(v: &mut LoopVoice, p: &LoopParams, t0: i64, n: usize, block: usize) -> Vec<f32> {
    render_with(v, 0, t0, n, block, |_| *p, tape)
}

fn crossings(y: &[f32]) -> usize {
    y.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count()
}

#[test]
fn a_trigger_starts_the_loop_clean_at_the_region_start() {
    let p = params(1.0, 10_000, 5_000);
    let mut v = LoopVoice::new();
    let y = render_with(&mut v, 7, 33_333, 1_000, 128, |_| p, ramp);
    // no crossfade with the audio past the loop end on the first pass: it follows the ramp from `start`
    for k in [50usize, 100, 250, 480, 700] {
        let want = 0.25 + (10_000 + k) as f32 * 1e-5;
        assert!((y[k] - want).abs() < 2e-3, "k={k}: {} vs {want}", y[k]);
    }
}

#[test]
fn the_loop_is_periodic_at_constant_speed() {
    let p = params(1.0, 20_000, 7_000);
    let mut v = LoopVoice::new();
    let y = render(&mut v, &p, 0, 30_000, 128);
    let worst = (8000..12_000).map(|t| (y[t] - y[t + 7_000]).abs()).fold(0.0f32, f32::max);
    assert!(worst < 5e-3, "{worst}");
}

#[test]
fn a_time_jump_or_a_new_trigger_restarts_the_loop() {
    let p = params(1.0, 10_000, 5_000);
    let mut v = LoopVoice::new();
    render_with(&mut v, 1, 0, 3_000, 128, |_| p, ramp);
    // seek: timeline jumps -> restart from the region start
    let y = render_with(&mut v, 1, 90_000, 700, 128, |_| p, ramp);
    assert!((y[600] - (0.25 + 10_600.0 * 1e-5)).abs() < 2e-3, "{}", y[600]);
    // same timeline continuity, new trigger id -> restart too
    render_with(&mut v, 1, 90_700, 3_000, 128, |_| p, ramp);
    let y = render_with(&mut v, 2, 93_700, 700, 128, |_| p, ramp);
    assert!((y[600] - (0.25 + 10_600.0 * 1e-5)).abs() < 2e-3, "{}", y[600]);
}

#[test]
fn speed_is_live_and_glides_without_clicks() {
    // 440 Hz tape; speed 1 -> 2 at t = 20000 (block aligned), no restart
    let tone = |i: i64| {
        let s = sine(440.0)(i);
        (s, s)
    };
    let mut v = LoopVoice::new();
    let change = 20_480; // a multiple of the 128 block
    let y = render_with(&mut v, 0, 0, 80_000, 128, |t| params(if t < change { 1.0 } else { 2.0 }, 0, 40_000), tone);
    // immediate: within 50 ms of the change the pitch is already rising
    let before = crossings(&y[change as usize - 2400..change as usize]);
    let soon = crossings(&y[change as usize..change as usize + 2400]);
    assert!(soon >= before + 2, "speed change not audible within 50 ms: {before} -> {soon}");
    // generous smoothing: not yet there at 50 ms, there after ~5 time constants (0.75 s)
    let late = crossings(&y[change as usize + 40_000..change as usize + 40_000 + 12_000]);
    let ratio = late as f64 / crossings(&y[change as usize - 12_000..change as usize]) as f64;
    println!("zero crossings before {before}, 50 ms after {soon}, ratio at 0.8 s {ratio:.2}");
    assert!((1.9..2.1).contains(&ratio), "{ratio}");
    // no clicks anywhere: steps stay within what a 2x-speed tone can do
    let worst = y.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
    assert!(worst < 0.2, "click: {worst}");
}

#[test]
fn the_loop_seam_has_no_click() {
    let p = params(1.0, 10_000, 5_000);
    let mut v = LoopVoice::new();
    let y = render(&mut v, &p, 0, 30_000, 128);
    let slope = |r: std::ops::Range<usize>| r.map(|k| (y[k + 1] - y[k]).abs()).fold(0.0f32, f32::max);
    let own = (0..30_000).map(|i| (tape(i).0 - tape(i + 1).0).abs()).fold(0.0f32, f32::max);
    let worst = (1..6).map(|w| slope(w * 5000 - 20..w * 5000 + 20)).fold(0.0f32, f32::max);
    println!("seam max step {worst:.3} vs tape's own {own:.3}");
    assert!(worst < 2.0 * own, "click at the seam: {worst} vs {own}");
}

#[test]
fn editing_the_region_while_playing_keeps_going() {
    let mut v = LoopVoice::new();
    let y = render_with(&mut v, 0, 0, 20_000, 128, |t| if t < 10_240 { params(1.0, 10_000, 5_000) } else { params(1.0, 12_000, 3_000) }, tape);
    assert!(y.iter().all(|x| x.is_finite()));
    assert!(rms(&y[12_000..]) > 0.1, "still sounding after the edit");
}

#[test]
fn degenerate_regions_are_silent() {
    let mut v = LoopVoice::new();
    let (mut l, mut r) = (vec![0.0; 128], vec![0.0; 128]);
    v.render_add(&params(1.0, 0, 3), 0, 0, &mut tape, &mut l, &mut r);
    v.render_add(&params(f64::NAN, 0, 5000), 0, 0, &mut tape, &mut l, &mut r);
    assert!(l.iter().chain(&r).all(|x| *x == 0.0));
}

#[test]
fn passband_report_at_unit_speed() {
    // Not a spec, a measurement: where wade's cutoff (1 rad/sample) puts the corner at 48 kHz.
    for f in [1000.0, 4000.0, 7000.0, 10000.0, 14000.0, 20000.0] {
        let y = resample(1.0, sine(f), 4000);
        let db = 20.0 * (rms(&y[1000..]) / (0.5f64).sqrt()).log10();
        println!("{f:>7.0} Hz: {db:+.1} dB");
    }
    let y = resample(1.0, sine(20000.0), 4000);
    assert!(rms(&y[1000..]) < 0.05, "20 kHz should be well down");
}
