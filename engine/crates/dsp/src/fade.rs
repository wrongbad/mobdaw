//! Clip fade curves and the clip-edge gain envelope (docs/engine-api.md, "Audio clips").
//!
//! # The three shapes
//! For fade-in progress `t` in 0..1 the gain is
//!
//! ```text
//!   equal-power  sin(t * pi/2)           linear  t           s-curve  0.5 - 0.5 cos(t * pi)
//! ```
//!
//! *Equal-power* is the quarter-cycle of a sine. Crossfading two uncorrelated signals with
//! `sin` (in) against `cos` (out) keeps `g_in^2 + g_out^2 = 1`, so the summed *power* stays
//! constant. (The mirror image of `sin(t pi/2)` over `t -> 1-t` is exactly `cos(t pi/2)`.)
//! *Linear* keeps summed *amplitude* constant, which is the right law for correlated
//! material. *S-curve* is a raised cosine: zero slope at both ends, so the fade starts and
//! ends without a corner.
//!
//! A fade-out is the mirror image: its gain at progress `t` is the fade-in gain at `1 - t`.
//!
//! # Declick
//! Every clip edge gets at least [`DECLICK_SAMPLES`] of fade, in the same shape, unless the
//! user's fade is longer. A hard cut in the middle of a waveform is a step, i.e. a broadband
//! click; 64 samples (1.3 ms at 48 kHz) is short enough to be inaudible as a fade and long
//! enough to push the click's energy well below the programme material.

use std::f64::consts::{FRAC_PI_2, PI};

/// Minimum fade length at every clip edge, in samples.
pub const DECLICK_SAMPLES: f64 = 64.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FadeShape {
    EqualPower,
    Linear,
    SCurve,
}

impl FadeShape {
    /// Contract encoding: 0 equal-power, 1 linear, 2 s-curve. Unknown values fall back to the
    /// default (equal-power), because the engine must never fail on the audio thread.
    pub fn from_u32(v: u32) -> Self {
        match v {
            1 => FadeShape::Linear,
            2 => FadeShape::SCurve,
            _ => FadeShape::EqualPower,
        }
    }
}

/// Gain of a fade-in at progress `t` (clamped to 0..1).
pub fn fade_in_gain(shape: FadeShape, t: f64) -> f32 {
    let t = t.clamp(0.0, 1.0);
    (match shape {
        FadeShape::EqualPower => (t * FRAC_PI_2).sin(),
        FadeShape::Linear => t,
        FadeShape::SCurve => 0.5 - 0.5 * (t * PI).cos(),
    }) as f32
}

/// The effective fade length: the user's fade, but never shorter than the declick.
pub fn effective_fade_len(user_samples: f64) -> f64 {
    if user_samples.is_finite() {
        user_samples.max(DECLICK_SAMPLES)
    } else {
        DECLICK_SAMPLES
    }
}

/// Envelope of a clip of `length` samples at clip-local sample `k` (0-based).
///
/// Fade-in progress at sample `k` is `k / fade_in`, so sample 0 is silent and the fade reaches
/// unity at `k = fade_in`. The fade-out is the mirror image about the clip's own centre:
/// progress is `(length - 1 - k) / fade_out`, so the last sample is silent too and the
/// envelope is exactly time-symmetric for equal fade lengths. Outside both fades the result is
/// exactly `1.0`, so un-faded audio passes through bit-exactly.
pub fn clip_edge_gain(k: i64, length: i64, fade_in: f64, fade_out: f64, shape: FadeShape) -> f32 {
    let fin = effective_fade_len(fade_in);
    let fout = effective_fade_len(fade_out);
    let mut g = 1.0f32;
    let kf = k as f64;
    if kf < fin {
        g *= fade_in_gain(shape, kf / fin);
    }
    let from_end = (length - 1 - k) as f64;
    if from_end < fout {
        g *= fade_in_gain(shape, from_end / fout);
    }
    g
}
