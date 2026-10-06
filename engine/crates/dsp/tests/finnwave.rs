use dsp::finnwave::SUB_BLOCK;
use dsp::Finnwave;
use rustfft::{num_complex::Complex, FftPlanner};
use std::f64::consts::TAU;

/// Direct additive reference: b * sum_{k=1..N} w_k e^{-kb} sin(k theta), with the top harmonic
/// weighted by r = 0.5/f - N (the documented crossfade) and all others by 1.
fn brute_force(f: f64, b: f64, p: f64) -> f64 {
    let ratio = 0.5 / f;
    let n = ratio.floor() as usize;
    let r = ratio - n as f64;
    let mut s = 0.0;
    for k in 1..=n {
        let w = if k == n { r } else { 1.0 };
        s += w * (-(k as f64) * b).exp() * (TAU * k as f64 * p).sin();
    }
    b * s
}

fn fresh(sr: f32, hz: f32, b: f32) -> Finnwave {
    let mut o = Finnwave::new(sr);
    o.set_freq_hz(hz);
    o.set_rolloff(b);
    o.set_amp(1.0);
    o.snap_params();
    o
}

#[test]
fn matches_brute_force_additive_sum() {
    let sr = 48000.0f32;
    // Mix of low/mid/high pitches and dull/bright rolloffs; includes r ~ 0 and r ~ 1 cases.
    for (hz, b) in [(55.0, 0.02), (440.0, 0.3), (1000.0, 0.001), (3333.0, 1.0), (5000.0, 0.05), (12000.0, 0.2), (23999.0, 0.1)] {
        let mut o = fresh(sr, hz, b);
        let mut buf = vec![0.0f32; 4096];
        o.render_add(&mut buf);
        let f = hz as f64 / sr as f64;
        let mut max_err = 0.0f64;
        for (n, y) in buf.iter().enumerate() {
            // The oscillator outputs the sample *at* phase n*f (first sample is phase 0).
            let want = brute_force(f, b as f64, n as f64 * f);
            max_err = max_err.max((*y as f64 - want).abs());
        }
        println!("finnwave {hz:>7} Hz b={b:<6} max |closed-form - additive| = {max_err:.2e}");
        assert!(max_err < 1e-4, "{hz} Hz b={b}: {max_err}");
    }
}

/// Energy (dB re fundamental) at non-harmonic bins. `hz` must give an integer number of cycles
/// in `sr` samples, so every harmonic sits exactly on a 1 Hz bin and no window is needed.
fn alias_floor_db(sr: f32, hz: u32, b: f32) -> (f64, usize) {
    let mut o = fresh(sr, hz as f32, b);
    let n = sr as usize;
    let mut buf = vec![0.0f32; n];
    o.render_add(&mut buf);
    let mut spec: Vec<Complex<f64>> = buf.iter().map(|&x| Complex::new(x as f64, 0.0)).collect();
    FftPlanner::new().plan_fft_forward(n).process(&mut spec);
    let mag = |k: usize| spec[k].norm();
    let fund = mag(hz as usize);
    let (mut worst, mut worst_bin) = (0.0f64, 0);
    let mut harmonics = 0;
    for k in 1..n / 2 {
        if k % hz as usize == 0 {
            harmonics += 1;
            continue;
        }
        if mag(k) > worst {
            worst = mag(k);
            worst_bin = k;
        }
    }
    println!("  ({harmonics} harmonics below Nyquist; worst non-harmonic bin {worst_bin} Hz)");
    (20.0 * (worst / fund).log10(), harmonics)
}

#[test]
fn no_aliasing_at_non_harmonic_bins() {
    // 0.5/f = 4.8 for the first: N=4 with a large fractional part (a naive "fade in harmonic
    // N+1" crossfade would alias right here).
    for (sr, hz, b) in [(48000.0, 5000, 0.001), (48000.0, 5000, 0.3), (44100.0, 3000, 0.01), (48000.0, 11000, 0.05)] {
        println!("finnwave alias test: {hz} Hz @ {sr} Hz, b={b}");
        let (db, _) = alias_floor_db(sr, hz, b);
        println!("  non-harmonic floor: {db:.1} dB re fundamental");
        assert!(db < -90.0, "{db} dB");
    }
}

#[test]
fn exponential_sweep_has_no_discontinuities() {
    let sr = 48000.0f32;
    let b = 0.02f64; // bright, so the top harmonics carry real energy: dropouts would be loud
    let (f0, f1, secs) = (50.0f64, 15000.0f64, 2.0f64);
    let total = (secs * sr as f64) as usize;
    let mut o = Finnwave::new(sr);
    o.set_rolloff(b as f32);
    o.set_amp(1.0);
    o.snap_params();

    let mut y = vec![0.0f32; total];
    let mut freqs = vec![0.0f64; total / SUB_BLOCK + 1]; // cycles/sample per sub-block
    for (i, chunk) in y.chunks_mut(SUB_BLOCK).enumerate() {
        let t = (i * SUB_BLOCK) as f64 / sr as f64;
        let hz = f0 * (f1 / f0).powf(t / secs);
        // Store cycles/sample exactly as the oscillator derives it (f32 Hz -> f64 / sr).
        freqs[i] = (hz as f32) as f64 / sr as f64;
        o.set_freq_hz(hz as f32);
        o.render_add(chunk);
    }

    // (a) Slope bound. y = b sum w_k e^{-kb} sin(k theta), so between adjacent samples
    //     |dy| <= b sum_k w_k e^{-kb} * 2|sin(k pi f)| <= 2 pi f b sum_k k e^{-kb}
    //     (+ a small allowance for f and the top-harmonic weight changing between samples).
    //     A discontinuity from a harmonic appearing/vanishing would not respect this
    //     bound in general, and any NaN or glitch from re-seeding would be far above it.
    let mut worst_ratio = 0.0f64;
    for i in 1..total {
        let f = freqs[i / SUB_BLOCK];
        let n = (0.5 / f).floor() as usize;
        let bound: f64 = 2.0 * std::f64::consts::PI * f * b * (1..=n).map(|k| k as f64 * (-(k as f64) * b).exp()).sum::<f64>();
        let d = (y[i] as f64 - y[i - 1] as f64).abs();
        worst_ratio = worst_ratio.max(d / bound.max(1e-9));
        assert!(d <= 1.02 * bound + 1e-5, "jump {d} at sample {i} (bound {bound}, {} Hz)", f * sr as f64);
    }
    println!("finnwave sweep 50 Hz -> 15 kHz, 2 s: worst |dy| / slope bound = {worst_ratio:.3}");

    // (b) The bound is loose for steep edges, so also compare against the additive reference,
    //     which is continuous by construction (harmonic weights are continuous in f).
    //     Reconstruct the phase exactly as the oscillator accumulates it.
    let mut p = 0.0f64;
    let mut max_err = 0.0f64;
    for (n, yn) in y.iter().enumerate() {
        let f = freqs[n / SUB_BLOCK];
        if n % 7 == 0 {
            max_err = max_err.max((*yn as f64 - brute_force(f, b, p)).abs());
        }
        p += f;
    }
    println!("finnwave sweep: max |render - additive reference| = {max_err:.2e}");
    assert!(max_err < 1e-4);
}
