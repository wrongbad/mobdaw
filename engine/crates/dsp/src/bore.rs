//! bore: one delay-line loop (a bore or a string) excited at one point by a nonlinear valve.
//! The plan and the reasoning are in docs/bore.md; this is the raw, uncalibrated core. The
//! calibrated knobs live in [`crate::bore_cal`] and the polyphonic device in [`crate::boresynth`].
//!
//! # Structure
//! The loop is a string of one-way length `RT/2` samples, split at the junction (position `p`)
//! into two legs. Each leg is a delay line holding the round trip out to its end and back, so it
//! contains the end's reflection:
//!
//! ```text
//!           ┌── leg L: delay p·RT,  end reflects −m ──┐
//!   a_L ◀───┤                                          ├───▶ a_R
//!           └── junction (waves a_L, a_R arrive) ─────┘   leg R: delay (1−p)·RT, reflects ∓m
//! ```
//!
//! At each sample the waves `a_L`, `a_R` arriving at the junction sum to the bore state
//! `v = a_L + a_R`. The valve sees `Δ = drive − v` and adds `y = Δ·g(Δ)` (see [`junction`]),
//! `g` in `[0, 1]`. Half of `y` goes into each outgoing wave:
//!
//! ```text
//!   out_L = a_R + y/2        out_R = a_L + y/2        v' = v + y = v + g·(drive − v)
//! ```
//!
//! so `g = 1` pins the bore state to the drive exactly (a bow sticking to the string), and
//! `g = 0` leaves the loop untouched. The state `v'` (DC-blocked) is the output.
//!
//! The round trip is `P` samples when both ends invert (an open bore or a string: all
//! harmonics, period `P`) and `P/2` when the right end does not (a closed bore: odd harmonics,
//! the period is twice the round trip). `m = sqrt(reflection)` per end, so `reflection` is the
//! loop gain per round trip.
//!
//! # Loop elements
//! * Fractional delay: an integer delay line plus a first-order allpass (flat magnitude, so the
//!   harmonics stay sharp; delay fixed per note so there is no time-varying interpolation).
//! * Damping: a symmetric three-tap FIR `[c, 1-2c, c]`, `c = damping/4`. Linear phase, so its
//!   delay is exactly one sample whatever `damping` is: turning the knob never detunes a held
//!   note.
//! * Output DC block: `y[n] = x[n] − x[n−1] + 0.995·y[n−1]`.
//!
//! # Drive
//! `drive = D · gate · (1 + burst) · (1 + noise·white + vibrato·sin)`. The gate slews linearly
//! (attack up, release down); `burst` is wade's `velbias`, a velocity-sized extra push that
//! decays into the sustained level. White noise is a xorshift, seeded per note.
//!
//! # Bell
//! A closed bore only supports odd harmonics, so its loop signal is close to a square wave. On a
//! real clarinet the even harmonics come back above ~1.5 kHz (radiation from the bell and tone
//! holes, and the reed's asymmetric flow). `bell` adds them outside the loop by ring modulation:
//! the output high-passed at [`BELL_HZ`] (its upper odd harmonics) times a unit-level copy of the
//! fundamental (the output band-passed at the note's frequency, over its own envelope). Each odd
//! harmonic `k·f0` lands on `(k±1)·f0`: even harmonics at about their neighbours' level, only up
//! high; the sum is high-passed again so no low products leak. (Squaring the output would not do:
//! a square wave squared is constant.) Outside the loop, so tuning and calibration are untouched.
//!
//! # Noise paths
//! Besides the drive noise above, three knobs make the tone less static, each with its own noise
//! source (so the drive noise's sequence, and a preset that doesn't use them, are unchanged):
//! * `valve_noise`: relative jitter of the valve itself (reed/jet opening, bow force), inside
//!   `g(Δ)`. The valve only acts for part of each cycle, so this noise comes out pulsed at the
//!   note's period (reed-slit turbulence, bow scratch), not as a flat hiss.
//! * `wander`: slow random drift (a one-pole low-pass at [`WANDER_HZ`]) of the drive and the
//!   opening: the small level and timbre fluctuation of a real breath or bow.
//! * `air`: radiated breath noise outside the loop, high-passed at [`AIR_HZ`] and shaped by the
//!   junction flow: `|y| / env(|y|) · env(|out|)`, a pulse at the note's period at the output's
//!   level, so it pulses with the oscillation and follows the note's level. The
//!   loop filters anything injected into it, so in-loop noise can't reach a flute's 4-12 kHz hiss.
//!
//! # Pitch vibrato
//! The same LFO can also retune the loop (`pitch_vibrato` cents peak): both legs are rescaled once
//! per sub-block, the junction staying at the same fraction. This is a string player's (or a
//! singer's) vibrato; the drive vibrato above is a wind player's breath vibrato.

use crate::util::flush_denormal;

/// Delay line capacity per leg (samples); a power of two.
pub const CAP: usize = 2048;
const MASK: usize = CAP - 1;
/// Shortest leg (samples, including the damping FIR's one): the allpass needs at least a
/// 1.5-sample line and one more for the FIR.
pub const MIN_LEG: f64 = 3.0;
/// Control sub-block length: junction coefficients are computed once per sub-block.
pub const SUB_BLOCK: usize = 32;
/// The burst decays with this time constant.
const BURST_MS: f64 = 60.0;
/// How strong a full-velocity burst is, as a fraction of the drive.
const BURST_GAIN: f32 = 0.25;
/// Scales for the noise and vibrato drive modulation at knob 1.
const NOISE_SCALE: f32 = 0.5;
const VIBRATO_SCALE: f32 = 0.25;
/// Bell: high-pass corner (Hz) of the even-harmonic path, and the envelope follower's time constant.
pub const BELL_HZ: f32 = 1200.0;
/// Gain of the even-harmonic path at knob 1: ~+12 dB over unity, so the upper evens can reach their odd neighbours
/// (a clarinet's do, above ~1.5 kHz).
pub const BELL_GAIN: f32 = 4.0;
const BELL_ENV_MS: f64 = 10.0;
/// Valve noise: relative jitter of the opening / bow force at knob 1.
pub const VALVE_NOISE_REL: f32 = 0.3;
/// Wander: corner of the slow noise, and its relative depth on the drive and on the opening at knob 1.
pub const WANDER_HZ: f64 = 8.0;
pub const WANDER_DRIVE: f32 = 0.15;
pub const WANDER_VALVE: f32 = 0.1;
/// Air: high-pass corner (Hz) and gain at knob 1, relative to the junction flow.
pub const AIR_HZ: f32 = 2500.0;
/// (High-passed uniform white is ~0.5 RMS, so knob 1 puts the air ~6 dB under the tone overall; a flute's breath
/// noise is far under its tone overall but rivals the weak harmonics above 4 kHz.)
pub const AIR_GAIN: f32 = 1.0;
/// Pitch vibrato peak deviation at knob 1, in cents.
pub const PITCH_VIBRATO_CENTS: f32 = 60.0;
const DC_POLE: f32 = 0.995;

/// The longest leg the delay lines can hold.
pub const MAX_LEG: f64 = (CAP - 4) as f64;

/// Raw, block-constant settings. `aperture` and `drive` are the raw valve controls (not the
/// calibrated knobs); the calibration maps knobs onto them.
#[derive(Clone, Copy, Debug)]
pub struct Raw {
    /// 0 reed, 0.5 jet, 1 bow.
    pub character: f32,
    /// 0..1: reed slope, jet curvature, bow friction falloff.
    pub stiffness: f32,
    /// Reed/jet offset, or bow force: see [`junction`].
    pub aperture: f32,
    /// Sustained drive level (breath pressure / bow speed).
    pub drive: f32,
    /// 0..1: loop lowpass.
    pub damping: f32,
    /// Loop gain per round trip, 0..1.
    pub reflection: f32,
    /// 0..1.
    pub noise: f32,
    /// 0..1.
    pub vibrato_depth: f32,
    /// 0..1: pitch vibrato, [`PITCH_VIBRATO_CENTS`] peak at 1.
    pub pitch_vibrato: f32,
    /// 0..1: even harmonics up high, see the module docs.
    pub bell: f32,
    /// 0..1: noise paths, see the module docs.
    pub valve_noise: f32,
    pub air: f32,
    pub wander: f32,
}

impl Default for Raw {
    fn default() -> Self {
        Self { character: 0.0, stiffness: 0.5, aperture: 0.7, drive: 1.0, damping: 0.3, reflection: 0.95, noise: 0.0, vibrato_depth: 0.0, pitch_vibrato: 0.0, bell: 0.0, valve_noise: 0.0, air: 0.0, wander: 0.0 }
    }
}

/// The valve coefficients for one sub-block, derived from [`Raw`].
#[derive(Clone, Copy, Debug)]
pub struct Valve {
    w_reed: f32,
    w_jet: f32,
    w_bow: f32,
    aperture: f32,
    reed_slope: f32,
    jet_curve: f32,
    bow_force: f32,
    bow_fall: f32,
}

/// Bow force at `aperture` 1.
pub const BOW_FORCE_SCALE: f32 = 0.4;

impl Valve {
    pub fn new(r: &Raw) -> Self {
        let c = r.character.clamp(0.0, 1.0);
        let (w_reed, w_jet, w_bow) = if c < 0.5 { (1.0 - 2.0 * c, 2.0 * c, 0.0) } else { (0.0, 2.0 - 2.0 * c, 2.0 * c - 1.0) };
        let s = r.stiffness.clamp(0.0, 1.0);
        Self {
            w_reed,
            w_jet,
            w_bow,
            aperture: r.aperture.max(0.0),
            reed_slope: 0.1 + 0.5 * s,
            jet_curve: 0.3 + 1.7 * s,
            bow_force: BOW_FORCE_SCALE * r.aperture.max(0.0),
            bow_fall: 1.0 + 7.0 * s,
        }
    }

    /// The opening `g(Δ)` in `[0, 1]`.
    ///
    /// | curve | g(Δ) |
    /// |---|---|
    /// | reed | `clamp(aperture − slope·Δ, 0, 1)`: one-sided, closes under pressure |
    /// | jet | `clamp(aperture − curve·Δ², 0, 1)`: symmetric, `y = Δ − curve·Δ³` when aperture is 1 |
    /// | bow | `min(1, force·(0.3 + 1/(1 + fall·|Δ|)) / |Δ|)`: stick-slip friction |
    #[inline(always)]
    pub fn opening(&self, d: f32) -> f32 {
        self.opening_jit(d, 1.0)
    }

    /// [`Valve::opening`] with the reed/jet opening and the bow force scaled by `k` (valve noise and wander).
    #[inline(always)]
    pub fn opening_jit(&self, d: f32, k: f32) -> f32 {
        let mut g = 0.0;
        if self.w_reed > 0.0 {
            g += self.w_reed * (k * self.aperture - self.reed_slope * d).clamp(0.0, 1.0);
        }
        if self.w_jet > 0.0 {
            g += self.w_jet * (k * self.aperture - self.jet_curve * d * d).clamp(0.0, 1.0);
        }
        if self.w_bow > 0.0 {
            let a = d.abs();
            let f = k * self.bow_force * (0.3 + 1.0 / (1.0 + self.bow_fall * a));
            g += self.w_bow * if f >= a { 1.0 } else { f / a };
        }
        g
    }
}

/// Free function form of [`Valve::opening`] for docs and tests.
pub fn junction(raw: &Raw, delta: f32) -> f32 {
    delta * Valve::new(raw).opening(delta)
}

struct Leg {
    buf: Box<[f32]>,
    w: usize,
    d_int: usize,
    eta: f32,
    ap_x1: f32,
    ap_y1: f32,
    h1: f32,
    h2: f32,
    /// Signed end reflection magnitude.
    refl: f32,
}

impl Leg {
    fn new() -> Self {
        Self { buf: vec![0.0; CAP].into_boxed_slice(), w: 0, d_int: 1, eta: 0.0, ap_x1: 0.0, ap_y1: 0.0, h1: 0.0, h2: 0.0, refl: 0.0 }
    }

    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.ap_x1 = 0.0;
        self.ap_y1 = 0.0;
        self.h1 = 0.0;
        self.h2 = 0.0;
    }

    /// Total leg delay `len` samples: integer line + allpass (0.5..1.5) + the FIR's one.
    fn set_len(&mut self, len: f64) {
        let d = (len.clamp(MIN_LEG, MAX_LEG)) - 1.0;
        let di = (d - 0.5).floor();
        let f = d - di;
        self.d_int = di as usize;
        self.eta = ((1.0 - f) / (1.0 + f)) as f32;
    }

    /// The wave arriving at the junction.
    #[inline(always)]
    fn pull(&mut self, c: f32) -> f32 {
        let x = self.buf[(self.w + CAP - self.d_int) & MASK];
        let y = self.eta * (x - self.ap_y1) + self.ap_x1;
        self.ap_x1 = x;
        self.ap_y1 = flush_denormal(y);
        let z = c * (y + self.h2) + (1.0 - 2.0 * c) * self.h1;
        self.h2 = self.h1;
        self.h1 = flush_denormal(y);
        z * self.refl
    }

    #[inline(always)]
    fn push(&mut self, v: f32) {
        self.buf[self.w] = flush_denormal(v);
        self.w = (self.w + 1) & MASK;
    }
}

/// One voice.
pub struct Bore {
    sample_rate: f64,
    left: Leg,
    right: Leg,
    gate: f32,
    gate_target: f32,
    attack_step: f32,
    release_step: f32,
    burst: f32,
    burst_decay: f32,
    rng: u32,
    /// Separate noise sources for the valve noise / wander and for the air.
    rng2: u32,
    rng3: u32,
    /// Wander: the slow noise's state and per-sub-block coefficient.
    wander_s: f32,
    wander_a: f32,
    air_hp: crate::svf::Svf,
    air_env_y: f32,
    air_env_o: f32,
    lfo_phase: f64,
    lfo_inc: f64,
    lfo_prev: f32,
    dc_x1: f32,
    dc_y1: f32,
    silent_blocks: u32,
    right_sign_open: bool,
    /// The note's leg lengths (samples), before pitch vibrato.
    len_l: f64,
    len_r: f64,
    /// Vibrato fade-in: current gain (0..1) and its step per sample.
    vib_gain: f32,
    vib_step: f32,
    /// Bell path: envelope follower and high-pass.
    bell_env: f32,
    bell_a: f32,
    bell_hp: crate::svf::Svf,
    bell_lp: crate::svf::Svf,
    bell_hp2: crate::svf::Svf,
    /// Whether the legs currently differ from `len_l`/`len_r` (so they are reset when vibrato stops).
    detuned: bool,
}

/// Everything that fixes a note's loop: frequency, bore, junction position.
#[derive(Clone, Copy, Debug)]
pub struct NoteSetup {
    pub freq_hz: f32,
    /// Open bore (all harmonics) or closed (odd harmonics, an octave lower for the same loop).
    pub open: bool,
    pub position: f32,
    /// Tuning correction in cents (positive: the note measured sharp, so the loop is lengthened).
    pub tune_cents: f32,
    pub velocity: f32,
    pub seed: u32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub vibrato_hz: f32,
    /// Vibrato (drive and pitch) fades in linearly over this long from the note start.
    pub vibrato_delay_ms: f32,
}

impl Default for NoteSetup {
    fn default() -> Self {
        Self { freq_hz: 220.0, open: true, position: 0.3, tune_cents: 0.0, velocity: 0.8, seed: 1, attack_ms: 20.0, release_ms: 80.0, vibrato_hz: 5.0, vibrato_delay_ms: 0.0 }
    }
}

impl Bore {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate: sample_rate as f64,
            left: Leg::new(),
            right: Leg::new(),
            gate: 0.0,
            gate_target: 0.0,
            attack_step: 1.0,
            release_step: 1.0,
            burst: 0.0,
            burst_decay: 1.0,
            rng: 1,
            rng2: 1,
            rng3: 1,
            wander_s: 0.0,
            wander_a: (1.0 - (-std::f64::consts::TAU * WANDER_HZ * SUB_BLOCK as f64 / sample_rate as f64).exp()) as f32,
            air_env_y: 0.0,
            air_env_o: 0.0,
            air_hp: {
                let mut f = crate::svf::Svf::new();
                f.set_hz(AIR_HZ, std::f32::consts::FRAC_1_SQRT_2, sample_rate);
                f
            },
            lfo_phase: 0.0,
            lfo_inc: 0.0,
            lfo_prev: 0.0,
            dc_x1: 0.0,
            dc_y1: 0.0,
            silent_blocks: 0,
            right_sign_open: true,
            len_l: MIN_LEG,
            len_r: MIN_LEG,
            detuned: false,
            vib_gain: 1.0,
            vib_step: 1.0,
            bell_env: 0.0,
            bell_a: (1.0 - (-1.0 / (BELL_ENV_MS * 1e-3 * sample_rate as f64)).exp()) as f32,
            bell_hp: {
                let mut f = crate::svf::Svf::new();
                f.set_hz(BELL_HZ, std::f32::consts::FRAC_1_SQRT_2, sample_rate);
                f
            },
            bell_lp: crate::svf::Svf::new(),
            bell_hp2: {
                let mut f = crate::svf::Svf::new();
                f.set_hz(BELL_HZ, std::f32::consts::FRAC_1_SQRT_2, sample_rate);
                f
            },
        }
    }

    /// The round trip in samples for a note, or `None` when the loop cannot hold it (too low:
    /// longer than the delay lines).
    pub fn round_trip(sample_rate: f64, freq_hz: f64, open: bool, tune_cents: f64) -> f64 {
        let p = sample_rate / freq_hz;
        let rt = if open { p } else { 0.5 * p };
        rt * (tune_cents / 1200.0).exp2()
    }

    /// Whether the loop can hold this note at this position (the low-note limit).
    pub fn fits(sample_rate: f32, freq_hz: f32, open: bool, position: f32) -> bool {
        let rt = Self::round_trip(sample_rate as f64, freq_hz as f64, open, 0.0);
        let p = position.clamp(0.0, 1.0) as f64;
        rt * p.max(1.0 - p) <= MAX_LEG - 1.0
    }

    /// Start a note: clear the loop, set the delays and begin the gate's attack. Allocation free.
    pub fn start(&mut self, n: &NoteSetup) {
        self.left.clear();
        self.right.clear();
        let rt = Self::round_trip(self.sample_rate, n.freq_hz as f64, n.open, n.tune_cents as f64);
        // Keep each leg at least MIN_LEG long by moving the junction, never by detuning.
        let min_p = (MIN_LEG / rt).min(0.5);
        let p = (n.position as f64).clamp(min_p, 1.0 - min_p);
        self.len_l = rt * p;
        self.len_r = rt * (1.0 - p);
        self.left.set_len(self.len_l);
        self.right.set_len(self.len_r);
        self.detuned = false;
        let ms = self.sample_rate * 1e-3;
        self.attack_step = (1.0 / (n.attack_ms as f64 * ms).max(1.0)) as f32;
        self.release_step = (1.0 / (n.release_ms as f64 * ms).max(1.0)) as f32;
        self.gate = 0.0;
        self.gate_target = 1.0;
        self.burst = n.velocity.clamp(0.0, 1.0);
        self.burst_decay = (-1.0 / (BURST_MS * ms)).exp() as f32;
        self.rng = n.seed.wrapping_mul(2_654_435_761) | 1;
        self.rng2 = n.seed.wrapping_mul(2_246_822_519).wrapping_add(0x9e37_79b9) | 1;
        self.rng3 = n.seed.wrapping_mul(3_266_489_917).wrapping_add(0x7f4a_7c15) | 1;
        self.wander_s = 0.0;
        self.air_hp.reset();
        self.air_env_y = 0.0;
        self.air_env_o = 0.0;
        self.lfo_phase = 0.0;
        self.lfo_inc = n.vibrato_hz.max(0.0) as f64 / self.sample_rate;
        self.lfo_prev = 0.0;
        let delay = n.vibrato_delay_ms.max(0.0) as f64 * self.sample_rate * 1e-3;
        (self.vib_gain, self.vib_step) = if delay < 1.0 { (1.0, 1.0) } else { (0.0, (1.0 / delay) as f32) };
        self.dc_x1 = 0.0;
        self.dc_y1 = 0.0;
        self.bell_env = 0.0;
        self.bell_hp.reset();
        self.bell_lp.reset();
        self.bell_hp2.reset();
        self.bell_lp.set_hz(n.freq_hz, std::f32::consts::FRAC_1_SQRT_2, self.sample_rate as f32);
        self.silent_blocks = 0;
        self.left.refl = 0.0;
        self.right.refl = 0.0;
        // The right end inverts in an open bore, reflects in phase in a closed one.
        self.right_sign_open = n.open;
    }

    /// Begin the release (the gate slews down).
    pub fn release(&mut self) {
        self.gate_target = 0.0;
    }

    pub fn set_release_ms(&mut self, ms: f32) {
        self.release_step = (1.0 / (ms as f64 * self.sample_rate * 1e-3).max(1.0)) as f32;
    }

    pub fn set_attack_ms(&mut self, ms: f32) {
        self.attack_step = (1.0 / (ms as f64 * self.sample_rate * 1e-3).max(1.0)) as f32;
    }

    pub fn set_vibrato_hz(&mut self, hz: f32) {
        self.lfo_inc = hz.max(0.0) as f64 / self.sample_rate;
    }

    /// True once the gate is closed and the loop has died away.
    pub fn is_finished(&self) -> bool {
        self.gate_target == 0.0 && self.gate == 0.0 && self.silent_blocks >= 4
    }

    pub fn is_released(&self) -> bool {
        self.gate_target == 0.0
    }

    #[inline(always)]
    fn xorshift(r: &mut u32) -> f32 {
        let mut x = *r;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *r = x;
        (x as i32) as f32 * (1.0 / 2_147_483_648.0)
    }

    #[inline(always)]
    fn white(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        (x as i32) as f32 * (1.0 / 2_147_483_648.0)
    }

    /// Render up to one sub-block, ADDING `osc * mult[i]` into `out` (`mult` is the caller's
    /// per-sample multiplier such as steal fade; pass `None` for 1).
    pub fn render_add(&mut self, raw: &Raw, out: &mut [f32], mult: Option<&[f32]>) {
        let len = out.len();
        if len == 0 {
            return;
        }
        let valve = Valve::new(raw);
        let m = raw.reflection.clamp(0.0, 1.0).sqrt();
        self.left.refl = -m;
        self.right.refl = if self.right_sign_open { -m } else { m };
        let c = 0.25 * raw.damping.clamp(0.0, 1.0);

        // The LFO is evaluated once per sub-block and interpolated across it.
        self.lfo_phase = (self.lfo_phase + self.lfo_inc * len as f64).fract();
        // The fade-in scales the LFO itself, so drive and pitch vibrato both grow in.
        self.vib_gain = (self.vib_gain + self.vib_step * len as f32).min(1.0);
        let lfo_now = ((self.lfo_phase * std::f64::consts::TAU).sin()) as f32 * self.vib_gain;
        let lfo_prev = self.lfo_prev;
        self.lfo_prev = lfo_now;
        let dl = (lfo_now - lfo_prev) / len as f32;
        let noise = NOISE_SCALE * raw.noise.clamp(0.0, 1.0);
        let bell = BELL_GAIN * raw.bell.clamp(0.0, 1.0);
        let valve_noise = VALVE_NOISE_REL * raw.valve_noise.clamp(0.0, 1.0);
        let air = AIR_GAIN * raw.air.clamp(0.0, 1.0);
        // Wander: one step of the slow noise per sub-block, scaled to unit RMS (uniform white has variance 1/3; a
        // one-pole with coefficient a passes a/(2-a) of it).
        let wander = raw.wander.clamp(0.0, 1.0);
        let wn = if wander > 0.0 {
            let a = self.wander_a;
            self.wander_s += a * (Self::xorshift(&mut self.rng2) - self.wander_s);
            self.wander_s * (3.0 * (2.0 - a) / a).sqrt()
        } else {
            0.0
        };
        let drive_k = 1.0 + WANDER_DRIVE * wander * wn;
        let valve_k = 1.0 + WANDER_VALVE * wander * wn;
        let vib = VIBRATO_SCALE * raw.vibrato_depth.clamp(0.0, 1.0);
        let mut lfo = lfo_prev;
        // Pitch vibrato: retune the loop at the sub-block's LFO value (positive LFO is sharp, a shorter loop).
        let pv = raw.pitch_vibrato.clamp(0.0, 1.0);
        if pv > 0.0 || self.detuned {
            let k = (-(PITCH_VIBRATO_CENTS * pv * lfo_now) as f64 / 1200.0).exp2();
            self.left.set_len(self.len_l * k);
            self.right.set_len(self.len_r * k);
            self.detuned = pv > 0.0;
        }

        let mut peak = 0.0f32;
        for i in 0..len {
            // gate slew
            if self.gate < self.gate_target {
                self.gate = (self.gate + self.attack_step).min(self.gate_target);
            } else if self.gate > self.gate_target {
                self.gate = (self.gate - self.release_step).max(self.gate_target);
            }
            self.burst *= self.burst_decay;
            lfo += dl;
            let w = self.white();
            let drive = raw.drive * drive_k * self.gate * (1.0 + BURST_GAIN * self.burst) * (1.0 + noise * w + vib * lfo);

            let a_l = self.left.pull(c);
            let a_r = self.right.pull(c);
            let v = a_l + a_r;
            let delta = drive - v;
            let k = if valve_noise > 0.0 { valve_k * (1.0 + valve_noise * Self::xorshift(&mut self.rng2)) } else { valve_k };
            let y = delta * valve.opening_jit(delta, k);
            self.left.push(a_r + 0.5 * y);
            self.right.push(a_l + 0.5 * y);

            let x = v + y;
            let o = x - self.dc_x1 + DC_POLE * self.dc_y1;
            self.dc_x1 = x;
            self.dc_y1 = flush_denormal(o);
            peak = peak.max(o.abs());
            let o = if bell > 0.0 {
                // band-pass at f0: the fundamental in phase. A quadrature carrier (the low-pass) makes the two
                // neighbours' products cancel on each even harmonic; in phase they add.
                let fund = self.bell_lp.process(o).bp() * 2.0 * std::f32::consts::FRAC_1_SQRT_2;
                // a sine's mean |x| is 2/pi of its peak: scale the carrier to unit peak
                self.bell_env = flush_denormal(self.bell_env + self.bell_a * (fund.abs() - self.bell_env));
                let carrier = fund * std::f32::consts::FRAC_2_PI / (self.bell_env + 1e-6);
                let up = self.bell_hp.process(o).hp();
                o + bell * self.bell_hp2.process(up * carrier).hp()
            } else {
                o
            };
            let o = if air > 0.0 {
                let a = self.bell_a;
                self.air_env_y = flush_denormal(self.air_env_y + a * (y.abs() - self.air_env_y));
                self.air_env_o = flush_denormal(self.air_env_o + a * (o.abs() - self.air_env_o));
                let shape = y.abs() / (self.air_env_y + 1e-9) * self.air_env_o;
                o + air * shape * self.air_hp.process(Self::xorshift(&mut self.rng3)).hp()
            } else {
                o
            };
            out[i] += match mult {
                Some(mu) => o * mu[i],
                None => o,
            };
        }
        if peak < 1e-6 {
            self.silent_blocks = self.silent_blocks.saturating_add(1);
        } else {
            self.silent_blocks = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn render(raw: &Raw, setup: &NoteSetup, secs: f32) -> Vec<f32> {
        let mut b = Bore::new(SR);
        b.start(setup);
        let n = (secs * SR) as usize;
        let mut out = vec![0.0f32; n];
        for chunk in out.chunks_mut(SUB_BLOCK) {
            b.render_add(raw, chunk, None);
        }
        out
    }

    fn tail_rms(x: &[f32]) -> f32 {
        let t = &x[x.len() / 2..];
        (t.iter().map(|v| v * v).sum::<f32>() / t.len() as f32).sqrt()
    }

    /// Per-frame period (samples) of the second half of a render: the autocorrelation peak within
    /// ±10% of `expect`, parabolically interpolated.
    fn periods(x: &[f32], expect: f32) -> Vec<f32> {
        let t = &x[x.len() / 2..];
        let (n, lo, hi) = (2048, (expect * 0.9) as usize, (expect * 1.1) as usize + 1);
        let ac = |f: &[f32], l: usize| f[..n - l].iter().zip(&f[l..n]).map(|(a, b)| a * b).sum::<f32>();
        (0..).map(|k| k * 512).take_while(|s| s + n <= t.len()).map(|s| {
            let f = &t[s..s + n];
            let l = (lo..=hi).max_by(|&a, &b| ac(f, a).total_cmp(&ac(f, b))).unwrap();
            let (a, b, c) = (ac(f, l - 1), ac(f, l), ac(f, l + 1));
            l as f32 + 0.5 * (a - c) / (a - 2.0 * b + c)
        }).collect()
    }

    #[test]
    fn pitch_vibrato_wobbles_the_period() {
        let setup = NoteSetup { freq_hz: 220.0, vibrato_hz: 6.0, ..NoteSetup::default() };
        let raw = Raw { character: 1.0, aperture: 0.6, drive: 0.5, ..Raw::default() };
        assert!(tail_rms(&render(&raw, &setup, 1.0)) > 0.01, "the note speaks");
        let spread = |pv: f32| {
            let p = periods(&render(&Raw { pitch_vibrato: pv, ..raw }, &setup, 1.0), SR / 220.0);
            let m = p.iter().sum::<f32>() / p.len() as f32;
            (p.iter().map(|v| (v - m).powi(2)).sum::<f32>() / p.len() as f32).sqrt() / m
        };
        let (still, wobbly) = (spread(0.0), spread(1.0));
        // 60 cents peak is about 3.5% period swing; the still note's period hardly varies.
        assert!(wobbly > 0.01 && wobbly > 4.0 * still, "still {still}, wobbly {wobbly}");
    }

    #[test]
    fn vibrato_delay_fades_the_wobble_in() {
        let setup = NoteSetup { freq_hz: 220.0, vibrato_hz: 6.0, vibrato_delay_ms: 2000.0, ..NoteSetup::default() };
        let raw = Raw { character: 1.0, aperture: 0.6, drive: 0.5, pitch_vibrato: 1.0, ..Raw::default() };
        let x = render(&raw, &setup, 3.0);
        assert!(tail_rms(&x) > 0.01, "the note speaks: {}", tail_rms(&x));
        // period spread while the fade is under 30% (0.2-0.6 s) vs at full depth (2.2-3 s); `periods` reads a slice's second half
        let spread = |a: &[f32]| { let p = periods(a, SR / 220.0); let m = p.iter().sum::<f32>() / p.len() as f32; (p.iter().map(|v| (v - m).powi(2)).sum::<f32>() / p.len() as f32).sqrt() };
        let (early, late) = (spread(&x[(0.2 * SR) as usize..(1.0 * SR) as usize]), spread(&x[(1.4 * SR) as usize..]));
        assert!(late > 2.0 * early, "early {early}, late {late}");
    }

    /// Level (dB re the strongest) of harmonics 1..=n of a render's second half: the peak of a Hann-windowed DFT
    /// within ±2% of each harmonic (the note can be a few cents off `f0`, which matters at high harmonics).
    fn harmonic_db(x: &[f32], f0: f32, n: usize) -> Vec<f32> {
        let t = &x[x.len() / 2..];
        let w = |i: usize| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / t.len() as f32).cos();
        let dft = |f: f32| {
            let (mut re, mut im) = (0.0f32, 0.0f32);
            for (i, v) in t.iter().enumerate() {
                let ph = std::f32::consts::TAU * f * i as f32 / SR;
                re += v * w(i) * ph.cos();
                im += v * w(i) * ph.sin();
            }
            re * re + im * im
        };
        let p: Vec<f32> = (1..=n).map(|k| (-10..=10).map(|j| dft(k as f32 * f0 * (1.0 + 0.002 * j as f32))).fold(0.0, f32::max)).collect();
        let m = p.iter().cloned().fold(0.0, f32::max);
        p.iter().map(|v| 10.0 * (v / m).log10()).collect()
    }

    /// A clarinet-ish closed-bore reed note that speaks: knobs through the calibration, as the device does.
    fn clarinet(key: f32) -> (Raw, NoteSetup) {
        let k = crate::bore_cal::Knobs { character: 0.0, open: false, position: 0.5, ..Default::default() };
        let r = crate::bore_cal::resolve(key, &k);
        let f = 440.0 * ((key - 69.0) / 12.0).exp2();
        (r.raw, NoteSetup { freq_hz: f, open: false, position: r.position, tune_cents: r.tune_cents, ..NoteSetup::default() })
    }

    #[test]
    fn bell_brings_back_even_harmonics_up_high_and_keeps_tuning() {
        let (raw, setup) = clarinet(55.0);
        let f = setup.freq_hz;
        let plain = render(&raw, &setup, 1.0);
        let bell = render(&Raw { bell: 1.0, ..raw }, &setup, 1.0);
        assert!(tail_rms(&plain) > 0.01, "the note speaks: {}", tail_rms(&plain));
        let (hp, hh) = (harmonic_db(&plain, f, 16), harmonic_db(&bell, f, 16));
        // h2 stays down; the evens above the bell's high-pass (h8..h16, 1.6-3.1 kHz) come up
        let even_hi = |h: &[f32]| (h[7] + h[9] + h[11] + h[13] + h[15]) / 5.0;
        assert!(hh[1] < -30.0, "h2 plain {} bell {}", hp[1], hh[1]);
        assert!(even_hi(&hh) > even_hi(&hp) + 10.0, "plain {hp:?}\nbell {hh:?}");
        // outside the loop: the period is untouched
        let per = |x: &[f32]| { let p = periods(x, SR / f); p.iter().sum::<f32>() / p.len() as f32 };
        let cents = 1200.0 * (per(&plain) / per(&bell)).log2();
        assert!(cents.abs() < 2.0, "{cents} cents");
    }

    /// A calibrated note (knobs through `bore_cal`, as the device does) for any anchor and bore.
    fn note(character: f32, open: bool, key: f32) -> (Raw, NoteSetup) {
        let k = crate::bore_cal::Knobs { character, open, position: 0.3, ..Default::default() };
        let r = crate::bore_cal::resolve(key, &k);
        let f = 440.0 * ((key - 69.0) / 12.0).exp2();
        (r.raw, NoteSetup { freq_hz: f, open, position: r.position, tune_cents: r.tune_cents, ..NoteSetup::default() })
    }

    #[test]
    fn noise_paths_keep_notes_speaking_and_in_tune() {
        // valve noise and wander act inside the loop: at full scale every anchor still speaks, in tune, where it did
        for c in [0.0, 0.25, 0.5, 0.75, 1.0] {
            for open in [false, true] {
                for key in [50.0, 62.0, 74.0] {
                    let (raw, setup) = note(c, open, key);
                    let plain = render(&raw, &setup, 0.8);
                    if tail_rms(&plain) < 0.01 {
                        continue; // outside the calibrated region already (see bore_calibrate verify)
                    }
                    let noisy = render(&Raw { valve_noise: 1.0, wander: 1.0, ..raw }, &setup, 0.8);
                    assert!(tail_rms(&noisy) > 0.3 * tail_rms(&plain), "c {c} open {open} key {key}: {} vs {}", tail_rms(&noisy), tail_rms(&plain));
                    let per = |x: &[f32]| { let p = periods(x, SR / setup.freq_hz); p.iter().sum::<f32>() / p.len() as f32 };
                    let cents = 1200.0 * (per(&plain) / per(&noisy)).log2();
                    assert!(cents.abs() < 25.0, "c {c} open {open} key {key}: {cents} cents");
                }
            }
        }
    }

    /// Energy above 4 kHz of the second half, by first differences filtered a few times (a crude high-pass is enough
    /// for a with/without comparison).
    fn hf_rms(x: &[f32]) -> f32 {
        let mut f = crate::svf::Svf::new();
        f.set_hz(4000.0, 0.7071, SR);
        let y: Vec<f32> = x.iter().map(|&v| f.process(v).hp()).collect();
        tail_rms(&y)
    }

    #[test]
    fn air_adds_high_noise_and_wander_adds_shimmer() {
        let (raw, setup) = note(0.5, true, 74.0);
        let plain = render(&raw, &setup, 1.0);
        let airy = render(&Raw { air: 1.0, ..raw }, &setup, 1.0);
        let gain_db = 20.0 * (hf_rms(&airy) / hf_rms(&plain)).log10();
        assert!(gain_db > 3.0, "air raises >4 kHz by {gain_db} dB");
        // shimmer: spread of the 10 ms RMS level (dB) over the second half
        let shimmer = |x: &[f32]| {
            let t = &x[x.len() / 2..];
            let e: Vec<f32> = t.chunks(480).map(|c| 10.0 * (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).log10()).collect();
            let m = e.iter().sum::<f32>() / e.len() as f32;
            (e.iter().map(|v| (v - m).powi(2)).sum::<f32>() / e.len() as f32).sqrt()
        };
        let wandering = render(&Raw { wander: 1.0, ..raw }, &setup, 1.0);
        assert!(shimmer(&wandering) > 2.0 * shimmer(&plain), "shimmer {} vs {}", shimmer(&wandering), shimmer(&plain));
        let valve = render(&Raw { valve_noise: 1.0, ..raw }, &setup, 1.0);
        assert_ne!(valve, plain);
    }

    #[test]
    fn bell_at_zero_is_bit_identical() {
        let (raw, setup) = clarinet(62.0);
        assert_eq!(render(&raw, &setup, 0.3), render(&Raw { bell: 0.0, ..raw }, &setup, 0.3));
    }

    #[test]
    fn silent_when_undriven() {
        for c in [0.0, 0.5, 1.0] {
            let raw = Raw { character: c, drive: 0.0, ..Raw::default() };
            let out = render(&raw, &NoteSetup::default(), 0.3);
            assert!(out.iter().all(|v| *v == 0.0), "character {c}");
        }
    }

    #[test]
    fn finite_and_bounded_everywhere() {
        for &c in &[0.0, 0.25, 0.5, 0.75, 1.0] {
            for &open in &[true, false] {
                for &drive in &[0.1, 1.0, 4.0] {
                    for &ap in &[0.2, 0.7, 1.2] {
                        let raw = Raw { character: c, aperture: ap, drive, noise: 1.0, vibrato_depth: 1.0, ..Raw::default() };
                        let setup = NoteSetup { open, freq_hz: 110.0, ..NoteSetup::default() };
                        let out = render(&raw, &setup, 0.25);
                        assert!(out.iter().all(|v| v.is_finite() && v.abs() < 50.0), "c {c} open {open} drive {drive} ap {ap}");
                    }
                }
            }
        }
    }

    #[test]
    fn each_anchor_oscillates_at_some_raw_setting() {
        for &c in &[0.0, 0.25, 0.5, 0.75, 1.0] {
            for &open in &[true, false] {
                let mut best = 0.0f32;
                for &drive in &[0.1, 0.2, 0.4, 0.7, 1.0, 1.5, 2.5] {
                    for &ap in &[0.2, 0.4, 0.6, 0.8, 1.0] {
                        let raw = Raw { character: c, aperture: ap, drive, ..Raw::default() };
                        let setup = NoteSetup { open, freq_hz: 220.0, position: if open { 0.2 } else { 0.8 }, ..NoteSetup::default() };
                        best = best.max(tail_rms(&render(&raw, &setup, 0.4)));
                    }
                }
                assert!(best > 0.01, "anchor {c} open {open} never speaks (best rms {best})");
            }
        }
    }

    #[test]
    fn released_note_finishes() {
        let raw = Raw { character: 1.0, aperture: 0.6, drive: 0.5, ..Raw::default() };
        let mut b = Bore::new(SR);
        b.start(&NoteSetup { release_ms: 20.0, ..NoteSetup::default() });
        let mut buf = [0.0f32; SUB_BLOCK];
        for _ in 0..200 {
            b.render_add(&raw, &mut buf, None);
        }
        b.release();
        for _ in 0..4000 {
            buf.fill(0.0);
            b.render_add(&raw, &mut buf, None);
        }
        assert!(b.is_finished());
    }

    #[test]
    fn note_fits_limit() {
        assert!(Bore::fits(SR, 110.0, true, 0.5));
        assert!(!Bore::fits(SR, 10.0, true, 0.5));
    }
}
