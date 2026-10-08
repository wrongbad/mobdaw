//! A stereo-linked feed-forward compressor with a soft knee.
//!
//! ```text
//!   level = max(|l|, |r|) -> dB -> gain computer (threshold, ratio, knee) -> reduction in dB
//!   reduction -> attack/release smoothing -> gain = 10^((makeup - reduction) / 20) on both channels
//! ```
//!
//! Both channels share one gain so the stereo image doesn't shift. The smoothing runs on the
//! reduction in dB (rises with `attack`, falls with `release`), which is the usual "smooth
//! decoupled" detector. With the signal under the threshold and no makeup the gain is exactly 1.

use crate::util::flush_denormal;

pub const THRESHOLD_MIN: f32 = -60.0;
pub const THRESHOLD_MAX: f32 = 0.0;
pub const RATIO_MIN: f32 = 1.0;
pub const RATIO_MAX: f32 = 20.0;
pub const ATTACK_MIN_MS: f32 = 0.1;
pub const ATTACK_MAX_MS: f32 = 100.0;
pub const RELEASE_MIN_MS: f32 = 10.0;
pub const RELEASE_MAX_MS: f32 = 1000.0;
pub const MAKEUP_MAX: f32 = 24.0;
/// Width of the soft knee in dB, centred on the threshold.
const KNEE_DB: f32 = 6.0;
/// Level floor so silence doesn't take `ln` to -inf.
const FLOOR: f32 = 1e-6;
const DB_PER_NEPER: f32 = 8.685_89; // 20 / ln(10)

#[derive(Clone, Copy, Debug)]
pub struct CompParams {
    pub threshold_db: f32,
    pub ratio: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
}

impl Default for CompParams {
    fn default() -> Self {
        Self { threshold_db: -18.0, ratio: 4.0, attack_ms: 10.0, release_ms: 100.0, makeup_db: 0.0 }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Compressor {
    /// Smoothed gain reduction in dB (>= 0).
    reduction: f32,
}

impl Compressor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.reduction = 0.0;
    }

    /// The current gain reduction in dB (for metering).
    pub fn reduction_db(&self) -> f32 {
        self.reduction
    }

    /// Static curve: dB of reduction for an input level in dB.
    #[inline]
    fn computer(level_db: f32, threshold: f32, slope: f32) -> f32 {
        let over = level_db - threshold;
        if 2.0 * over <= -KNEE_DB {
            0.0
        } else if 2.0 * over < KNEE_DB {
            let k = over + 0.5 * KNEE_DB;
            slope * k * k / (2.0 * KNEE_DB)
        } else {
            slope * over
        }
    }

    /// Process `l`/`r` in place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], p: &CompParams, sample_rate: f32) {
        let threshold = p.threshold_db.clamp(THRESHOLD_MIN, THRESHOLD_MAX);
        let ratio = p.ratio.clamp(RATIO_MIN, RATIO_MAX);
        let slope = 1.0 - 1.0 / ratio;
        let coef = |ms: f32| (-1.0 / (ms.max(1e-3) * 1e-3 * sample_rate)).exp();
        let attack = coef(p.attack_ms.clamp(ATTACK_MIN_MS, ATTACK_MAX_MS));
        let release = coef(p.release_ms.clamp(RELEASE_MIN_MS, RELEASE_MAX_MS));
        let makeup = p.makeup_db.clamp(0.0, MAKEUP_MAX);

        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let level_db = DB_PER_NEPER * a.abs().max(b.abs()).max(FLOOR).ln();
            let target = Self::computer(level_db, threshold, slope);
            let c = if target > self.reduction { attack } else { release };
            self.reduction = flush_denormal(target + c * (self.reduction - target));
            let gain = ((makeup - self.reduction) / DB_PER_NEPER).exp();
            *a *= gain;
            *b *= gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f32 = 48000.0;

    fn sine(amp: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| amp * (std::f32::consts::TAU * 440.0 * i as f32 / SR).sin()).collect()
    }
    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0, |m, v| m.max(v.abs()))
    }
    fn run(amp: f32, p: &CompParams) -> Vec<f32> {
        let mut c = Compressor::new();
        let x = sine(amp, 24000);
        let (mut l, mut r) = (x.clone(), x);
        c.process(&mut l, &mut r, p, SR);
        l
    }

    #[test]
    fn under_the_threshold_it_is_transparent() {
        let p = CompParams { threshold_db: -20.0, ..Default::default() };
        let x = sine(0.01, 24000); // -40 dB
        assert_eq!(run(0.01, &p), x);
    }

    #[test]
    fn over_the_threshold_it_follows_the_ratio() {
        // 0 dBFS peak, threshold -20, ratio 4: 20 dB over -> 15 dB of reduction, so about -15 dB out
        let p = CompParams { threshold_db: -20.0, ratio: 4.0, attack_ms: 0.1, release_ms: 100.0, makeup_db: 0.0 };
        let y = run(1.0, &p);
        let out_db = 20.0 * peak(&y[12000..]).log10();
        assert!((out_db + 15.0).abs() < 1.5, "settled output {out_db} dB");
    }

    #[test]
    fn makeup_raises_the_level_and_the_channels_share_one_gain() {
        let p = CompParams { threshold_db: 0.0, makeup_db: 6.0, ..Default::default() };
        let mut c = Compressor::new();
        let (mut l, mut r) = (vec![0.01; 256], vec![0.005; 256]);
        c.process(&mut l, &mut r, &p, SR);
        assert!((l[255] / 0.01 - 1.995).abs() < 0.01);
        assert!((l[255] / r[255] - 2.0).abs() < 1e-4, "stereo balance preserved");
    }

    #[test]
    fn it_releases_after_a_loud_burst_and_stays_finite() {
        let p = CompParams { release_ms: 10.0, ..Default::default() };
        let mut c = Compressor::new();
        let (mut l, mut r) = (sine(1.0, 4800), sine(1.0, 4800));
        c.process(&mut l, &mut r, &p, SR);
        assert!(c.reduction_db() > 5.0);
        let (mut l, mut r) = (vec![0.0; 9600], vec![0.0; 9600]);
        c.process(&mut l, &mut r, &p, SR);
        assert!(c.reduction_db() < 0.1 && l.iter().all(|v| v.is_finite()));
    }
}
