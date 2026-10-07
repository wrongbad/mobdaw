//! A stateful looper voice: a read head that loops a region of a tape at a smoothly changing speed.
//!
//! The head keeps a *phase* (source samples into the loop region) that advances by the current
//! speed every output sample and wraps at the region length; the output is the resampled tape at
//! `start + phase`:
//!
//! ```text
//!   phase += speed_now;  if phase >= length { phase -= length }
//!   out    = resample(tape, start + phase)
//! ```
//!
//! # Speed is live
//! A new target speed takes effect immediately, but `speed_now` glides toward it with a one-pole
//! filter in the log2 domain (time constant [`SPEED_TAU_S`]), so ratios move evenly (0.1x -> 4x is
//! five octaves) and there are no zipper noises or clicks. The phase integrates the smoothed
//! speed, so the read head never jumps.
//!
//! # Triggers
//! The voice is stateful on purpose and makes no promise that the same timeline position sounds
//! the same twice. The loop restarts from the region start (phase 0, speed snapped to its target)
//! whenever the caller's `trigger` id changes (a new pad opens or retriggers) or the timeline is
//! discontinuous (play, seek). Matching what you heard live to a restart of the transport is left to
//! recorded automation.
//!
//! # The seam
//! Wrapping from `start + length` back to `start` is a discontinuity. For the first `xf` source
//! samples after every wrap the output is an equal-power crossfade between
//!   * head 1: the loop restarting at `start`, and
//!   * head 2: the audio that *continues past the loop end* (`start + length + phase`),
//! which is exactly what the previous head 1 was playing, so the output stays continuous. (There
//! is no seam to hide on the first pass after a trigger, so there the loop starts clean.)
//!
//! The resampler's filter state is a cache: after any jump (trigger, region edit, wrap) it is
//! rebuilt by running the filter over [`warmup`] input samples preceding the read position.

use crate::resampler::Resampler;
use std::f64::consts::FRAC_PI_2;

/// Crossfade length at the loop seam, in output milliseconds.
pub const XF_MS: f64 = 10.0;
/// Time constant of the speed smoothing (a generous 150 ms).
pub const SPEED_TAU_S: f64 = 0.15;
/// Regions shorter than this (source samples) are treated as empty.
pub const MIN_LENGTH: i64 = 64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopParams {
    /// Target playback rate, 0.1..4 (clamped by the caller); the voice glides to it.
    pub speed: f64,
    /// Region start on the tape (source samples).
    pub start: i64,
    /// Region length (source samples).
    pub length: i64,
    pub sample_rate: f64,
}

#[derive(Clone, Debug, Default)]
pub struct LoopVoice {
    h1: Resampler,
    h2: Resampler,
    h2_on: bool,
    active: bool,
    last_t: i64,
    trigger: i64,
    /// Source samples into the region.
    phase: f64,
    /// log2 of the smoothed speed.
    log_speed: f64,
    /// Whether the head has wrapped since the trigger (before that there is no seam to crossfade).
    wrapped: bool,
    region: (i64, i64),
}

/// Input samples fed to a fresh filter before the read position. The slowest filter pole decays
/// as `exp(-0.0675 t)` in time units of `1/scale` input samples, so ~100 units leave < 1e-3.
fn warmup(speed: f64) -> i64 {
    (96.0 * speed.max(1.0)).ceil() as i64
}

impl LoopVoice {
    pub fn new() -> Self {
        Self::default()
    }

    /// The read head on the tape (source samples), for a playhead: `None` before the first
    /// trigger or while the region is unusable.
    pub fn head(&self) -> Option<f64> {
        self.active.then(|| self.region.0 as f64 + self.phase)
    }

    /// Add `l.len()` frames of loop output into `l` and `r`. `tape(i)` is the stereo signal being
    /// looped, at source sample `i`. `trigger` identifies the current gate (a new value restarts the
    /// loop); `t0` is the timeline sample of `l[0]`, used only to notice that time jumped.
    pub fn render_add(
        &mut self,
        p: &LoopParams,
        trigger: i64,
        t0: i64,
        tape: &mut impl FnMut(i64) -> (f32, f32),
        l: &mut [f32],
        r: &mut [f32],
    ) {
        if p.length < MIN_LENGTH || !(p.speed > 0.0) || !p.speed.is_finite() {
            self.active = false;
            return;
        }
        // The tape may have been edited since the last block.
        self.h1.clear_cache();
        self.h2.clear_cache();
        let len = p.length as f64;
        let target = p.speed.log2();
        let coef = 1.0 - (-1.0 / (SPEED_TAU_S * p.sample_rate)).exp();
        for k in 0..l.len().min(r.len()) {
            let t = t0 + k as i64;
            let fresh = !self.active || self.last_t + 1 != t || self.trigger != trigger;
            if fresh {
                // (re)trigger: the loop starts at the region start, at the target speed
                self.phase = 0.0;
                self.log_speed = target;
                self.wrapped = false;
                self.h2_on = false;
                self.region = (p.start, p.length);
                let w = warmup(p.speed);
                self.h1.restart(p.start - w);
            } else {
                self.log_speed += (target - self.log_speed) * coef;
                if (target - self.log_speed).abs() < 1e-6 {
                    self.log_speed = target;
                }
            }
            let speed = self.log_speed.exp2();
            let scale = (1.0 / speed).min(1.0) as f32;
            let w = warmup(speed);
            let mut jumped = fresh;
            if !fresh {
                if self.region != (p.start, p.length) {
                    // The region was edited live: keep the phase (folded into the new length) and
                    // re-read from the new position.
                    self.region = (p.start, p.length);
                    self.phase = (self.phase + speed).rem_euclid(len);
                    self.h2_on = false;
                    jumped = true;
                } else {
                    self.phase += speed;
                    if self.phase >= len {
                        self.phase -= len;
                        if self.phase >= len {
                            self.phase = self.phase.rem_euclid(len);
                        }
                        // Wrapped: the old head 1 keeps going past the loop end as head 2.
                        std::mem::swap(&mut self.h1, &mut self.h2);
                        self.wrapped = true;
                        self.h2_on = true;
                        jumped = true; // (head 1 restarts below)
                    }
                }
            }
            let src = p.start as f64 + self.phase;
            if jumped && !fresh {
                self.h1.restart(src.floor() as i64 - w);
            }
            let xf = (XF_MS * 1e-3 * p.sample_rate * speed).min(len * 0.5);
            let need2 = self.wrapped && self.phase < xf;
            if need2 && !self.h2_on {
                self.h2.restart((src + len).floor() as i64 - w);
                self.h2_on = true;
            }
            if !need2 {
                self.h2_on = false;
            }
            let a = self.h1.advance(tape, src, scale);
            let (ol, or) = if need2 {
                let b = self.h2.advance(tape, src + len, scale);
                let x = self.phase / xf * FRAC_PI_2;
                let (gin, gout) = (x.sin() as f32, x.cos() as f32);
                (a.0 * gin + b.0 * gout, a.1 * gin + b.1 * gout)
            } else {
                a
            };
            l[k] += ol;
            r[k] += or;
            self.last_t = t;
            self.trigger = trigger;
            self.active = true;
        }
    }
}
