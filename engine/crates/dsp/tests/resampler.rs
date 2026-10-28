//! Frequency response and spur measurements of the resampler designs: for sine tones through the
//! resampler at several speeds, the gain at the expected output tone and the worst other
//! component (images / aliases / interpolation spurs). Run with `-- --nocapture` for the tables.

use dsp::Resampler;
use rustfft::{num_complex::Complex, FftPlanner};
use std::f64::consts::TAU;

const SR: f64 = 48000.0;
const N_OUT: usize = 16384;
const SKIP: usize = 3000;

fn run(r: &mut Resampler, f: f64, speed: f64) -> Vec<f64> {
    let n_in = ((SKIP + N_OUT) as f64 * speed.max(1.0)) as usize + 64;
    let x: Vec<f32> = (0..n_in).map(|i| (TAU * f * i as f64 / SR).sin() as f32).collect();
    let mut inp = |i: i64| {
        let v = x[i.clamp(0, n_in as i64 - 1) as usize];
        (v, v)
    };
    let scale = (1.0 / speed).min(1.0) as f32;
    let mut pos = 0.37;
    r.restart(0);
    let mut y = Vec::with_capacity(N_OUT);
    for k in 0..SKIP + N_OUT {
        pos += speed;
        let a = r.advance(&mut inp, pos, scale).0 as f64;
        if k >= SKIP {
            y.push(a);
        }
    }
    y
}

fn tone_db(y: &[f64], fo: f64) -> f64 {
    let n = y.len();
    let om = TAU * fo / SR;
    let (mut s, mut c) = (0.0, 0.0);
    for (i, v) in y.iter().enumerate() {
        let w = 0.5 - 0.5 * (TAU * i as f64 / n as f64).cos();
        s += v * w * (om * i as f64).sin();
        c += v * w * (om * i as f64).cos();
    }
    20.0 * ((s * s + c * c).sqrt() * 4.0 / n as f64).max(1e-12).log10()
}

/// (gain at the output tone in dB if it is below Nyquist, worst other spectral line in dB).
pub fn measure(make: &dyn Fn() -> Resampler, f: f64, speed: f64) -> (Option<f64>, f64) {
    let y = run(&mut make(), f, speed);
    let n = y.len();
    let fo = f * speed;
    let fo_a = {
        let m = fo.rem_euclid(SR);
        if m > SR / 2.0 { SR - m } else { m }
    };
    let mut buf: Vec<Complex<f64>> = y
        .iter()
        .enumerate()
        .map(|(i, v)| Complex::new(v * (0.5 - 0.5 * (TAU * i as f64 / n as f64).cos()), 0.0))
        .collect();
    FftPlanner::new().plan_fft_forward(n).process(&mut buf);
    let mut worst = -300.0f64;
    for (k, c) in buf.iter().enumerate().take(n / 2) {
        let g = k as f64 * SR / n as f64;
        if g < 40.0 || g > SR / 2.0 - 20.0 || (fo < SR / 2.0 && (g - fo_a).abs() < 250.0) {
            continue;
        }
        worst = worst.max(20.0 * (c.norm() * 4.0 / n as f64).max(1e-12).log10());
    }
    ((fo < SR / 2.0).then(|| tone_db(&y, fo)), worst)
}

const TONES: [f64; 8] = [1000.0, 5000.0, 8000.0, 12000.0, 15000.0, 17000.0, 19000.0, 21000.0];
const SPEEDS: [f64; 4] = [0.73, 1.0, 1.37, 2.0];

/// Tones at exactly Nyquist after the speed change are degenerate (a sine sampled at its zero crossings).
fn degenerate(f: f64, speed: f64) -> bool {
    (f * speed - SR / 2.0).abs() < 300.0
}

fn table(name: &str, make: &dyn Fn() -> Resampler) -> Vec<(f64, f64, Option<f64>, f64)> {
    println!("== {name}");
    let mut rows = vec![];
    for speed in SPEEDS {
        let mut line = format!("  speed {speed:>4}:");
        for f in TONES {
            if degenerate(f, speed) {
                continue;
            }
            let (g, w) = measure(make, f, speed);
            line += &match g {
                Some(g) => format!(" {:>5.0}Hz {:>6.1}/{:>5.0}", f * speed, g, w),
                None => format!(" {:>5.0}Hz   --  /{:>5.0}", f * speed, w),
            };
            rows.push((speed, f, g, w));
        }
        println!("{line}");
    }
    rows
}

#[test]
fn clean_design_response() {
    let rows = table("clean (cheby1 N7 0.5 dB, FOH)", &Resampler::clean);
    for (speed, f, g, w) in rows {
        // Alias / image rejection at every speed.
        assert!(w < -45.0, "speed {speed} tone {f}: spur {w:.1} dB");
        // Within 1 dB to 8 kHz at speed 1 (and where the filter moves with the speed, it stays
        // within the same shape: check the tones that are inside the passband).
        if let Some(g) = g {
            if speed == 1.0 && f <= 8000.0 {
                assert!(g.abs() < 1.0, "speed 1 tone {f}: gain {g:.2} dB");
            }
            if speed < 1.0 && f * speed <= 14000.0 && f <= 8000.0 {
                assert!(g.abs() < 1.0, "speed {speed} tone {f}: gain {g:.2} dB");
            }
        }
    }
}

#[test]
fn vintage_design_response() {
    let rows = table("vintage (cheby1 N5 2 dB, ZOH)", &Resampler::new);
    // Today's measured response at speed 1 (Taylor-stepped filter): 1k -0.9, 5k -0.7, 8k -7.1,
    // 12k -36.6 dB.
    for (speed, f, g, w) in rows {
        assert!(w < -75.0, "speed {speed} tone {f}: spur {w:.1} dB");
        if speed == 1.0 {
            let want = match f as i64 {
                1000 => -0.9,
                5000 => -0.7,
                8000 => -7.1,
                12000 => -36.6,
                _ => continue,
            };
            let tol = if f > 10000.0 { 1.5 } else { 0.3 };
            assert!((g.unwrap() - want).abs() < tol, "tone {f}: {:.2} vs {want}", g.unwrap());
        }
    }
}

#[test]
fn restart_with_warmup_rebuilds_the_same_output() {
    let f = |i: i64| {
        let t = i as f64 / SR;
        ((TAU * 700.0 * t).sin() * 0.6 + (TAU * 5300.0 * t).sin() * 0.3) as f32
    };
    let mut inp = |i: i64| (f(i), f(i));
    for speed in [0.73f64, 1.0, 2.5] {
        let scale = (1.0 / speed).min(1.0) as f32;
        let mut cont = Resampler::clean();
        cont.restart(-3000);
        let mut fresh = Resampler::clean();
        let mut worst = 0.0f32;
        let mut pos = 100.25;
        for k in 0..2000 {
            pos += speed;
            let a = cont.advance(&mut inp, pos, scale).0;
            if k == 0 {
                // jump: rebuild from the warmup before the position, as the looper does
                fresh.restart(pos.floor() as i64 - fresh.warmup(speed));
            }
            let b = fresh.advance(&mut inp, pos, scale).0;
            if k > 0 {
                worst = worst.max((a - b).abs());
            }
        }
        println!("speed {speed}: restart vs continuous max diff {worst:e}");
        assert!(worst < 2e-4, "speed {speed}: {worst}");
    }
}

#[test]
fn fractional_reads_do_not_disturb_the_state() {
    let f = |i: i64| ((TAU * 1500.0 * i as f64 / SR).sin() as f32, 0.0f32);
    let mut inp = |i: i64| f(i);
    let mut a = Resampler::clean();
    let mut b = Resampler::clean();
    a.restart(-500);
    b.restart(-500);
    let mut pos = 0.0;
    for _ in 0..500 {
        pos += 0.37;
        let ya = a.advance(&mut inp, pos, 1.0).0;
        b.advance(&mut inp, pos - 0.1, 1.0);
        let yb = b.advance(&mut inp, pos, 1.0).0;
        assert!((ya - yb).abs() < 1e-4, "{ya} {yb}");
    }
}

fn sine_hash(design: fn() -> Resampler) -> u64 {
    let mut inp = |i: i64| {
        let v = (TAU * 1500.0 * i as f64 / SR).sin() as f32;
        (v, v * 0.5)
    };
    let mut r = design();
    r.restart(-500);
    let (mut pos, mut h) = (0.0, 0xcbf29ce484222325u64);
    for _ in 0..5000 {
        pos += 0.73;
        let (l, rr) = r.advance(&mut inp, pos, 1.0);
        for b in [l.to_bits(), rr.to_bits()] {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    h
}

/// Output for a normal signal is bit-identical to the pre-flush implementation (recorded before the change).
#[test]
fn flush_leaves_normal_signals_bit_identical() {
    assert_eq!(sine_hash(Resampler::new), 764512334101299919);
    assert_eq!(sine_hash(Resampler::clean), 3326996116094877099);
}

#[test]
fn silent_input_decays_to_exact_zero_without_subnormals() {
    for design in [Resampler::new, Resampler::clean] {
        let mut r = design();
        let mut inp = |i: i64| if i == 0 { (1.0, 1.0) } else { (0.0, 0.0) };
        r.restart(-4);
        let mut pos = -4.0;
        let mut zero_at = None;
        for n in 0..2_000_000 {
            pos += 1.0;
            let (l, rr) = r.advance(&mut inp, pos, 1.0);
            assert!(!l.is_subnormal() && !rr.is_subnormal(), "subnormal output at step {n}");
            if n > 100 && l == 0.0 && rr == 0.0 {
                zero_at = Some(n);
                break;
            }
        }
        let n = zero_at.expect("output never reached exactly 0");
        println!("resampler impulse response reached exactly 0.0 after {n} steps");
    }
}
