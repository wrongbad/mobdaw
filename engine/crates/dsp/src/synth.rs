//! The finnwave synth: 64 voices of `finnwave -> amp ADSR`, summed to mono
//! (docs/engine-api.md, "kind 2"; engine.md section 6.4).
//!
//! # Timing model
//! The synth knows nothing about the transport. The caller (the engine) passes
//! [`Synth::note_on`] a `release_at` timestamp in *its own* clock (absolute timeline samples),
//! and calls [`Synth::release_due`] with the current time at every control split. Because
//! the engine splits sub-blocks at every note-on and at every [`Synth::next_release_after`],
//! note-on and note-off land on exact samples without the synth keeping a clock.
//!
//! # Voice
//! Per sample: `out = osc * env * velocity * gain`. The oscillator's rolloff is modulated by
//! the envelope, evaluated once per control block (<= 32 samples):
//!
//! ```text
//!   b_voice = rolloff + amount * (1 - env)
//! ```
//!
//! Harmonic `k` has amplitude `e^{-k b}`, so a larger `b` is a *darker* sound. A note starts
//! with `env = 0` (largest `b`, darkest) and brightens as the envelope rises. Then, as the
//! envelope decays or releases, `b` grows again and the note darkens: the
//! frequency-proportional decay of struck and plucked instruments.
//!
//! # Voice stealing
//! When all voices are busy, the *oldest* active voice is stolen. It fades out linearly over
//! [`STEAL_FADE`] samples (a hard cut would click), and the new note takes over its slot at the
//! first control block after the fade ends. That makes a stolen-voice note start up to
//! `STEAL_FADE + 31` samples late; this only happens under overload, and costs no extra
//! voices or allocation.

use crate::adsr::{Adsr, Stage};
use crate::finnwave::{Finnwave, SUB_BLOCK};
use crate::smooth::Ramp;

pub const VOICES: usize = 64;
pub const STEAL_FADE: u32 = 64;

/// Parameter ids (docs/engine-api.md).
pub const P_ROLLOFF: u32 = 0;
pub const P_ENV_TO_ROLLOFF: u32 = 1;
pub const P_ATTACK_MS: u32 = 2;
pub const P_DECAY_MS: u32 = 3;
pub const P_SUSTAIN: u32 = 4;
pub const P_RELEASE_MS: u32 = 5;
pub const P_GAIN: u32 = 6;

#[derive(Clone, Copy)]
struct Pending {
    freq: f32,
    velocity: f32,
    release_at: i64,
    age: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Free,
    Active,
    /// Fading out so a pending note can take the slot.
    Stealing,
}

struct Voice {
    osc: Finnwave,
    adsr: Adsr,
    state: State,
    velocity: f32,
    /// Monotonic note counter; the smallest age is the oldest voice.
    age: u64,
    release_at: i64,
    released: bool,
    steal_left: u32,
    pending: Option<Pending>,
}

impl Voice {
    fn new(sample_rate: f32) -> Self {
        Self {
            osc: Finnwave::new(sample_rate),
            adsr: Adsr::new(),
            state: State::Free,
            velocity: 0.0,
            age: 0,
            release_at: i64::MAX,
            released: false,
            steal_left: 0,
            pending: None,
        }
    }

    fn start(&mut self, n: Pending) {
        self.osc.set_freq_hz(n.freq);
        self.osc.reset_phase(); // the waveform starts at 0, so there is no onset click
        self.osc.set_amp(1.0);
        self.osc.snap_params();
        self.adsr.note_on();
        self.velocity = n.velocity;
        self.age = n.age;
        self.release_at = n.release_at;
        self.released = false;
        self.steal_left = 0;
        self.pending = None;
        self.state = State::Active;
    }
}

pub struct Synth {
    smooth_samples: f64,
    ms_to_samples: f64,
    voices: Box<[Voice]>,
    next_age: u64,
    rolloff: Ramp,
    env_amount: Ramp,
    sustain: Ramp,
    gain: Ramp,
    attack_ms: f32,
    decay_ms: f32,
    release_ms: f32,
}

impl Synth {
    /// A synth with the contract's defaults and 64 voices.
    pub fn new(sample_rate: f32) -> Self {
        Self::with_voices(sample_rate, VOICES)
    }

    /// Smaller pools are useful for testing voice stealing.
    pub fn with_voices(sample_rate: f32, voices: usize) -> Self {
        let sr = sample_rate as f64;
        Self {
            smooth_samples: sr * 0.010,
            ms_to_samples: sr * 1e-3,
            voices: (0..voices.max(1)).map(|_| Voice::new(sample_rate)).collect(),
            next_age: 0,
            rolloff: Ramp::new(0.3),
            env_amount: Ramp::new(0.5),
            sustain: Ramp::new(0.6),
            gain: Ramp::new(0.5),
            attack_ms: 5.0,
            decay_ms: 300.0,
            release_ms: 200.0,
        }
    }

    /// Set a parameter by contract id; values are clamped to the contract range and
    /// non-finite values are ignored. Rolloff, env amount, sustain and gain ramp over 10 ms;
    /// the ADSR times are read when a segment starts and need no smoothing.
    pub fn set_param(&mut self, id: u32, value: f32) {
        if !value.is_finite() {
            return;
        }
        let s = self.smooth_samples;
        match id {
            P_ROLLOFF => self.rolloff.set_target(value.clamp(0.001, 3.0) as f64, s),
            P_ENV_TO_ROLLOFF => self.env_amount.set_target(value.clamp(0.0, 3.0) as f64, s),
            P_ATTACK_MS => self.attack_ms = value.clamp(0.0, 5000.0),
            P_DECAY_MS => self.decay_ms = value.clamp(0.0, 5000.0),
            P_SUSTAIN => self.sustain.set_target(value.clamp(0.0, 1.0) as f64, s),
            P_RELEASE_MS => self.release_ms = value.clamp(0.0, 10000.0),
            P_GAIN => self.gain.set_target(value.clamp(0.0, 2.0) as f64, s),
            _ => {}
        }
    }

    /// Start a note. `release_at` is when the caller wants it released, in the caller's clock
    /// (it is only compared against the `now` passed to [`Self::release_due`]).
    pub fn note_on(&mut self, pitch: u32, velocity: f32, release_at: i64) {
        let freq = 440.0 * (((pitch.min(127) as f64) - 69.0) / 12.0).exp2();
        let note = Pending {
            freq: freq as f32,
            velocity: velocity.clamp(0.0, 1.0),
            release_at,
            age: self.next_age,
        };
        self.next_age += 1;

        if let Some(v) = self.voices.iter_mut().find(|v| v.state == State::Free) {
            v.start(note);
            return;
        }
        // Steal the oldest active voice; if every voice is already being stolen, the oldest
        // pending note is dropped in favour of this one.
        let target = self
            .voices
            .iter_mut()
            .filter(|v| v.state == State::Active)
            .min_by_key(|v| v.age);
        if let Some(v) = target {
            v.state = State::Stealing;
            v.steal_left = STEAL_FADE;
            v.pending = Some(note);
        } else if let Some(v) = self
            .voices
            .iter_mut()
            .filter(|v| v.state == State::Stealing)
            .min_by_key(|v| v.pending.map_or(u64::MAX, |p| p.age))
        {
            v.pending = Some(note);
        }
    }

    /// Release every unreleased voice whose `release_at <= now`.
    pub fn release_due(&mut self, now: i64) {
        for v in self.voices.iter_mut() {
            if v.state == State::Active && !v.released && v.release_at <= now {
                v.released = true;
                v.adsr.release();
            }
        }
    }

    /// The earliest scheduled release strictly after `now`, or `i64::MAX`. The engine splits
    /// its control blocks here so note-offs are sample-accurate.
    pub fn next_release_after(&self, now: i64) -> i64 {
        let mut next = i64::MAX;
        for v in self.voices.iter() {
            let t = match v.state {
                State::Active if !v.released => v.release_at,
                State::Stealing => v.pending.map_or(i64::MAX, |p| p.release_at),
                _ => i64::MAX,
            };
            if t > now && t < next {
                next = t;
            }
        }
        next
    }

    /// Release everything now (transport stop/seek). Pending stolen-voice notes are dropped.
    pub fn release_all(&mut self) {
        for v in self.voices.iter_mut() {
            match v.state {
                State::Active if !v.released => {
                    v.released = true;
                    v.adsr.release();
                }
                State::Stealing => v.pending = None,
                _ => {}
            }
        }
    }

    /// Hard stop: silence, no release tail (used when the device is bypassed).
    pub fn reset(&mut self) {
        for v in self.voices.iter_mut() {
            v.state = State::Free;
            v.pending = None;
            v.adsr.reset();
        }
    }

    /// Voices that are currently sounding (active or fading out).
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.state != State::Free).count()
    }

    /// Add the mono output into `out`.
    pub fn render_add(&mut self, out: &mut [f32]) {
        for chunk in out.chunks_mut(SUB_BLOCK) {
            self.render_block(chunk);
        }
    }

    fn render_block(&mut self, out: &mut [f32]) {
        let len = out.len();
        // Control values at the block start; ramps advance for the next block. Gain is
        // interpolated linearly per sample.
        let rolloff = self.rolloff.value() as f32;
        let amount = self.env_amount.value() as f32;
        let sustain = self.sustain.value() as f32;
        let g0 = self.gain.value() as f32;
        self.rolloff.advance(len);
        self.env_amount.advance(len);
        self.sustain.advance(len);
        let g1 = self.gain.advance(len) as f32;
        let dg = (g1 - g0) / len as f32;

        let (a, d, r) = (
            (self.attack_ms as f64 * self.ms_to_samples) as f32,
            (self.decay_ms as f64 * self.ms_to_samples) as f32,
            (self.release_ms as f64 * self.ms_to_samples) as f32,
        );

        let mut tmp = [0.0f32; SUB_BLOCK];
        for v in self.voices.iter_mut() {
            // A finished steal fade hands the slot to the pending note.
            if v.state == State::Stealing && v.steal_left == 0 {
                match v.pending {
                    Some(p) => v.start(p),
                    None => v.state = State::Free,
                }
            }
            if v.state == State::Free {
                continue;
            }
            v.adsr.set(a, d, sustain, r);

            let b = rolloff + amount * (1.0 - v.adsr.level());
            v.osc.set_rolloff_immediate(b);
            tmp[..len].fill(0.0);
            v.osc.render_add(&mut tmp[..len]);

            let stealing = v.state == State::Stealing;
            let mut g = g0;
            for (i, o) in out.iter_mut().enumerate() {
                g += dg;
                let env = v.adsr.next();
                let fade = if stealing {
                    v.steal_left.saturating_sub(i as u32) as f32 / STEAL_FADE as f32
                } else {
                    1.0
                };
                *o += tmp[i] * env * v.velocity * fade * g;
            }
            if stealing {
                v.steal_left = v.steal_left.saturating_sub(len as u32);
            } else if v.adsr.stage() == Stage::Idle {
                v.state = State::Free;
            }
        }
    }
}
