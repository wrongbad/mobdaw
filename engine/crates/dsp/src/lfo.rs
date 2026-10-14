//! LFO waveforms, shared by the tremolo device and by automation lanes in LFO mode.
//!
//! Everything is a pure function of the phase, and a lane's phase is a pure function of the
//! timeline position (`pos / sample_rate * rate`), so seeking, looping and an offline bounce all
//! read the same value at the same place. All shapes are in phase with the sine: they start at
//! zero going up.

use crate::fast;

/// Number of shapes: sine, triangle, soft square.
pub const SHAPES: u32 = 3;
/// How hard the sine is driven to make the "square", so the edges stay a few ms long (no clicks).
const SQUARE_DRIVE: f32 = 6.0;

/// The shape `S` (0 sine, 1 triangle, 2 soft square; anything else reads as the sine) at phase
/// `f`, in cycles, where `f` should be in `0..1` (the sine is [`fast::sin2pi`]: error about 1e-3).
/// The const parameter lets a caller pick the shape once, outside its loop.
#[inline(always)]
pub fn shape_at<const S: u32>(f: f32) -> f32 {
    match S {
        1 => {
            let g = f + 0.25;
            1.0 - 4.0 * ((g - g.floor()) - 0.5).abs()
        }
        2 => (fast::sin2pi(f) * SQUARE_DRIVE).clamp(-1.0, 1.0),
        _ => fast::sin2pi(f),
    }
}

/// The wave at phase `u` (cycles; any value, only the fractional part matters), in -1..1.
/// `shape` past the last one reads as the sine. The sine is an approximation (see
/// [`shape_at`]); the result is still a pure function of `u`.
#[inline]
pub fn wave(u: f64, shape: u32) -> f32 {
    let f = (u - u.floor()) as f32;
    match shape {
        1 => shape_at::<1>(f),
        2 => shape_at::<2>(f),
        _ => shape_at::<0>(f),
    }
}

/// The wave at timeline sample `pos` for an LFO running at `rate_hz`.
#[inline]
pub fn at_position(pos: i64, sample_rate: f64, rate_hz: f64, shape: u32) -> f32 {
    wave(pos as f64 / sample_rate * rate_hz, shape)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shape_starts_at_zero_going_up_and_peaks_a_quarter_in() {
        for s in 0..SHAPES {
            assert!(wave(0.0, s).abs() < 1e-6, "shape {s} at 0");
            assert!(wave(0.01, s) > 0.0, "shape {s} rising");
            assert!((wave(0.25, s) - 1.0).abs() < 1e-6, "shape {s} peak");
            assert!((wave(0.75, s) + 1.0).abs() < 1e-6, "shape {s} trough");
        }
    }

    #[test]
    fn the_wave_stays_in_range_and_is_periodic_for_any_phase() {
        for s in 0..SHAPES + 1 {
            for i in -500..500 {
                let u = i as f64 * 0.0137;
                let v = wave(u, s);
                assert!((-1.0..=1.0).contains(&v));
                assert!((v - wave(u + 3.0, s)).abs() < 1e-5, "shape {s} at {u}");
            }
        }
    }

    #[test]
    fn position_maps_to_phase_by_rate() {
        // 2 Hz at 48 kHz: a quarter cycle is 6000 samples
        assert!((at_position(6000, 48000.0, 2.0, 0) - 1.0).abs() < 1e-6);
        assert!(at_position(24000, 48000.0, 2.0, 0).abs() < 1e-5);
    }

    #[test]
    fn the_sine_is_within_a_thousandth_of_exact() {
        for i in -2000..2000 {
            let u = i as f64 * 0.00123;
            let exact = (std::f64::consts::TAU * u).sin();
            assert!((wave(u, 0) as f64 - exact).abs() < 1.1e-3, "at {u}");
        }
    }

    #[test]
    fn a_position_weeks_in_reads_the_same_wave_as_one_cycle_in() {
        // 2 Hz at 48 kHz: 24000 samples a cycle. A quarter-cycle point is a peak at any cycle count.
        for k in [0i64, 1, 1_000_000, 40_000_000_000 / 24_000, 400_000_000_000 / 24_000] {
            let pos = k * 24_000 + 6000;
            assert!((at_position(pos, 48000.0, 2.0, 0) - 1.0).abs() < 1e-5, "cycle {k}");
            assert!((at_position(pos, 48000.0, 2.0, 1) - 1.0).abs() < 1e-5, "tri, cycle {k}");
        }
    }
}
