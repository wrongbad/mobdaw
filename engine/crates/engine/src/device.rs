//! Devices: the effect/instrument processors in a track's chain.

use dsp::{Ramp, Svf, Synth};

pub const KIND_FILTER: u32 = 1;
pub const KIND_SYNTH: u32 = 2;

const SMOOTH_MS: f64 = 10.0;

pub struct Device {
    pub track: u32,
    pub order: f64,
    pub bypass: bool,
    pub kind_id: u32,
    pub kind: DeviceKind,
}

/// Boxed so the sorted device map shuffles small structs, not 10 KB synths.
pub enum DeviceKind {
    /// A kind this engine version doesn't know: passes audio through.
    Unknown,
    Filter(Box<FilterDevice>),
    Synth(Box<Synth>),
}

impl Device {
    pub fn new(track: u32, kind_id: u32, order: f64, bypass: bool, sample_rate: f32) -> Self {
        let kind = match kind_id {
            KIND_FILTER => DeviceKind::Filter(Box::new(FilterDevice::new(sample_rate))),
            KIND_SYNTH => DeviceKind::Synth(Box::new(Synth::new(sample_rate))),
            _ => DeviceKind::Unknown,
        };
        Self { track, order, bypass, kind_id, kind }
    }

    pub fn is_instrument(&self) -> bool {
        matches!(self.kind, DeviceKind::Synth(_))
    }

    pub fn set_param(&mut self, param: u32, value: f32) {
        match &mut self.kind {
            DeviceKind::Filter(f) => f.set_param(param, value),
            DeviceKind::Synth(s) => s.set_param(param, value),
            DeviceKind::Unknown => {}
        }
    }

    /// Drop all audio state (filter memory, sounding voices). Used when bypass is engaged,
    /// so re-enabling starts clean instead of replaying stale state.
    pub fn reset_state(&mut self) {
        match &mut self.kind {
            DeviceKind::Filter(f) => f.reset(),
            DeviceKind::Synth(s) => s.reset(),
            DeviceKind::Unknown => {}
        }
    }

    /// Process one control segment (at most 32 samples) of the track's stereo buffer.
    ///
    /// * Bypassed effect: the buffer is left untouched (bit-exact passthrough).
    /// * Bypassed instrument: contributes silence.
    /// * Instrument: adds its mono output to both channels.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        if self.bypass {
            return;
        }
        match &mut self.kind {
            DeviceKind::Filter(f) => f.process(l, r, sample_rate),
            DeviceKind::Synth(s) => {
                let mut mono = [0.0f32; dsp::finnwave::SUB_BLOCK];
                let mono = &mut mono[..l.len()];
                s.render_add(mono);
                for ((l, r), m) in l.iter_mut().zip(r.iter_mut()).zip(mono.iter()) {
                    *l += *m;
                    *r += *m;
                }
            }
            DeviceKind::Unknown => {}
        }
    }
}

/// Kind 1: the wade SVF as a stereo effect (two independent filter states).
///
/// Cutoff is smoothed in the log2 domain (a linear ramp in octaves is perceptually even and
/// keeps the filter's `tan` warp well behaved), damping linearly. The mode switch picks which
/// SVF output is heard and is not smoothed. Coefficients are recomputed once per control
/// segment from the smoothed values at the segment start.
pub struct FilterDevice {
    smooth_samples: f64,
    mode: u32,
    cutoff_log2: Ramp,
    damping: Ramp,
    svf: [Svf; 2],
}

impl FilterDevice {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            smooth_samples: sample_rate as f64 * SMOOTH_MS * 1e-3,
            mode: 0,
            cutoff_log2: Ramp::new(1000f64.log2()),
            damping: Ramp::new(std::f64::consts::FRAC_1_SQRT_2),
            svf: [Svf::new(), Svf::new()],
        }
    }

    pub fn set_param(&mut self, param: u32, value: f32) {
        if !value.is_finite() {
            return;
        }
        let s = self.smooth_samples;
        match param {
            0 => self.mode = (value.round().clamp(0.0, 4.0)) as u32,
            1 => self.cutoff_log2.set_target((value.clamp(20.0, 20000.0) as f64).log2(), s),
            2 => self.damping.set_target(value.clamp(0.05, 2.0) as f64, s),
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        self.svf[0].reset();
        self.svf[1].reset();
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let len = l.len();
        // Smoothed values at the segment start, then advance the ramps past the segment.
        let nyquist_limit = 0.99 * 0.5 * sample_rate as f64;
        let cutoff = self.cutoff_log2.value().exp2().min(nyquist_limit) as f32;
        let damping = self.damping.value() as f32;
        self.cutoff_log2.advance(len);
        self.damping.advance(len);

        let pick: fn(&Svf) -> f32 = match self.mode {
            0 => Svf::lp,
            1 => Svf::hp,
            2 => Svf::bp,
            3 => Svf::notch,
            _ => Svf::peak,
        };
        for (svf, buf) in self.svf.iter_mut().zip([l, r]) {
            svf.set_hz(cutoff, damping, sample_rate);
            for x in buf.iter_mut() {
                *x = pick(svf.process(*x));
            }
        }
    }
}
