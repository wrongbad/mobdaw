//! Variable-rate resampler: a port of wade's `variable_resampler` (`interp.h`), stereo, with
//! `f64` read positions so long timelines don't lose precision.
//!
//! The input is treated as a zero-order-hold signal (sample `i` holds over `[i, i+1)`), and the
//! analog low-pass filter is integrated across it. Reading at position `to` means "step the
//! filter over every input interval between the previous position and `to`". The filter's time
//! axis is scaled by `scale = min(1, 1/speed)`, so
//!   * `speed <= 1` (upsampling): one filter time unit = one *input* sample; the filter removes the
//!     zero-order-hold images;
//!   * `speed > 1` (downsampling): one filter time unit = one *output* sample, so the cutoff
//!     drops with the speed and removes what would alias.
//! Either way the cutoff is `CUTOFF` rad per sample of the *slower* of the two rates.

use crate::analog::AnalogCheby1;

/// Wade's default: 1 rad per sample, i.e. about 0.16 of the slower sample rate.
pub const CUTOFF: f32 = 1.0;
pub const RIPPLE_DB: f32 = 2.0;

#[derive(Clone, Debug)]
pub struct Resampler {
    l: AnalogCheby1,
    r: AnalogCheby1,
    pos: f64,
    cache: Option<(i64, (f32, f32))>,
}

impl Default for Resampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Resampler {
    pub fn new() -> Self {
        Self { l: AnalogCheby1::new(CUTOFF, RIPPLE_DB), r: AnalogCheby1::new(CUTOFF, RIPPLE_DB), pos: 0.0, cache: None }
    }

    /// Forget all history and start reading at input index `at`.
    pub fn restart(&mut self, at: i64) {
        self.l.reset();
        self.r.reset();
        self.pos = at as f64;
        self.cache = None;
    }

    pub fn pos(&self) -> f64 {
        self.pos
    }

    /// Drop the one-sample input cache (call when the input signal may have changed).
    pub fn clear_cache(&mut self) {
        self.cache = None;
    }

    fn fetch(&mut self, input: &mut impl FnMut(i64) -> (f32, f32), i: i64) -> (f32, f32) {
        match self.cache {
            Some((ci, v)) if ci == i => v,
            _ => {
                let v = input(i);
                self.cache = Some((i, v));
                v
            }
        }
    }

    /// Move the read position forward to `to` (>= the current position) and return the output
    /// there. `scale` is `min(1, 1/speed)`.
    pub fn advance(&mut self, input: &mut impl FnMut(i64) -> (f32, f32), to: f64, scale: f32) -> (f32, f32) {
        let mut from = self.pos;
        let mut i = from.floor() as i64;
        let ito = to.floor() as i64;
        while i < ito {
            let step = ((i + 1) as f64 - from) as f32;
            if step > 0.0 {
                let (a, b) = self.fetch(input, i);
                self.l.step(a, step * scale);
                self.r.step(b, step * scale);
            }
            i += 1;
            from = i as f64;
        }
        let step = (to - from).max(0.0) as f32;
        let (a, b) = self.fetch(input, i);
        let out = (self.l.step(a, step * scale), self.r.step(b, step * scale));
        self.pos = to;
        out
    }
}
