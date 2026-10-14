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
}

impl Default for Raw {
    fn default() -> Self {
        Self { character: 0.0, stiffness: 0.5, aperture: 0.7, drive: 1.0, damping: 0.3, reflection: 0.95, noise: 0.0, vibrato_depth: 0.0 }
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
        let mut g = 0.0;
        if self.w_reed > 0.0 {
            g += self.w_reed * (self.aperture - self.reed_slope * d).clamp(0.0, 1.0);
        }
        if self.w_jet > 0.0 {
            g += self.w_jet * (self.aperture - self.jet_curve * d * d).clamp(0.0, 1.0);
        }
        if self.w_bow > 0.0 {
            let a = d.abs();
            let f = self.bow_force * (0.3 + 1.0 / (1.0 + self.bow_fall * a));
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
    lfo_phase: f64,
    lfo_inc: f64,
    lfo_prev: f32,
    dc_x1: f32,
    dc_y1: f32,
    silent_blocks: u32,
    right_sign_open: bool,
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
}

impl Default for NoteSetup {
    fn default() -> Self {
        Self { freq_hz: 220.0, open: true, position: 0.3, tune_cents: 0.0, velocity: 0.8, seed: 1, attack_ms: 20.0, release_ms: 80.0, vibrato_hz: 5.0 }
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
            lfo_phase: 0.0,
            lfo_inc: 0.0,
            lfo_prev: 0.0,
            dc_x1: 0.0,
            dc_y1: 0.0,
            silent_blocks: 0,
            right_sign_open: true,
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
        self.left.set_len(rt * p);
        self.right.set_len(rt * (1.0 - p));
        let ms = self.sample_rate * 1e-3;
        self.attack_step = (1.0 / (n.attack_ms as f64 * ms).max(1.0)) as f32;
        self.release_step = (1.0 / (n.release_ms as f64 * ms).max(1.0)) as f32;
        self.gate = 0.0;
        self.gate_target = 1.0;
        self.burst = n.velocity.clamp(0.0, 1.0);
        self.burst_decay = (-1.0 / (BURST_MS * ms)).exp() as f32;
        self.rng = n.seed.wrapping_mul(2_654_435_761) | 1;
        self.lfo_phase = 0.0;
        self.lfo_inc = n.vibrato_hz.max(0.0) as f64 / self.sample_rate;
        self.lfo_prev = 0.0;
        self.dc_x1 = 0.0;
        self.dc_y1 = 0.0;
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
        let lfo_now = ((self.lfo_phase * std::f64::consts::TAU).sin()) as f32;
        let lfo_prev = self.lfo_prev;
        self.lfo_prev = lfo_now;
        let dl = (lfo_now - lfo_prev) / len as f32;
        let noise = NOISE_SCALE * raw.noise.clamp(0.0, 1.0);
        let vib = VIBRATO_SCALE * raw.vibrato_depth.clamp(0.0, 1.0);
        let mut lfo = lfo_prev;

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
            let drive = raw.drive * self.gate * (1.0 + BURST_GAIN * self.burst) * (1.0 + noise * w + vib * lfo);

            let a_l = self.left.pull(c);
            let a_r = self.right.pull(c);
            let v = a_l + a_r;
            let delta = drive - v;
            let y = delta * valve.opening(delta);
            self.left.push(a_r + 0.5 * y);
            self.right.push(a_l + 0.5 * y);

            let x = v + y;
            let o = x - self.dc_x1 + DC_POLE * self.dc_y1;
            self.dc_x1 = x;
            self.dc_y1 = flush_denormal(o);
            peak = peak.max(o.abs());
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
