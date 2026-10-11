//! Tape-transport wobble, shared by the looper (as a speed deviation) and the tape delay (as a
//! delay-time deviation): a slow *wow* (~0.7 Hz), a faster *flutter* (~7 Hz) and a slow random
//! drift. At unit depth the pitch swings about +-30 cents.
//!
//! Both views come from the same phases and agree with each other: a read head that moves at
//! `2^octaves()` of normal speed sees its delay change at `1 - 2^octaves()` per sample, and
//! [`Warble::delay_seconds`] is the integral of that (to first order), so a delay line whose time
//! is offset by it has the same pitch wobble the looper's head has.

use std::f64::consts::{LN_2, TAU};

/// Warble LFO rates (Hz) and the peak deviation of each at full depth (octaves; 0.01 = 12 cents).
const WOW_HZ: f64 = 0.7;
const FLUTTER_HZ: f64 = 7.1;
const DRIFT_HZ: f64 = 0.23;
/// The drift is two incommensurate sines (the second this many times faster), so it doesn't
/// audibly repeat.
const DRIFT_RATIO: f64 = 2.618;
const WOW_OCT: f64 = 0.0125;
const FLUTTER_OCT: f64 = 0.004;
const DRIFT_OCT: f64 = 0.006;

/// LFO phases, in cycles. All start at 0.
#[derive(Clone, Debug, Default)]
pub struct Warble {
    wow: f64,
    flutter: f64,
    drift: f64,
    drift2: f64,
}

impl Warble {
    pub fn new() -> Self {
        Self::default()
    }

    /// Step the phases by one sample (`inv_sr` = 1 / sample rate).
    #[inline]
    pub fn advance(&mut self, inv_sr: f64) {
        self.wow = (self.wow + WOW_HZ * inv_sr).fract();
        self.flutter = (self.flutter + FLUTTER_HZ * inv_sr).fract();
        self.drift = (self.drift + DRIFT_HZ * inv_sr).fract();
        self.drift2 = (self.drift2 + DRIFT_HZ * DRIFT_RATIO * inv_sr).fract();
    }

    /// The pitch deviation at unit depth, in octaves.
    #[inline]
    pub fn octaves(&self) -> f64 {
        let d = 0.5 * ((self.drift * TAU).sin() + (self.drift2 * TAU).sin());
        WOW_OCT * (self.wow * TAU).sin() + FLUTTER_OCT * (self.flutter * TAU).sin() + DRIFT_OCT * d
    }

    /// The delay-time deviation at unit depth, in seconds, whose rate of change gives the pitch
    /// deviation of [`octaves`](Self::octaves): `d/dt delay = -ln2 * octaves`.
    #[inline]
    pub fn delay_seconds(&self) -> f64 {
        let part = |oct: f64, hz: f64, phase: f64| LN_2 * oct / (TAU * hz) * (phase * TAU).cos();
        part(WOW_OCT, WOW_HZ, self.wow)
            + part(FLUTTER_OCT, FLUTTER_HZ, self.flutter)
            + 0.5 * (part(DRIFT_OCT, DRIFT_HZ, self.drift) + part(DRIFT_OCT, DRIFT_HZ * DRIFT_RATIO, self.drift2))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f64 = 48000.0;

    #[test]
    fn the_delay_deviation_is_the_integral_of_the_pitch_deviation() {
        let mut w = Warble::new();
        let mut prev = w.delay_seconds();
        for i in 0..200_000 {
            w.advance(1.0 / SR);
            let now = w.delay_seconds();
            let slope = (now - prev) * SR; // seconds of delay per second
            let want = -LN_2 * w.octaves();
            assert!((slope - want).abs() < 2e-5, "sample {i}: {slope} vs {want}");
            prev = now;
        }
    }

    #[test]
    fn it_is_continuous_across_phase_wraps_and_stays_small() {
        // 10 s covers several drift wraps; no sample-to-sample jump, never more than a few ms
        let mut w = Warble::new();
        let mut prev = w.delay_seconds();
        let mut peak: f64 = 0.0;
        for _ in 0..480_000 {
            w.advance(1.0 / SR);
            let now = w.delay_seconds();
            assert!((now - prev).abs() < 1e-6, "jump {}", now - prev);
            peak = peak.max(now.abs());
            prev = now;
        }
        assert!(peak > 1e-3 && peak < 5e-3, "peak {peak}");
    }
}
