//! Devices: the effect/instrument processors in a track's chain.

use dsp::{CompParams, Compressor, DelayParams, Ramp, Reverb, Svf, Synth, TapeDelay, TremParams, Tremolo};

pub const KIND_FILTER: u32 = 1;
pub const KIND_SYNTH: u32 = 2;
pub const KIND_REVERB: u32 = 3;
pub const KIND_COMPRESSOR: u32 = 4;
pub const KIND_TREMOLO: u32 = 5;
pub const KIND_DELAY: u32 = 6;

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
    Reverb(Box<ReverbDevice>),
    Compressor(Box<CompressorDevice>),
    Tremolo(Box<TremoloDevice>),
    Delay(Box<DelayDevice>),
}

impl Device {
    pub fn new(track: u32, kind_id: u32, order: f64, bypass: bool, sample_rate: f32) -> Self {
        let kind = match kind_id {
            KIND_FILTER => DeviceKind::Filter(Box::new(FilterDevice::new(sample_rate))),
            KIND_SYNTH => DeviceKind::Synth(Box::new(Synth::new(sample_rate))),
            KIND_REVERB => DeviceKind::Reverb(Box::new(ReverbDevice::new(sample_rate))),
            KIND_COMPRESSOR => DeviceKind::Compressor(Box::new(CompressorDevice::new(sample_rate))),
            KIND_TREMOLO => DeviceKind::Tremolo(Box::new(TremoloDevice::new(sample_rate))),
            KIND_DELAY => DeviceKind::Delay(Box::new(DelayDevice::new(sample_rate))),
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
            DeviceKind::Reverb(v) => v.set_param(param, value),
            DeviceKind::Compressor(c) => c.set_param(param, value),
            DeviceKind::Tremolo(t) => t.set_param(param, value),
            DeviceKind::Delay(d) => d.set_param(param, value),
            DeviceKind::Unknown => {}
        }
    }

    /// An automated value: applied at once, with none of the glide a knob move gets.
    pub fn set_param_auto(&mut self, param: u32, value: f32) {
        match &mut self.kind {
            DeviceKind::Filter(f) => f.set_param_smooth(param, value, 0.0),
            DeviceKind::Synth(s) => s.set_param_smooth(param, value, 0.0),
            DeviceKind::Reverb(v) => v.set_param_smooth(param, value, 0.0),
            DeviceKind::Compressor(c) => c.set_param_smooth(param, value, 0.0),
            DeviceKind::Tremolo(t) => t.set_param_smooth(param, value, 0.0),
            DeviceKind::Delay(d) => d.set_param_smooth(param, value, 0.0),
            DeviceKind::Unknown => {}
        }
    }

    /// Drop all audio state (filter memory, sounding voices). Used when bypass is engaged,
    /// so re-enabling starts clean instead of replaying stale state.
    pub fn reset_state(&mut self) {
        match &mut self.kind {
            DeviceKind::Filter(f) => f.reset(),
            DeviceKind::Synth(s) => s.reset(),
            DeviceKind::Reverb(v) => v.reset(),
            DeviceKind::Compressor(c) => c.reset(),
            DeviceKind::Tremolo(t) => t.reset(),
            DeviceKind::Delay(d) => d.reset(),
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
            DeviceKind::Reverb(v) => v.process(l, r),
            DeviceKind::Compressor(c) => c.process(l, r, sample_rate),
            DeviceKind::Tremolo(t) => t.process(l, r, sample_rate),
            DeviceKind::Delay(d) => d.process(l, r),
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
    /// Bell and shelf gain in dB; linear ramp.
    gain_db: Ramp,
    svf: [Svf; 2],
}

impl FilterDevice {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            smooth_samples: sample_rate as f64 * SMOOTH_MS * 1e-3,
            mode: 0,
            cutoff_log2: Ramp::new(1000f64.log2()),
            damping: Ramp::new(std::f64::consts::FRAC_1_SQRT_2),
            gain_db: Ramp::new(0.0),
            svf: [Svf::new(), Svf::new()],
        }
    }

    pub fn set_param(&mut self, param: u32, value: f32) {
        self.set_param_smooth(param, value, self.smooth_samples);
    }

    pub fn set_param_smooth(&mut self, param: u32, value: f32, s: f64) {
        if !value.is_finite() {
            return;
        }
        match param {
            0 => self.mode = (value.round().clamp(0.0, 7.0)) as u32,
            1 => self.cutoff_log2.set_target((value.clamp(20.0, 20000.0) as f64).log2(), s),
            2 => self.damping.set_target(value.clamp(0.05, 2.0) as f64, s),
            3 => self.gain_db.set_target(value.clamp(-24.0, 24.0) as f64, s),
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
        let gain_db = self.gain_db.value() as f32;
        self.cutoff_log2.advance(len);
        self.damping.advance(len);
        self.gain_db.advance(len);

        if self.mode >= 5 {
            // Bell and shelves (Cytomic's SVF mixes): out = m0*x + m1*bp + m2*lp, with A = 10^(dB/40).
            let a = 10f32.powf(gain_db / 40.0);
            let a2 = a * a;
            let k = 2.0 * damping;
            let (warp, damping, m0, m1, m2) = match self.mode {
                5 => (1.0, damping / a, 1.0, k / a * (a2 - 1.0), 0.0), // bell: resonance k/A, centre gain A^2
                6 => (1.0 / a.sqrt(), damping, 1.0, k * (a - 1.0), a2 - 1.0), // low shelf
                _ => (a.sqrt(), damping, a2, k * (1.0 - a) * a, 1.0 - a2), // high shelf
            };
            for (svf, buf) in self.svf.iter_mut().zip([l, r]) {
                svf.set_hz_warped(cutoff, damping, sample_rate, warp);
                for x in buf.iter_mut() {
                    let input = *x;
                    svf.process(input);
                    *x = m0 * input + m1 * svf.bp() + m2 * svf.lp();
                }
            }
            return;
        }

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

/// Kind 3: stereo reverb. Params: 0 mix (0..1), 1 size (0..1), 2 damping (0..1), 3 predelay (ms).
/// Mix, size and damping are smoothed (the values at each segment start are used); predelay
/// jumps, so moving it while sound passes may click.
pub struct ReverbDevice {
    smooth_samples: f64,
    mix: Ramp,
    size: Ramp,
    damp: Ramp,
    predelay_ms: f32,
    reverb: Reverb,
}

impl ReverbDevice {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            smooth_samples: sample_rate as f64 * SMOOTH_MS * 1e-3,
            mix: Ramp::new(0.3),
            size: Ramp::new(0.5),
            damp: Ramp::new(0.5),
            predelay_ms: 0.0,
            reverb: Reverb::new(sample_rate),
        }
    }

    pub fn set_param(&mut self, param: u32, value: f32) {
        self.set_param_smooth(param, value, self.smooth_samples);
    }

    pub fn set_param_smooth(&mut self, param: u32, value: f32, s: f64) {
        if !value.is_finite() {
            return;
        }
        let v = value.clamp(0.0, 1.0) as f64;
        match param {
            0 => self.mix.set_target(v, s),
            1 => self.size.set_target(v, s),
            2 => self.damp.set_target(v, s),
            3 => self.predelay_ms = value.clamp(0.0, dsp::reverb::MAX_PREDELAY_MS),
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        self.reverb.reset();
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let (mix, size, damp) = (self.mix.value() as f32, self.size.value() as f32, self.damp.value() as f32);
        self.mix.advance(l.len());
        self.size.advance(l.len());
        self.damp.advance(l.len());
        self.reverb.process(l, r, size, damp, self.predelay_ms, mix);
    }
}

/// Kind 4: stereo-linked compressor. Params: 0 threshold (dB), 1 ratio, 2 attack (ms),
/// 3 release (ms), 4 makeup (dB). Threshold, ratio and makeup are smoothed (the values at each
/// segment start are used); attack and release jump, which only changes the envelope's pace.
pub struct CompressorDevice {
    smooth_samples: f64,
    threshold: Ramp,
    ratio: Ramp,
    makeup: Ramp,
    attack_ms: f32,
    release_ms: f32,
    comp: Compressor,
}

impl CompressorDevice {
    pub fn new(sample_rate: f32) -> Self {
        let d = CompParams::default();
        Self {
            smooth_samples: sample_rate as f64 * SMOOTH_MS * 1e-3,
            threshold: Ramp::new(d.threshold_db as f64),
            ratio: Ramp::new(d.ratio as f64),
            makeup: Ramp::new(d.makeup_db as f64),
            attack_ms: d.attack_ms,
            release_ms: d.release_ms,
            comp: Compressor::new(),
        }
    }

    pub fn set_param(&mut self, param: u32, value: f32) {
        self.set_param_smooth(param, value, self.smooth_samples);
    }

    pub fn set_param_smooth(&mut self, param: u32, value: f32, s: f64) {
        use dsp::compressor::*;
        if !value.is_finite() {
            return;
        }
        match param {
            0 => self.threshold.set_target(value.clamp(THRESHOLD_MIN, THRESHOLD_MAX) as f64, s),
            1 => self.ratio.set_target(value.clamp(RATIO_MIN, RATIO_MAX) as f64, s),
            2 => self.attack_ms = value.clamp(ATTACK_MIN_MS, ATTACK_MAX_MS),
            3 => self.release_ms = value.clamp(RELEASE_MIN_MS, RELEASE_MAX_MS),
            4 => self.makeup.set_target(value.clamp(0.0, MAKEUP_MAX) as f64, s),
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        self.comp.reset();
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let p = CompParams {
            threshold_db: self.threshold.value() as f32,
            ratio: self.ratio.value() as f32,
            attack_ms: self.attack_ms,
            release_ms: self.release_ms,
            makeup_db: self.makeup.value() as f32,
        };
        self.threshold.advance(l.len());
        self.ratio.advance(l.len());
        self.makeup.advance(l.len());
        self.comp.process(l, r, &p, sample_rate);
    }
}

/// Kind 5: tremolo. Params: 0 rate (Hz), 1 depth (0..1), 2 shape (0 sine, 1 triangle, 2 soft
/// square), 3 spread (0..1, left/right LFO offset). Rate (smoothed in the log2 domain, like the
/// filter's cutoff), depth and spread are smoothed, with the values at each segment start used;
/// shape jumps, which only changes the waveform's contour.
pub struct TremoloDevice {
    smooth_samples: f64,
    rate_log2: Ramp,
    depth: Ramp,
    spread: Ramp,
    shape: u32,
    trem: Tremolo,
}

impl TremoloDevice {
    pub fn new(sample_rate: f32) -> Self {
        let d = TremParams::default();
        Self {
            smooth_samples: sample_rate as f64 * SMOOTH_MS * 1e-3,
            rate_log2: Ramp::new((d.rate_hz as f64).log2()),
            depth: Ramp::new(d.depth as f64),
            spread: Ramp::new(d.spread as f64),
            shape: d.shape,
            trem: Tremolo::new(),
        }
    }

    pub fn set_param(&mut self, param: u32, value: f32) {
        self.set_param_smooth(param, value, self.smooth_samples);
    }

    pub fn set_param_smooth(&mut self, param: u32, value: f32, s: f64) {
        use dsp::tremolo::*;
        if !value.is_finite() {
            return;
        }
        match param {
            0 => self.rate_log2.set_target((value.clamp(RATE_MIN, RATE_MAX) as f64).log2(), s),
            1 => self.depth.set_target(value.clamp(0.0, 1.0) as f64, s),
            2 => self.shape = (value.round().clamp(0.0, (SHAPES - 1) as f32)) as u32,
            3 => self.spread.set_target(value.clamp(0.0, 1.0) as f64, s),
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        self.trem.reset();
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let p = TremParams {
            rate_hz: self.rate_log2.value().exp2() as f32,
            depth: self.depth.value() as f32,
            shape: self.shape,
            spread: self.spread.value() as f32,
        };
        self.rate_log2.advance(l.len());
        self.depth.advance(l.len());
        self.spread.advance(l.len());
        self.trem.process(l, r, &p, sample_rate);
    }
}

/// Kind 6: tape delay. Params: 0 mix, 1 time (ms), 2 feedback, 3 warble, 4 drive, 5 filter mode
/// (0 low-pass, 1 high-pass, 2 band-pass), 6 cutoff (Hz), 7 resonance. Mix, feedback, drive,
/// cutoff (in the log2 domain) and resonance are smoothed, with the values at each segment start
/// used. Time and warble go to the dsp as set, which glides them itself (the time is a moving tape
/// head, so it bends the echoes' pitch); the mode jumps.
pub struct DelayDevice {
    smooth_samples: f64,
    mix: Ramp,
    feedback: Ramp,
    drive: Ramp,
    cutoff_log2: Ramp,
    resonance: Ramp,
    p: DelayParams,
    delay: TapeDelay,
}

impl DelayDevice {
    pub fn new(sample_rate: f32) -> Self {
        let p = DelayParams::default();
        Self {
            smooth_samples: sample_rate as f64 * SMOOTH_MS * 1e-3,
            mix: Ramp::new(p.mix as f64),
            feedback: Ramp::new(p.feedback as f64),
            drive: Ramp::new(p.drive as f64),
            cutoff_log2: Ramp::new((p.cutoff_hz as f64).log2()),
            resonance: Ramp::new(p.resonance as f64),
            p,
            delay: TapeDelay::new(sample_rate),
        }
    }

    pub fn set_param(&mut self, param: u32, value: f32) {
        self.set_param_smooth(param, value, self.smooth_samples);
    }

    pub fn set_param_smooth(&mut self, param: u32, value: f32, s: f64) {
        use dsp::delay::*;
        if !value.is_finite() {
            return;
        }
        match param {
            0 => self.mix.set_target(value.clamp(0.0, 1.0) as f64, s),
            1 => self.p.time_ms = value.clamp(TIME_MIN_MS, TIME_MAX_MS),
            2 => self.feedback.set_target(value.clamp(0.0, FEEDBACK_MAX) as f64, s),
            3 => self.p.warble = value.clamp(0.0, 1.0),
            4 => self.drive.set_target(value.clamp(0.0, 1.0) as f64, s),
            5 => self.p.mode = (value.round().clamp(0.0, (MODES - 1) as f32)) as u32,
            6 => self.cutoff_log2.set_target((value.clamp(CUTOFF_MIN, CUTOFF_MAX) as f64).log2(), s),
            7 => self.resonance.set_target(value.clamp(0.0, 1.0) as f64, s),
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        self.delay.reset();
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.mix = self.mix.value() as f32;
        self.p.feedback = self.feedback.value() as f32;
        self.p.drive = self.drive.value() as f32;
        self.p.cutoff_hz = self.cutoff_log2.value().exp2() as f32;
        self.p.resonance = self.resonance.value() as f32;
        let n = l.len();
        self.mix.advance(n);
        self.feedback.advance(n);
        self.drive.advance(n);
        self.cutoff_log2.advance(n);
        self.resonance.advance(n);
        self.delay.process(l, r, &self.p);
    }
}
