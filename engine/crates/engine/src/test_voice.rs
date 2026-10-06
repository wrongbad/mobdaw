//! Milestone-1 test voice: finnwave -> SVF low-pass -> gain, mono to stereo.
//! Kept for `#/engine-test`. It is mixed into the engine output only while its gate is on
//! (plus a short tail so the gate-off ramp and filter ring-out finish).

use crate::BLOCK;
use dsp::finnwave::SUB_BLOCK;
use dsp::{Finnwave, Ramp, Svf};

pub const PARAM_GATE: u32 = 0; // > 0.5 = on
pub const PARAM_FREQ: u32 = 1; // Hz
pub const PARAM_ROLLOFF: u32 = 2; // finnwave b
pub const PARAM_CUTOFF: u32 = 3; // Hz
pub const PARAM_DAMPING: u32 = 4; // SVF R
pub const PARAM_GAIN: u32 = 5; // linear

const SMOOTH_MS: f64 = 10.0;

pub struct TestVoice {
    sample_rate: f32,
    smooth_samples: f64,
    osc: Finnwave,
    filter: Svf,
    /// Frequency-like params ramp in the log2 domain (engine.md §6.4).
    freq_log2: Ramp,
    cutoff_log2: Ramp,
    damping: Ramp,
    gain: Ramp,
    /// Preallocated mono scratch, so `process` never allocates.
    mono: [f32; BLOCK],
    gate: bool,
    /// Samples of tail left to render after the gate closes.
    tail_left: usize,
    tail_len: usize,
}

impl TestVoice {
    pub fn new(sample_rate: f32) -> Self {
        let mut v = Self {
            sample_rate,
            smooth_samples: sample_rate as f64 * SMOOTH_MS * 1e-3,
            osc: Finnwave::new(sample_rate),
            filter: Svf::new(),
            freq_log2: Ramp::new(220f64.log2()),
            cutoff_log2: Ramp::new(2000f64.log2()),
            damping: Ramp::new(std::f64::consts::FRAC_1_SQRT_2),
            gain: Ramp::new(0.3),
            mono: [0.0; BLOCK],
            gate: false,
            tail_left: 0,
            tail_len: (sample_rate * 0.25) as usize,
        };
        v.osc.set_rolloff(0.3);
        v.osc.snap_params(); // gate is off, amp already 0
        v
    }

    pub fn set_param(&mut self, id: u32, value: f32) {
        if !value.is_finite() {
            return;
        }
        let s = self.smooth_samples;
        match id {
            PARAM_GATE => {
                self.gate = value > 0.5;
                self.osc.set_amp(if self.gate { 1.0 } else { 0.0 });
            }
            PARAM_FREQ => self.freq_log2.set_target((value.clamp(1.0, 20000.0) as f64).log2(), s),
            PARAM_ROLLOFF => self.osc.set_rolloff(value.clamp(0.0, 20.0)),
            PARAM_CUTOFF => self.cutoff_log2.set_target((value.clamp(10.0, 20000.0) as f64).log2(), s),
            PARAM_DAMPING => self.damping.set_target(value.clamp(0.02, 4.0) as f64, s),
            PARAM_GAIN => self.gain.set_target(value.clamp(0.0, 4.0) as f64, s),
            _ => {}
        }
    }

    /// True while the voice should be mixed in: gate on, or still ringing out.
    pub fn is_active(&self) -> bool {
        self.gate || self.tail_left > 0
    }

    /// Add `left.len()` (<= 128) frames into the buffers. Control is evaluated per 32-frame sub-block.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len();
        if self.gate {
            self.tail_left = self.tail_len;
        } else {
            self.tail_left = self.tail_left.saturating_sub(n);
        }
        let mut start = 0;
        while start < n {
            let len = SUB_BLOCK.min(n - start);
            let chunk = &mut self.mono[start..start + len];

            // Control update (once per sub-block).
            let freq = self.freq_log2.advance(len).exp2() as f32;
            let cutoff = self.cutoff_log2.advance(len).exp2() as f32;
            let damping = self.damping.advance(len) as f32;
            let g0 = self.gain.value() as f32;
            let g1 = self.gain.advance(len) as f32;
            self.osc.set_freq_hz(freq);
            self.filter.set_hz(cutoff, damping, self.sample_rate);

            // Audio: oscillator -> SVF low-pass -> gain (ramped per sample).
            chunk.fill(0.0);
            self.osc.render_add(chunk);
            let dg = (g1 - g0) / len as f32;
            let mut g = g0;
            for (i, x) in chunk.iter().enumerate() {
                g += dg;
                let y = self.filter.process(*x).lp() * g;
                left[start + i] += y;
                right[start + i] += y;
            }
            start += len;
        }
    }
}
