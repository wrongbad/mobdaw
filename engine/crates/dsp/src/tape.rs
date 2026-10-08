//! Tape colour for a looper: a soft-clip saturator followed by a low-pass, per channel.
//!
//! ```text
//!   x -> tanh(d*x + b) - tanh(b), / sqrt(d)  -> low-pass (cutoff) -> out
//! ```
//!
//! `drive` (0..1) maps to `d = 1 + 9*drive`; the small bias `b` makes the curve asymmetric, which
//! adds even harmonics like a tape head does. `1/sqrt(d)` keeps the level roughly steady as the
//! drive rises. At `drive = 0` and a fully open filter the stage is skipped (bit-exact bypass).
//! Both controls glide, so a knob move never zippers.

use crate::smooth::Ramp;
use crate::svf::Svf;

/// The filter range in Hz; at the top it is bypassed.
pub const CUTOFF_MIN: f32 = 200.0;
pub const CUTOFF_MAX: f32 = 20000.0;
const GLIDE_S: f64 = 0.03;
/// The filter coefficients are recomputed every this many samples.
const COEF_EVERY: usize = 8;

#[derive(Clone, Debug)]
pub struct TapeColor {
    drive: Ramp,
    /// log2 of the cutoff in Hz.
    log_cutoff: Ramp,
    l: Svf,
    r: Svf,
    filtering: bool,
}

impl Default for TapeColor {
    fn default() -> Self {
        Self { drive: Ramp::new(0.0), log_cutoff: Ramp::new((CUTOFF_MAX as f64).log2()), l: Svf::new(), r: Svf::new(), filtering: false }
    }
}

impl TapeColor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the targets: `drive` 0..1, `cutoff_hz` clamped to the filter range. `snap` jumps there
    /// (a freshly loaded looper) instead of gliding.
    pub fn set(&mut self, drive: f32, cutoff_hz: f32, sample_rate: f64, snap: bool) {
        let drive = if drive.is_finite() { drive.clamp(0.0, 1.0) } else { 0.0 };
        let cutoff = if cutoff_hz.is_finite() { cutoff_hz.clamp(CUTOFF_MIN, CUTOFF_MAX) } else { CUTOFF_MAX };
        let n = GLIDE_S * sample_rate;
        self.drive.set_target(drive as f64, n);
        self.log_cutoff.set_target((cutoff as f64).log2(), n);
        if snap {
            self.drive.snap();
            self.log_cutoff.snap();
        }
    }

    /// Process `l`/`r` in place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f64) {
        let open = (CUTOFF_MAX as f64).log2();
        let idle = |d: &Ramp, c: &Ramp| d.value() == 0.0 && d.target() == 0.0 && c.value() >= open && c.target() >= open;
        if idle(&self.drive, &self.log_cutoff) {
            self.filtering = false;
            return;
        }
        if !self.filtering {
            // coming out of bypass: don't let stale filter state ring in
            self.l.reset();
            self.r.reset();
            self.filtering = true;
        }
        for k in 0..l.len().min(r.len()) {
            let drive = self.drive.value() as f32;
            let lc = self.log_cutoff.value();
            self.drive.advance(1);
            self.log_cutoff.advance(1);
            if k % COEF_EVERY == 0 {
                let hz = lc.exp2() as f32;
                self.l.set_hz(hz, std::f32::consts::FRAC_1_SQRT_2, sample_rate as f32);
                self.r.set_hz(hz, std::f32::consts::FRAC_1_SQRT_2, sample_rate as f32);
            }
            let (mut a, mut b) = (l[k], r[k]);
            if drive > 0.0 {
                let d = 1.0 + 9.0 * drive;
                let bias = 0.25 * drive;
                let (norm, off) = (1.0 / d.sqrt(), bias.tanh());
                a = ((d * a + bias).tanh() - off) * norm;
                b = ((d * b + bias).tanh() - off) * norm;
            }
            l[k] = self.l.process(a).lp();
            r[k] = self.r.process(b).lp();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f64 = 48000.0;

    fn sine(f: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (0.5 * (std::f64::consts::TAU * f * i as f64 / SR).sin()) as f32).collect()
    }
    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn defaults_are_a_bit_exact_bypass() {
        let mut t = TapeColor::new();
        let x = sine(440.0, 512);
        let (mut l, mut r) = (x.clone(), x.clone());
        t.process(&mut l, &mut r, SR);
        assert_eq!(l, x);
        assert_eq!(r, x);
    }

    #[test]
    fn the_filter_darkens_and_the_drive_adds_harmonics() {
        let mut t = TapeColor::new();
        t.set(0.0, 500.0, SR, true);
        let x = sine(8000.0, 4096);
        let (mut l, mut r) = (x.clone(), x.clone());
        t.process(&mut l, &mut r, SR);
        assert!(rms(&l[1024..]) < 0.05 * rms(&x[1024..]), "8 kHz through a 500 Hz low-pass");

        // saturating a 1 kHz sine puts energy at 3 kHz (odd harmonic) that a clean one lacks
        let bin = |y: &[f32], f: f64| {
            let w = std::f64::consts::TAU * f / SR;
            let (s, c) = y.iter().enumerate().fold((0.0, 0.0), |(s, c), (i, v)| (s + *v as f64 * (w * i as f64).sin(), c + *v as f64 * (w * i as f64).cos()));
            (s * s + c * c).sqrt() / y.len() as f64
        };
        let mut t = TapeColor::new();
        t.set(1.0, CUTOFF_MAX, SR, true);
        let x = sine(1000.0, 4800);
        let (mut l, mut r) = (x.clone(), x.clone());
        t.process(&mut l, &mut r, SR);
        assert!(bin(&l, 3000.0) > 20.0 * bin(&x, 3000.0).max(1e-6), "no harmonics");
        assert!(rms(&l).is_finite() && l.iter().all(|v| v.abs() < 2.0));
    }
}
