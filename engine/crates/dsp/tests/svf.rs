use dsp::Svf;
use std::f64::consts::TAU;

const SR: f32 = 48000.0;
const BUTTERWORTH: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// Steady-state gain in dB of one SVF output for a sine at `freq_hz`.
/// Runs a sine through the filter, discards the transient, and compares RMS in/out.
fn gain_db(freq_hz: f64, cutoff_hz: f32, damping: f32, pick: impl Fn(&Svf) -> f32) -> f64 {
    let mut f = Svf::new();
    f.set_hz(cutoff_hz, damping, SR);
    let (settle, measure) = (50_000, 200_000);
    let (mut e_in, mut e_out) = (0.0f64, 0.0f64);
    for n in 0..settle + measure {
        let x = (TAU * freq_hz / SR as f64 * n as f64).sin() as f32;
        f.process(x);
        if n >= settle {
            e_in += (x as f64).powi(2);
            e_out += (pick(&f) as f64).powi(2);
        }
    }
    10.0 * (e_out / e_in).log10()
}

#[test]
fn lowpass_is_minus_3db_at_cutoff_including_near_nyquist() {
    // Bilinear pre-warping puts the -3.01 dB point exactly at the cutoff for any cutoff.
    let want = -10.0 * 2f64.log10(); // -3.0103 dB
    for fc in [100.0f32, 1000.0, 5000.0, 12000.0, 18000.0, 22000.0, 23500.0] {
        let got = gain_db(fc as f64, fc, BUTTERWORTH, |f| f.lp());
        println!("svf LP @ {fc:>7.0} Hz (SR 48k, R=1/sqrt2): {got:+.4} dB (want {want:+.4})");
        assert!((got - want).abs() < 0.01, "fc={fc}: {got} dB");
    }
}

#[test]
fn lowpass_without_prewarp_would_be_wrong_so_prewarp_is_doing_work() {
    // Sanity: using the *unwarped* g = w0/2 near Nyquist puts the -3 dB point elsewhere.
    let fc = 20000.0f32;
    let w0 = TAU as f32 * fc / SR;
    let mut f = Svf::new();
    f.set(w0, BUTTERWORTH); // no tan(): deliberately wrong
    let (mut e_in, mut e_out) = (0.0, 0.0);
    for n in 0..250_000 {
        let x = (TAU * fc as f64 / SR as f64 * n as f64).sin() as f32;
        f.process(x);
        if n >= 50_000 {
            e_in += (x as f64).powi(2);
            e_out += (f.lp() as f64).powi(2);
        }
    }
    let db = 10.0 * (e_out / e_in as f64).log10();
    println!("svf LP @ 20 kHz with *no* prewarp: {db:+.2} dB (vs -3.01 prewarped)");
    assert!((db + 3.0103).abs() > 1.0);
}

#[test]
fn set_exact_matches_set_hz() {
    let fc = 7000.0f32;
    let a = gain_db(fc as f64, fc, BUTTERWORTH, |f| f.lp());
    let mut f = Svf::new();
    f.set_exact(TAU as f32 * fc / SR, BUTTERWORTH);
    let (mut e_in, mut e_out) = (0.0, 0.0);
    for n in 0..250_000 {
        let x = (TAU * fc as f64 / SR as f64 * n as f64).sin() as f32;
        f.process(x);
        if n >= 50_000 {
            e_in += (x as f64).powi(2);
            e_out += (f.lp() as f64).powi(2);
        }
    }
    let b = 10.0 * (e_out / e_in as f64).log10();
    assert!((a - b).abs() < 0.01, "{a} vs {b}");
}

#[test]
fn hp_bp_notch_peak_sanity() {
    let fc = 2000.0f32;
    let r = BUTTERWORTH;
    let three = -3.0103;
    // At the cutoff HP and BP are both 1/(2R) = -3.01 dB.
    let hp = gain_db(fc as f64, fc, r, |f| f.hp());
    let bp = gain_db(fc as f64, fc, r, |f| f.bp());
    println!("svf @ cutoff: HP {hp:+.3} dB, BP {bp:+.3} dB");
    assert!((hp - three).abs() < 0.01 && (bp - three).abs() < 0.01);
    // Passbands: LP at 1/100 of cutoff ~0 dB, HP at 100x cutoff ~0 dB, and the stopband slopes.
    assert!(gain_db(20.0, fc, r, |f| f.lp()).abs() < 0.01);
    assert!(gain_db(20000.0, fc, r, |f| f.hp()).abs() < 1.0); // 10x cutoff, near Nyquist
    let lp_oct = gain_db(8000.0, fc, r, |f| f.lp()); // two octaves up: ~ -24 dB (12 dB/oct)
    println!("svf LP two octaves above cutoff: {lp_oct:+.2} dB");
    assert!(lp_oct < -22.0 && lp_oct > -26.0);
    // Notch is a null at the cutoff; peak has gain 1/R (+3.01 dB for Butterworth).
    let notch = gain_db(fc as f64, fc, r, |f| f.notch());
    let peak = gain_db(fc as f64, fc, r, |f| f.peak());
    println!("svf @ cutoff: notch {notch:+.1} dB, peak {peak:+.3} dB");
    assert!(notch < -60.0);
    assert!((peak - 3.0103).abs() < 0.01);
    // Away from cutoff the notch passes signal.
    assert!(gain_db(200.0, fc, r, |f| f.notch()).abs() < 0.2);
}

/// Tiny xorshift RNG so the tests need no `rand` dependency and are deterministic.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64 // [0, 1)
    }
}

#[test]
fn stable_under_per_sample_random_modulation_of_cutoff_and_damping() {
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let mut f = Svf::new();
    let mut peak = [0.0f32; 3];
    for _ in 0..(10 * 48000) {
        let x = (rng.next() * 2.0 - 1.0) as f32;
        let cutoff = 20.0 * (1000.0f64).powf(rng.next()); // log-uniform 20 Hz .. 20 kHz
        let damping = 0.05 + 1.95 * rng.next() as f32; // 0.05 .. 2
        f.set_hz(cutoff as f32, damping, SR);
        f.process(x);
        for (p, v) in peak.iter_mut().zip([f.lp(), f.bp(), f.hp()]) {
            assert!(v.is_finite());
            *p = p.max(v.abs());
        }
    }
    println!("svf 10 s noise, random cutoff+damping per sample: peak |lp|,|bp|,|hp| = {peak:?}");
    assert!(peak.iter().all(|&p| p < 100.0));
}

#[test]
fn denormals_are_flushed_to_exact_zero_in_finite_time() {
    let mut f = Svf::new();
    f.set_hz(1000.0, 0.5, SR);
    f.process(1.0);
    let mut settled_at = None;
    for n in 0..2_000_000 {
        f.process(0.0);
        for v in [f.lp(), f.bp(), f.hp()] {
            assert!(!v.is_subnormal(), "subnormal at sample {n}");
        }
        if f.lp() == 0.0 && f.bp() == 0.0 && f.hp() == 0.0 {
            settled_at = Some(n);
            break;
        }
    }
    let n = settled_at.expect("state never reached exactly 0");
    println!("svf impulse response reached exactly 0.0 after {n} samples ({:.2} s)", n as f64 / 48000.0);
}
