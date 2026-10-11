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
//!
//! The curve itself is [`Saturator`], which the tape delay also runs in its feedback loop (with a
//! different output gain: see [`Saturator::unity_gain`]).

use crate::smooth::Ramp;
use crate::svf::Svf;

/// The filter range in Hz; at the top it is bypassed.
pub const CUTOFF_MIN: f32 = 200.0;
pub const CUTOFF_MAX: f32 = 20000.0;
const GLIDE_S: f64 = 0.03;
/// The filter coefficients are recomputed every this many samples.
const COEF_EVERY: usize = 8;

/// The soft-clip curve `tanh(d*x + b) - tanh(b)` for a drive of 0..1: `d = 1 + 9*drive` and
/// `b = 0.25*drive`. The output is not scaled; pick a gain for the use.
#[derive(Clone, Copy, Debug)]
pub struct Saturator {
    d: f32,
    bias: f32,
    off: f32,
}

impl Saturator {
    pub fn new(drive: f32) -> Self {
        let (d, bias) = (1.0 + 9.0 * drive, 0.25 * drive);
        Self { d, bias, off: bias.tanh() }
    }

    #[inline]
    pub fn shape(&self, x: f32) -> f32 {
        (self.d * x + self.bias).tanh() - self.off
    }

    /// `1/sqrt(d)`: keeps the level of a loud signal roughly steady as the drive rises (the
    /// looper's tape colour).
    #[inline]
    pub fn level_gain(&self) -> f32 {
        1.0 / self.d.sqrt()
    }

    /// The reciprocal of the curve's slope at zero, so small signals pass at exactly unity and
    /// only the peaks are held back (to about `1/d`). For use inside a feedback loop, where the
    /// small-signal gain decides whether the tail decays.
    #[inline]
    pub fn unity_gain(&self) -> f32 {
        let t = self.bias.tanh();
        1.0 / (self.d * (1.0 - t * t))
    }
}

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
                let sat = Saturator::new(drive);
                let norm = sat.level_gain();
                a = sat.shape(a) * norm;
                b = sat.shape(b) * norm;
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
    fn the_unity_gain_curve_passes_small_signals_untouched_and_holds_peaks() {
        for drive in [0.0f32, 0.3, 1.0] {
            let s = Saturator::new(drive);
            let g = s.unity_gain();
            let small = 1e-4f32;
            assert!((s.shape(small) * g / small - 1.0).abs() < 1e-3, "drive {drive}");
            assert!(s.shape(10.0) * g <= 1.0 / (1.0 + 9.0 * drive) + 1e-6, "drive {drive}: peaks not held");
        }
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
