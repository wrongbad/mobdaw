//! Tremolo: amplitude modulation by a low-frequency oscillator, with an optional left/right
//! phase offset that turns it into an auto-pan.
//!
//! ```text
//!   gain = 1 - depth * (0.5 - 0.5 * lfo)      lfo in -1..1, so gain is in 1-depth..1
//! ```
//!
//! The gain peaks at exactly 1, so the effect only ever takes level away. With `depth` at 0 the
//! gain is exactly 1 and the signal passes bit-exact. The LFO phase is a `u32` (2^32 per cycle) so
//! it wraps exactly and never drifts, the sine is [`crate::fast::sin2pi`], and it starts at the sine's zero crossing going up.

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
    /// LFO phase, 2^32 per cycle: it wraps exactly, never drifts, and the rate is quantised to
    /// 2^-32 of a cycle per sample.
    phase: u32,
}

/// 2^32 per cycle phase to cycles in `0..1` (the top 24 bits, so the conversion is exact).
#[inline(always)]
fn cycles(ph: u32) -> f32 {
    (ph >> 8) as f32 * (1.0 / 16_777_216.0)
}

#[inline(always)]
fn run<const S: u32>(l: &mut [f32], r: &mut [f32], ph0: u32, step: u32, spread: u32, depth: f32) {
    for (i, (a, b)) in l.iter_mut().zip(r.iter_mut()).enumerate() {
        let ph = ph0.wrapping_add(step.wrapping_mul(i as u32));
        let pr = ph.wrapping_sub(spread);
        *a *= 1.0 - depth * (0.5 - 0.5 * lfo::shape_at::<S>(cycles(ph)));
        *b *= 1.0 - depth * (0.5 - 0.5 * lfo::shape_at::<S>(cycles(pr)));
    }
}

impl Tremolo {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.phase = 0;
    }

    /// Advance the LFO past `n` samples of silence (what `process` would do to the phase).
    pub fn skip(&mut self, n: usize, p: &TremParams, sample_rate: f32) {
        let rate = p.rate_hz.clamp(RATE_MIN, RATE_MAX) as f64;
        let step = (rate / sample_rate as f64 * 4_294_967_296.0).round() as u32;
        self.phase = self.phase.wrapping_add(step.wrapping_mul(n as u32));
    }

    /// Process `l`/`r` in place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], p: &TremParams, sample_rate: f32) {
        let rate = p.rate_hz.clamp(RATE_MIN, RATE_MAX) as f64;
        let depth = p.depth.clamp(0.0, 1.0);
        let spread = (p.spread.clamp(0.0, 1.0) as f64 * 0.5 * 4_294_967_296.0) as u32;
        let step = (rate / sample_rate as f64 * 4_294_967_296.0).round() as u32;
        let n = l.len().min(r.len());
        let (l, r) = (&mut l[..n], &mut r[..n]);

        match p.shape.min(SHAPES - 1) {
            1 => run::<1>(l, r, self.phase, step, spread, depth),
            2 => run::<2>(l, r, self.phase, step, spread, depth),
            _ => run::<0>(l, r, self.phase, step, spread, depth),
        }
        self.phase = self.phase.wrapping_add(step.wrapping_mul(n as u32));
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

    #[test]
    fn skipping_hours_of_silence_lands_where_running_through_them_would() {
        let p = TremParams { rate_hz: 5.3, depth: 1.0, shape: 0, spread: 0.3 };
        let mut a = Tremolo::new();
        let mut b = Tremolo::new();
        let (mut l, mut r) = (vec![1.0f32; 1000], vec![1.0f32; 1000]);
        for _ in 0..600 {
            a.process(&mut l, &mut r, &p, SR);
            l.fill(1.0);
            r.fill(1.0);
        }
        b.skip(600_000, &p, SR);
        assert_eq!(a.phase, b.phase);
        // and a phase near the u32 wrap is seamless: the gain is always in range, never NaN
        a.phase = u32::MAX - 500;
        a.process(&mut l, &mut r, &p, SR);
        assert!(l.iter().chain(&r).all(|v| v.is_finite() && (0.0..=1.0).contains(v)));
    }
}
