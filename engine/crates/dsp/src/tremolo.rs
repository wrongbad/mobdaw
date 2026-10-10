//! Tremolo: amplitude modulation by a low-frequency oscillator, with an optional left/right
//! phase offset that turns it into an auto-pan.
//!
//! ```text
//!   gain = 1 - depth * (0.5 - 0.5 * lfo)      lfo in -1..1, so gain is in 1-depth..1
//! ```
//!
//! The gain peaks at exactly 1, so the effect only ever takes level away. With `depth` at 0 the
//! gain is exactly 1 and the signal passes bit-exact. The LFO phase is kept in f64 cycles so
//! it doesn't drift over a long session, and it starts at the sine's zero crossing going up.

use crate::lfo;

pub const RATE_MIN: f32 = 0.1;
pub const RATE_MAX: f32 = 20.0;
pub use crate::lfo::SHAPES;

#[derive(Clone, Copy, Debug)]
pub struct TremParams {
    pub rate_hz: f32,
    /// 0..1.
    pub depth: f32,
    /// 0 sine, 1 triangle, 2 soft square.
    pub shape: u32,
    /// 0..1: the right channel's LFO is this many half-cycles behind the left's.
    pub spread: f32,
}

impl Default for TremParams {
    fn default() -> Self {
        Self { rate_hz: 4.0, depth: 0.5, shape: 0, spread: 0.0 }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Tremolo {
    /// LFO phase in cycles, 0..1.
    phase: f64,
}

impl Tremolo {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.phase = 0.0;
    }

    /// Process `l`/`r` in place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], p: &TremParams, sample_rate: f32) {
        let rate = p.rate_hz.clamp(RATE_MIN, RATE_MAX) as f64;
        let depth = p.depth.clamp(0.0, 1.0);
        let spread = p.spread.clamp(0.0, 1.0) as f64 * 0.5;
        let step = rate / sample_rate as f64;
        let shape = p.shape.min(SHAPES - 1);

        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let ur = (self.phase - spread).rem_euclid(1.0);
            *a *= 1.0 - depth * (0.5 - 0.5 * lfo::wave(self.phase, shape));
            *b *= 1.0 - depth * (0.5 - 0.5 * lfo::wave(ur, shape));
            self.phase = (self.phase + step).fract();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f32 = 48000.0;

    /// The gain curve: run a constant 1.0 through and read back what the tremolo did to it.
    fn gains(p: &TremParams, n: usize) -> (Vec<f32>, Vec<f32>) {
        let mut t = Tremolo::new();
        let (mut l, mut r) = (vec![1.0; n], vec![1.0; n]);
        t.process(&mut l, &mut r, p, SR);
        (l, r)
    }

    #[test]
    fn zero_depth_is_a_bit_exact_passthrough() {
        let p = TremParams { depth: 0.0, spread: 1.0, ..Default::default() };
        let x: Vec<f32> = (0..1000).map(|i| (i as f32 * 0.37).sin()).collect();
        let (mut l, mut r) = (x.clone(), x.clone());
        Tremolo::new().process(&mut l, &mut r, &p, SR);
        assert_eq!((l, r), (x.clone(), x));
    }

    #[test]
    fn gain_swings_between_one_minus_depth_and_one_for_every_shape() {
        for shape in 0..SHAPES {
            let p = TremParams { rate_hz: 5.0, depth: 0.75, shape, spread: 0.0 };
            let (l, _) = gains(&p, 48000);
            let (lo, hi) = l.iter().fold((f32::MAX, f32::MIN), |(a, b), &g| (a.min(g), b.max(g)));
            assert!((lo - 0.25).abs() < 1e-3, "shape {shape}: min {lo}");
            assert!((hi - 1.0).abs() < 1e-3, "shape {shape}: max {hi}");
        }
    }

    #[test]
    fn the_rate_is_the_number_of_cycles_per_second() {
        let p = TremParams { rate_hz: 8.0, depth: 1.0, ..Default::default() };
        let (l, _) = gains(&p, 48000);
        // One rising crossing of the 0.75 gain per cycle (the gain starts at 0.5, so the
        // half-way point itself would be missed on the first cycle).
        let rises = l.windows(2).filter(|w| w[0] < 0.75 && w[1] >= 0.75).count();
        assert_eq!(rises, 8);
    }

    #[test]
    fn full_spread_puts_the_channels_in_opposite_phase() {
        let p = TremParams { rate_hz: 2.0, depth: 1.0, spread: 1.0, ..Default::default() };
        let (l, r) = gains(&p, 48000);
        for (a, b) in l.iter().zip(&r) {
            assert!((a + b - 1.0).abs() < 1e-4, "gains {a} + {b} should sum to 1");
        }
        let (l, r) = gains(&TremParams { spread: 0.0, ..p }, 4800);
        assert_eq!(l, r);
    }

    #[test]
    fn the_phase_carries_across_blocks_and_out_of_range_params_stay_finite() {
        let p = TremParams { rate_hz: 3.0, depth: 0.6, shape: 1, spread: 0.3 };
        let (whole, _) = gains(&p, 4800);
        let mut t = Tremolo::new();
        let (mut l, mut r) = (vec![1.0; 4800], vec![1.0; 4800]);
        for (lc, rc) in l.chunks_mut(32).zip(r.chunks_mut(32)) {
            t.process(lc, rc, &p, SR);
        }
        assert_eq!(l, whole);

        let wild = TremParams { rate_hz: f32::MAX, depth: 50.0, shape: 99, spread: -3.0 };
        let (l, r) = gains(&wild, 1000);
        assert!(l.iter().chain(&r).all(|g| g.is_finite() && (0.0..=1.0).contains(g)));
    }
}
