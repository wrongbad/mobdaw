//! Devices: the effect/instrument processors in a track's chain.

use dsp::{CompParams, Compressor, DelayParams, LofiDrum, Ramp, Reverb, Svf, Synth, TapeDelay, TremParams, Tremolo};

pub const KIND_FILTER: u32 = 1;
pub const KIND_SYNTH: u32 = 2;
pub const KIND_REVERB: u32 = 3;
pub const KIND_COMPRESSOR: u32 = 4;
pub const KIND_TREMOLO: u32 = 5;
pub const KIND_DELAY: u32 = 6;
pub const KIND_LOFI_DRUM: u32 = 7;
pub const KIND_EQ: u32 = 8;

const SMOOTH_MS: f64 = 10.0;

fn all_zero(l: &[f32], r: &[f32]) -> bool {
    l.iter().chain(r.iter()).all(|&x| x == 0.0)
}

pub struct Device {
    pub track: u32,
    pub order: f64,
    pub bypass: bool,
    pub kind_id: u32,
    pub kind: DeviceKind,
    /// An instrument's note range (MIDI pitches, inclusive): it only gets the notes inside it.
    pub key_lo: u32,
    pub key_hi: u32,
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
    Lofi(Box<LofiDrum>),
    Eq(Box<EqDevice>),
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
            KIND_LOFI_DRUM => DeviceKind::Lofi(Box::new(LofiDrum::new(sample_rate))),
            KIND_EQ => DeviceKind::Eq(Box::new(EqDevice::new(sample_rate))),
            _ => DeviceKind::Unknown,
        };
        Self { track, order, bypass, kind_id, kind, key_lo: 0, key_hi: 127 }
    }

    pub fn is_instrument(&self) -> bool {
        matches!(self.kind, DeviceKind::Synth(_) | DeviceKind::Lofi(_))
    }

    /// Whether this is a sounding (not bypassed) instrument whose note range holds `pitch`.
    pub fn takes_note(&self, pitch: u32) -> bool {
        self.is_instrument() && !self.bypass && (self.key_lo..=self.key_hi).contains(&pitch)
    }

    /// Start a note (`start` is its timeline sample, the lofi drum's noise seed). `release_at`
    /// is when the synth lets go; the drum is a one-shot and ignores it.
    pub fn note_on(&mut self, pitch: u32, velocity: f32, release_at: i64, start: i64) {
        match &mut self.kind {
            DeviceKind::Synth(s) => s.note_on(pitch, velocity, release_at),
            DeviceKind::Lofi(d) => d.note_on(velocity, start),
            _ => {}
        }
    }

    /// Let go of a held live key (see [`Engine::note_live`]); the drum is a one-shot and ignores it.
    pub fn note_off(&mut self, pitch: u32) {
        if let DeviceKind::Synth(s) = &mut self.kind {
            s.release_key(pitch);
        }
    }

    /// Let go of the notes whose release time has come (instruments only).
    pub fn release_due(&mut self, now: i64) {
        if let DeviceKind::Synth(s) = &mut self.kind {
            s.release_due(now);
        }
    }

    /// The next scheduled release after `now`, or `i64::MAX`.
    pub fn next_release_after(&self, now: i64) -> i64 {
        match &self.kind {
            DeviceKind::Synth(s) => s.next_release_after(now),
            _ => i64::MAX,
        }
    }

    /// Release every sounding note (transport stop / seek).
    pub fn release_all(&mut self) {
        match &mut self.kind {
            DeviceKind::Synth(s) => s.release_all(),
            DeviceKind::Lofi(d) => d.release_all(),
            _ => {}
        }
    }

    /// Release the notes with a scheduled release (clip notes; a transport loop wrap). Held live keys and drum tails
    /// keep sounding.
    pub fn release_scheduled(&mut self) {
        if let DeviceKind::Synth(s) = &mut self.kind {
            s.release_scheduled();
        }
    }

    pub fn set_param(&mut self, param: u32, value: f32) {
        match &mut self.kind {
            DeviceKind::Filter(f) => f.set_param(param, value),
            DeviceKind::Synth(s) => s.set_param(param, value),
            DeviceKind::Reverb(v) => v.set_param(param, value),
            DeviceKind::Compressor(c) => c.set_param(param, value),
            DeviceKind::Tremolo(t) => t.set_param(param, value),
            DeviceKind::Delay(d) => d.set_param(param, value),
            DeviceKind::Lofi(d) => d.set_param(param, value),
            DeviceKind::Eq(e) => e.set_param(param, value),
            DeviceKind::Unknown => {}
        }
    }

    /// An automated value over one control segment of `len` samples: the param jumps to `from`
    /// (none of the glide a knob move gets) and, if it is a smoothed one, ramps linearly to `to`
    /// across the segment. Devices read their ramps at the segment start for coefficients and
    /// advance them per segment, so a ramp shows per sample where a device interpolates (the
    /// synth's and drum's gain) and as the exact end value for the next segment. Params that jump
    /// (mode, times, attack...) take `from` only.
    pub fn set_param_auto(&mut self, param: u32, from: f32, to: f32, len: usize) {
        self.set_param_smooth_dispatch(param, from, 0.0);
        if from != to && self.is_smoothed(param) {
            self.set_param_smooth_dispatch(param, to, len as f64);
        }
    }

    fn set_param_smooth_dispatch(&mut self, param: u32, value: f32, s: f64) {
        match &mut self.kind {
            DeviceKind::Filter(f) => f.set_param_smooth(param, value, s),
            DeviceKind::Synth(d) => d.set_param_smooth(param, value, s),
            DeviceKind::Reverb(v) => v.set_param_smooth(param, value, s),
            DeviceKind::Compressor(c) => c.set_param_smooth(param, value, s),
            DeviceKind::Tremolo(t) => t.set_param_smooth(param, value, s),
            DeviceKind::Delay(d) => d.set_param_smooth(param, value, s),
            DeviceKind::Lofi(d) => d.set_param_smooth(param, value, s),
            DeviceKind::Eq(e) => e.set_param_smooth(param, value, s),
            DeviceKind::Unknown => {}
        }
    }

    /// Whether any smoothed param of this effect is mid-glide. Devices read their ramps at the
    /// start of a run, so the engine cuts a gliding effect's run into control segments of at most
    /// 32 frames; at rest it runs the whole block.
    pub fn is_ramping(&self) -> bool {
        match &self.kind {
            DeviceKind::Filter(f) => f.cutoff_log2.is_moving() || f.damping.is_moving() || f.gain_db.is_moving(),
            DeviceKind::Reverb(v) => v.mix.is_moving() || v.size.is_moving() || v.damp.is_moving(),
            DeviceKind::Compressor(c) => c.threshold.is_moving() || c.ratio.is_moving() || c.makeup.is_moving(),
            DeviceKind::Tremolo(t) => t.rate_log2.is_moving() || t.depth.is_moving() || t.spread.is_moving(),
            DeviceKind::Delay(d) => d.mix.is_moving() || d.feedback.is_moving() || d.drive.is_moving() || d.cutoff_log2.is_moving() || d.resonance.is_moving(),
            DeviceKind::Synth(s) => s.is_ramping(),
            DeviceKind::Lofi(d) => d.is_ramping(),
            DeviceKind::Eq(e) => e.out_db.is_moving() || e.bands.iter().any(|b| b.freq_log2.is_moving() || b.gain_db.is_moving() || b.damping.is_moving()),
            DeviceKind::Unknown => false,
        }
    }

    /// An instrument with nothing sounding and nothing gliding: rendering it would add exact
    /// zeros and change no state, so the engine skips it. Effects are never idle (see `is_asleep`).
    pub fn is_idle_instrument(&self) -> bool {
        match &self.kind {
            DeviceKind::Synth(s) => !s.is_active(),
            DeviceKind::Lofi(d) => !d.is_active() && !d.is_ramping(),
            _ => false,
        }
    }

    /// Whether this effect, fed zeros, would output zeros and leave its audible state as it is
    /// (or within -120 dB of it), so the engine may skip it while its input is all zero. Never true
    /// mid-glide (a skipped run would not advance the ramps).
    pub fn is_asleep(&self) -> bool {
        if self.bypass {
            return true;
        }
        if self.is_ramping() {
            return false;
        }
        match &self.kind {
            DeviceKind::Unknown => true,
            DeviceKind::Filter(f) => f.svf[0].is_zero() && f.svf[1].is_zero(),
            DeviceKind::Compressor(c) => c.comp.reduction_db() == 0.0,
            DeviceKind::Tremolo(_) => true,
            DeviceKind::Reverb(v) => v.zero_run >= v.reverb.tail_samples(v.size_max),
            DeviceKind::Delay(d) => d.is_asleep(),
            DeviceKind::Eq(e) => e.bands.iter().all(|b| b.st == [[0.0; 2]; 2]),
            DeviceKind::Synth(_) | DeviceKind::Lofi(_) => false,
        }
    }

    /// Account for `n` skipped frames of silence on an asleep effect.
    pub fn skip(&mut self, n: usize, sample_rate: f32) {
        match &mut self.kind {
            DeviceKind::Reverb(v) => v.zero_run += n as u64,
            DeviceKind::Delay(d) => d.zero_run += n as u64,
            DeviceKind::Tremolo(t) => t.skip(n, sample_rate),
            _ => {}
        }
    }

    /// Whether `param` of this device glides (a `Ramp`) rather than jumping. Keep in step with
    /// each device's `set_param_smooth`.
    fn is_smoothed(&self, param: u32) -> bool {
        match &self.kind {
            DeviceKind::Filter(_) => matches!(param, 1..=3),
            DeviceKind::Synth(_) => matches!(param, dsp::synth::P_ROLLOFF | dsp::synth::P_ENV_TO_ROLLOFF | dsp::synth::P_SUSTAIN | dsp::synth::P_GAIN),
            DeviceKind::Reverb(_) => matches!(param, 0..=2),
            DeviceKind::Compressor(_) => matches!(param, 0 | 1 | 4),
            DeviceKind::Tremolo(_) => matches!(param, 0 | 1 | 3),
            DeviceKind::Delay(_) => matches!(param, 0 | 2 | 4 | 6 | 7),
            DeviceKind::Lofi(_) => matches!(param, dsp::lofidrum::P_CUTOFF | dsp::lofidrum::P_RESONANCE | dsp::lofidrum::P_GAIN),
            DeviceKind::Eq(_) => param <= 12,
            DeviceKind::Unknown => false,
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
            DeviceKind::Lofi(d) => d.reset(),
            DeviceKind::Eq(e) => e.reset(),
            DeviceKind::Unknown => {}
        }
    }

    /// Process a stretch of the track's stereo buffer (instruments get at most 32 samples at a
    /// time: they are segmented at notes; effects get whole blocks or the pieces between their
    /// own lane breakpoints).
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
            DeviceKind::Eq(e) => e.process(l, r, sample_rate),
            DeviceKind::Synth(s) => {
                for (l, r) in l.chunks_mut(dsp::finnwave::SUB_BLOCK).zip(r.chunks_mut(dsp::finnwave::SUB_BLOCK)) {
                    let mut mono = [0.0f32; dsp::finnwave::SUB_BLOCK];
                    let mono = &mut mono[..l.len()];
                    s.render_add(mono);
                    for ((l, r), m) in l.iter_mut().zip(r.iter_mut()).zip(mono.iter()) {
                        *l += *m;
                        *r += *m;
                    }
                }
            }
            DeviceKind::Lofi(d) => {
                for (l, r) in l.chunks_mut(dsp::finnwave::SUB_BLOCK).zip(r.chunks_mut(dsp::finnwave::SUB_BLOCK)) {
                    let mut mono = [0.0f32; dsp::finnwave::SUB_BLOCK];
                    let mono = &mut mono[..l.len()];
                    d.render_add(mono);
                    for ((l, r), m) in l.iter_mut().zip(r.iter_mut()).zip(mono.iter()) {
                        *l += *m;
                        *r += *m;
                    }
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
    /// Inputs the cached `coefs` were computed from: mode, cutoff Hz, damping, gain dB, sample rate. Coefficients
    /// (a `tan`, a `powf`) are only recomputed when these change, i.e. not while all ramps are at rest.
    key: Option<(u32, f32, f32, f32, f32)>,
    coefs: dsp::svf::SvfCoefs,
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
            key: None,
            coefs: dsp::svf::SvfCoefs::from_g(0.0, 1.0),
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
        let gain_at_rest = self.gain_db.value() == self.gain_db.target();
        self.cutoff_log2.advance(len);
        self.damping.advance(len);
        self.gain_db.advance(len);

        // A bell or shelf at exactly 0 dB is the identity (A == 1 gives m0 = 1, m1 = m2 = 0): skip it, and clear the
        // state so that when the gain moves away from 0 the filter starts clean instead of from stale memory.
        if self.mode >= 5 && gain_db == 0.0 && gain_at_rest {
            self.reset();
            return;
        }

        let key = (self.mode, cutoff, damping, gain_db, sample_rate);
        if self.key != Some(key) {
            self.key = Some(key);
            self.coefs = self.make_coefs(cutoff, damping, gain_db, sample_rate);
        }
        // One tan, shared by L and R; every mode is a mix of the same two SVF outputs.
        Svf::process_block_stereo(&mut self.svf, l, r, &self.coefs);
    }

    fn make_coefs(&self, cutoff: f32, damping: f32, gain_db: f32, sample_rate: f32) -> dsp::svf::SvfCoefs {
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
            return dsp::svf::SvfCoefs::from_hz(cutoff, damping, sample_rate, warp).with_mix(m0, m1, m2);
        }
        let c = dsp::svf::SvfCoefs::from_hz(cutoff, damping, sample_rate, 1.0);
        match self.mode {
            0 => c.lowpass(),
            1 => c.highpass(),
            2 => c.bandpass(),
            3 => c.notch(),
            _ => c.peak(),
        }
    }
}

/// Kind 8: four-band EQ (low shelf, bell, bell, high shelf). Params: `band*3 + {0 freq Hz, 1 gain dB, 2 damping}`
/// for bands 0..3, and 12 output gain (dB). Same smoothing and SVF mixes as `FilterDevice`'s bell and shelves, but
/// all active bands run in one fused per-sample loop with L and R interleaved.
pub struct EqDevice {
    smooth_samples: f64,
    bands: [EqBand; 4],
    out_db: Ramp,
}

struct EqBand {
    freq_log2: Ramp,
    gain_db: Ramp,
    damping: Ramp,
    /// Integrator states `[ic1, ic2]` per channel.
    st: [[f32; 2]; 2],
    key: Option<(f32, f32, f32, f32)>,
    coefs: dsp::svf::SvfCoefs,
}

const EQ_DEFAULT_HZ: [f64; 4] = [100.0, 500.0, 2000.0, 8000.0];

impl EqDevice {
    pub fn new(sample_rate: f32) -> Self {
        let band = |i: usize| EqBand {
            freq_log2: Ramp::new(EQ_DEFAULT_HZ[i].log2()),
            gain_db: Ramp::new(0.0),
            damping: Ramp::new(std::f64::consts::FRAC_1_SQRT_2),
            st: [[0.0; 2]; 2],
            key: None,
            coefs: dsp::svf::SvfCoefs::from_g(0.0, 1.0),
        };
        Self { smooth_samples: sample_rate as f64 * SMOOTH_MS * 1e-3, bands: [band(0), band(1), band(2), band(3)], out_db: Ramp::new(0.0) }
    }

    pub fn set_param(&mut self, param: u32, value: f32) {
        self.set_param_smooth(param, value, self.smooth_samples);
    }

    pub fn set_param_smooth(&mut self, param: u32, value: f32, s: f64) {
        if !value.is_finite() {
            return;
        }
        if param == 12 {
            self.out_db.set_target(value.clamp(-24.0, 24.0) as f64, s);
            return;
        }
        let Some(b) = self.bands.get_mut((param / 3) as usize) else { return };
        match param % 3 {
            0 => b.freq_log2.set_target((value.clamp(20.0, 20000.0) as f64).log2(), s),
            1 => b.gain_db.set_target(value.clamp(-24.0, 24.0) as f64, s),
            _ => b.damping.set_target(value.clamp(0.05, 2.0) as f64, s),
        }
    }

    pub fn reset(&mut self) {
        for b in &mut self.bands {
            b.st = [[0.0; 2]; 2];
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let len = l.len();
        let nyquist_limit = 0.99 * 0.5 * sample_rate as f64;
        let mut active = [0usize; 4];
        let mut n = 0;
        for (i, b) in self.bands.iter_mut().enumerate() {
            let freq = b.freq_log2.value().exp2().min(nyquist_limit) as f32;
            let damping = b.damping.value() as f32;
            let gain_db = b.gain_db.value() as f32;
            let at_rest = b.gain_db.value() == b.gain_db.target();
            b.freq_log2.advance(len);
            b.damping.advance(len);
            b.gain_db.advance(len);
            if gain_db == 0.0 && at_rest {
                b.st = [[0.0; 2]; 2];
                continue;
            }
            let key = (freq, damping, gain_db, sample_rate);
            if b.key != Some(key) {
                b.key = Some(key);
                // Cytomic's SVF mixes, as in FilterDevice: out = m0*x + m1*bp + m2*lp, A = 10^(dB/40).
                let a = 10f32.powf(gain_db / 40.0);
                let a2 = a * a;
                let k = 2.0 * damping;
                let (warp, damping, m0, m1, m2) = match i {
                    0 => (1.0 / a.sqrt(), damping, 1.0, k * (a - 1.0), a2 - 1.0),
                    3 => (a.sqrt(), damping, a2, k * (1.0 - a) * a, 1.0 - a2),
                    _ => (1.0, damping / a, 1.0, k / a * (a2 - 1.0), 0.0),
                };
                b.coefs = dsp::svf::SvfCoefs::from_hz(freq, damping, sample_rate, warp).with_mix(m0, m1, m2);
            }
            active[n] = i;
            n += 1;
        }
        let out_db = self.out_db.value();
        let out_rest = out_db == self.out_db.target();
        self.out_db.advance(len);
        let out_gain = if out_db == 0.0 && out_rest { None } else { Some(10f32.powf(out_db as f32 / 20.0)) };

        if n > 0 {
            let mut c = [self.bands[0].coefs; 4];
            let mut s = [[[0.0f32; 2]; 2]; 4];
            for (j, &i) in active[..n].iter().enumerate() {
                c[j] = self.bands[i].coefs;
                s[j] = self.bands[i].st;
            }
            for (x, y) in l.iter_mut().zip(r.iter_mut()) {
                let (mut sl, mut sr) = (*x, *y);
                for j in 0..n {
                    let c = &c[j];
                    let st = &mut s[j];
                    let (xl, xr) = (sl, sr);
                    let v3l = xl - st[0][1];
                    let v3r = xr - st[1][1];
                    let v1l = c.a1 * st[0][0] + c.a2 * v3l;
                    let v1r = c.a1 * st[1][0] + c.a2 * v3r;
                    let v2l = st[0][1] + c.a2 * st[0][0] + c.a3 * v3l;
                    let v2r = st[1][1] + c.a2 * st[1][0] + c.a3 * v3r;
                    st[0][0] = 2.0 * v1l - st[0][0];
                    st[1][0] = 2.0 * v1r - st[1][0];
                    st[0][1] = 2.0 * v2l - st[0][1];
                    st[1][1] = 2.0 * v2r - st[1][1];
                    sl = c.m0 * xl + c.m1 * v1l + c.m2 * v2l;
                    sr = c.m0 * xr + c.m1 * v1r + c.m2 * v2r;
                }
                *x = sl;
                *y = sr;
            }
            for (j, &i) in active[..n].iter().enumerate() {
                let mut st = s[j];
                for ch in st.iter_mut() {
                    ch[0] = dsp::flush_denormal(ch[0]);
                    ch[1] = dsp::flush_denormal(ch[1]);
                }
                self.bands[i].st = st;
            }
        }
        if let Some(g) = out_gain {
            for v in l.iter_mut().chain(r.iter_mut()) {
                *v *= g;
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
    /// Consecutive frames of all-zero input, and the largest size over that stretch (sleep).
    zero_run: u64,
    size_max: f32,
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
            zero_run: u64::MAX / 2,
            size_max: 0.0,
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
        self.zero_run = u64::MAX / 2;
        self.reverb.reset();
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let (mix, size, damp) = (self.mix.value() as f32, self.size.value() as f32, self.damp.value() as f32);
        self.mix.advance(l.len());
        self.size.advance(l.len());
        self.damp.advance(l.len());
        let quiet = all_zero(l, r);
        let size_now = size.max(self.size.target() as f32);
        self.size_max = if quiet { self.size_max.max(size_now) } else { size_now };
        self.zero_run = if quiet { self.zero_run + l.len() as u64 } else { 0 };
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

    pub fn skip(&mut self, n: usize, sample_rate: f32) {
        let p = TremParams {
            rate_hz: self.rate_log2.value().exp2() as f32,
            depth: self.depth.value() as f32,
            shape: self.shape,
            spread: self.spread.value() as f32,
        };
        self.trem.skip(n, &p, sample_rate);
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
    sample_rate: f32,
    /// Consecutive frames of all-zero input, and the largest feedback and time over that stretch (sleep).
    zero_run: u64,
    fb_max: f32,
    time_max_ms: f32,
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
            sample_rate,
            zero_run: u64::MAX / 2,
            fb_max: 0.0,
            time_max_ms: 0.0,
        }
    }

    /// Asleep once zero input has outlasted every echo down to -120 dB. Never with feedback of 1 or
    /// more, and not with warble on (it would stop the warble's phase, changing the next echoes).
    fn is_asleep(&self) -> bool {
        if self.fb_max >= 1.0 || self.p.warble != 0.0 {
            return false;
        }
        let passes = if self.fb_max <= 0.0 { 1.0 } else { (1e-6f64.ln() / (self.fb_max as f64).ln()).ceil() };
        let ms = self.time_max_ms as f64 + 100.0;
        self.zero_run as f64 >= ms * 1e-3 * self.sample_rate as f64 * (passes * 1.5 + 2.0)
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
        self.zero_run = u64::MAX / 2;
        self.delay.reset();
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.mix = self.mix.value() as f32;
        self.p.feedback = self.feedback.value() as f32;
        self.p.drive = self.drive.value() as f32;
        self.p.cutoff_hz = self.cutoff_log2.value().exp2() as f32;
        self.p.resonance = self.resonance.value() as f32;
        let n = l.len();
        let quiet = all_zero(l, r);
        let (fb_now, t_now) = (self.p.feedback.max(self.feedback.target() as f32), self.p.time_ms);
        self.fb_max = if quiet { self.fb_max.max(fb_now) } else { fb_now };
        self.time_max_ms = if quiet { self.time_max_ms.max(t_now) } else { t_now };
        self.zero_run = if quiet { self.zero_run + n as u64 } else { 0 };
        self.mix.advance(n);
        self.feedback.advance(n);
        self.drive.advance(n);
        self.cutoff_log2.advance(n);
        self.resonance.advance(n);
        self.delay.process(l, r, &self.p);
    }
}
