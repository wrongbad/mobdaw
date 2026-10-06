//! finnwave: a band-limited oscillator with exponentially decaying harmonics.
//! Ported from wade `finnwave` (Kyle Finn, 2014).
//!
//! # The waveform
//! With fundamental `f` (cycles/sample), phase `theta = 2*pi*p` and rolloff `b`, the output is
//!
//! ```text
//!   y = b * sum_{k=1..N} e^{-k b} sin(k theta),      N = floor(0.5 / f)
//! ```
//!
//! `N` is the number of harmonics below Nyquist, so the signal is exactly band-limited: no
//! aliasing at all, at any pitch. `b = 0` would be a flat-spectrum pulse train; larger `b`
//! rolls the harmonics off like a low-pass filter, but without a filter's phase shift or state.
//! (The leading `b` is a loudness normalisation; it is why output vanishes as `b -> 0`, and
//! why `b` is clamped to at least [`MIN_ROLLOFF`].)
//!
//! # Closed form
//! The sum is the imaginary part of a finite geometric series. With `z = e^{-b + i theta}`:
//!
//! ```text
//!   S = Im sum_{k=1..N} z^k = Im[ z (1 - z^N) / (1 - z) ]
//! ```
//!
//! Multiply top and bottom by `conj(1 - z)`; the denominator becomes
//! `|1 - z|^2 = 1 - 2 e^{-b} cos(theta) + e^{-2b}`. In the numerator, `Im z^{N+1}` is expanded
//! with `sin((N+1)theta) = sin(N theta) cos(theta) + cos(N theta) sin(theta)`, giving
//!
//! ```text
//!       sin(theta) (e^{-b} - e^{-(N+1)b} cos(N theta)) + sin(N theta) (e^{-(N+2)b} - e^{-(N+1)b} cos(theta))
//!   S = ----------------------------------------------------------------------------------------------
//!                              1 - 2 e^{-b} cos(theta) + e^{-2b}
//! ```
//!
//! That is two sines, two cosines and one divide per sample, independent of `N`.
//!
//! # Changes from the original C++
//! 1. **Phase** is kept as f64 cycles of the *fundamental* in [0, 1). `theta = 2 pi p` and the
//!    top term uses `N theta = 2 pi fract(N p)`, computed in f64. The C++ kept a phase in units
//!    of `N` cycles, so when `N` changed (pitch sweep) the stored phase meant something else and
//!    the waveform jumped; and large `N` lost f32 precision.
//! 2. **Top-harmonic crossfade.** See below.
//! 3. **Control sub-blocks.** `e^{-b}`, `e^{-(N+1)b}` etc. are computed once per 32-sample
//!    sub-block. Inside it, `sin/cos` of `theta` and `N theta` advance by complex rotation
//!    (`(c, s) <- (c cd - s sd, s cd + c sd)`), re-seeded exactly from the f64 phase at the
//!    start of every sub-block so rounding error cannot accumulate.
//! 4. **Smoothing** of amp and rolloff is a linear ramp lasting 10 ms ([`SMOOTH_MS`]), so it is
//!    sample-rate independent. The ramps advance at the control rate (rolloff is held per
//!    sub-block; amp is interpolated per sample).
//!
//! # Fractional-N crossfade (change 2)
//! `N = floor(0.5/f)` is a staircase in `f`. During a pitch sweep each step adds or removes a
//! whole harmonic (`b e^{-Nb}` in amplitude) instantly, which is a pop. Let
//! `0.5/f = N + r`, `r in [0, 1)`. Harmonic `N` sits at `N f = 0.5 N/(N + r)`, which equals
//! Nyquist exactly at `r = 0` and moves away from it as `r` grows. We weight the top harmonic
//! by `r`:
//!
//! ```text
//!   S_faded = S_N - (1 - r) * e^{-N b} sin(N theta)   ( = S_{N-1} + r * term_N )
//! ```
//!
//! * `r -> 0` (harmonic `N` reaches Nyquist from below): its weight goes to 0, so it has left
//!   gracefully; the signal equals `S_{N-1}`.
//! * `r -> 1` (about to become `N + 1`): `S_faded -> S_N`. The new regime `N' = N + 1` has
//!   `r' = 0`, so `S_faded' = S_N`. Continuous across the step.
//!
//! Note this fades the *highest harmonic that is still below Nyquist*, not the first one above
//! it: fading in a term at `(N+1) f > 0.5` would alias, defeating the point of the oscillator.
//! The cost is one extra multiply-add per sample, since `e^{-N b} sin(N theta)` is already at
//! hand.

use crate::smooth::Ramp;
use std::f64::consts::TAU;

/// Control-rate sub-block length in samples (engine.md §6.2).
pub const SUB_BLOCK: usize = 32;
/// Parameter smoothing time (engine.md §6.4).
pub const SMOOTH_MS: f64 = 10.0;
/// Smallest allowed rolloff `b`. Output scales with `b`, so `b -> 0` is silence.
pub const MIN_ROLLOFF: f64 = 1e-3;

#[derive(Clone, Debug)]
pub struct Finnwave {
    sample_rate: f64,
    smooth_samples: f64,
    /// Cycles/sample, always in [1e-6, 0.5].
    freq: f64,
    /// Fundamental phase in cycles, [0, 1).
    phase: f64,
    rolloff: Ramp,
    amp: Ramp,
}

impl Finnwave {
    /// A silent oscillator (amp 0) at 440 Hz with rolloff 0.3. These are the C++ defaults
    /// except that amp starts at 0, so the first `set_amp(1.0)` fades in over 10 ms.
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate as f64;
        Self {
            sample_rate: sr,
            smooth_samples: sr * SMOOTH_MS * 1e-3,
            freq: 440.0 / sr,
            phase: 0.0,
            rolloff: Ramp::new(0.3),
            amp: Ramp::new(0.0),
        }
    }

    /// Fundamental in Hz. Applied immediately (pitch is not smoothed here; callers that want
    /// glide ramp it themselves). Phase is continuous across changes.
    pub fn set_freq_hz(&mut self, hz: f32) {
        self.freq = (hz as f64 / self.sample_rate).clamp(1e-6, 0.5);
    }

    /// Rolloff `b`: harmonic `k` has amplitude `e^{-k b}`. Clamped to `>= MIN_ROLLOFF`.
    /// Ramps to the new value over 10 ms.
    pub fn set_rolloff(&mut self, b: f32) {
        self.rolloff.set_target((b as f64).max(MIN_ROLLOFF), self.smooth_samples);
    }

    /// Like [`Self::set_rolloff`] but jumps at once. For callers that already compute a smooth
    /// per-block value (e.g. an envelope-modulated rolloff) and don't want a second 10 ms
    /// lag stacked on top.
    pub fn set_rolloff_immediate(&mut self, b: f32) {
        self.rolloff.set_target((b as f64).max(MIN_ROLLOFF), self.smooth_samples);
        self.rolloff.snap();
    }

    /// Output gain, ramped over 10 ms.
    pub fn set_amp(&mut self, amp: f32) {
        self.amp.set_target(amp as f64, self.smooth_samples);
    }

    /// Jump the smoothed parameters to their targets (for tests and for initialising a voice).
    pub fn snap_params(&mut self) {
        self.rolloff.snap();
        self.amp.snap();
    }

    /// Reset the phase to the start of a cycle (output starts at 0).
    pub fn reset_phase(&mut self) {
        self.phase = 0.0;
    }

    /// Add the oscillator's output into `out` (does not clear it).
    pub fn render_add(&mut self, out: &mut [f32]) {
        for chunk in out.chunks_mut(SUB_BLOCK) {
            self.render_sub_block(chunk);
        }
    }

    /// One control sub-block: everything that depends only on (f, b) is computed here once.
    fn render_sub_block(&mut self, out: &mut [f32]) {
        let n_samples = out.len();
        let f = self.freq;

        // Smoothers advance at the control rate. Rolloff uses the value at the end of the
        // sub-block (so a ramp lands on time); amp is interpolated per sample below.
        let amp_start = self.amp.value();
        let amp_end = self.amp.advance(n_samples);
        let b = self.rolloff.advance(n_samples);

        // Harmonic count and fractional part: 0.5/f = n + r.
        let ratio = 0.5 / f;
        let n = ratio.floor();
        let r = ratio - n;

        if n >= 1.0 {
            let e_b = (-b).exp();
            let e_2b = e_b * e_b;
            let e_n = (-n * b).exp(); // e^{-N b}: amplitude of the top harmonic
            let e_n1 = e_n * e_b; // e^{-(N+1) b}
            let e_n2 = e_n1 * e_b; // e^{-(N+2) b}
            let fade = 1.0 - r; // weight removed from the top harmonic (see module docs)

            // Seed sin/cos of theta and N*theta exactly, and the per-sample rotations.
            let theta = TAU * self.phase;
            let phi = TAU * (n * self.phase).fract(); // N*theta mod 2pi
            let (mut s_t, mut c_t) = theta.sin_cos();
            let (mut s_p, mut c_p) = phi.sin_cos();
            let (sd_t, cd_t) = (TAU * f).sin_cos();
            let (sd_p, cd_p) = (TAU * (n * f).fract()).sin_cos();

            let mut amp = amp_start;
            let d_amp = (amp_end - amp_start) / n_samples as f64;

            for y in out.iter_mut() {
                amp += d_amp;
                let num = s_t * (e_b - e_n1 * c_p) + s_p * (e_n2 - e_n1 * c_t);
                let den = 1.0 - 2.0 * e_b * c_t + e_2b;
                let s = num / den - fade * e_n * s_p;
                *y += (b * amp * s) as f32;

                // Rotate (c, s) by the per-sample angle: complex multiply by e^{i d}.
                (s_t, c_t) = (s_t * cd_t + c_t * sd_t, c_t * cd_t - s_t * sd_t);
                (s_p, c_p) = (s_p * cd_p + c_p * sd_p, c_p * cd_p - s_p * sd_p);
            }
        }

        self.phase = (self.phase + f * n_samples as f64).fract();
    }
}
