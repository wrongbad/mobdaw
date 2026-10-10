//! LFO waveforms, shared by the tremolo device and by automation lanes in LFO mode.
//!
//! Everything is a pure function of the phase, and a lane's phase is a pure function of the
//! timeline position (`pos / sample_rate * rate`), so seeking, looping and an offline bounce all
//! read the same value at the same place. All shapes are in phase with the sine: they start at
//! zero going up.

/// Number of shapes: sine, triangle, soft square.
pub const SHAPES: u32 = 3;
/// How hard the sine is driven to make the "square", so the edges stay a few ms long (no clicks).
const SQUARE_DRIVE: f32 = 6.0;

/// The wave at phase `u` (cycles; any value, only the fractional part matters), in -1..1.
/// `shape` past the last one reads as the sine.
#[inline]
pub fn wave(u: f64, shape: u32) -> f32 {
    match shape {
        1 => (1.0 - 4.0 * ((u + 0.25).rem_euclid(1.0) - 0.5).abs()) as f32,
        2 => ((std::f64::consts::TAU * u).sin() as f32 * SQUARE_DRIVE).clamp(-1.0, 1.0),
        _ => (std::f64::consts::TAU * u).sin() as f32,
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
}
