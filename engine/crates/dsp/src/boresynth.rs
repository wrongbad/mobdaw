//! The bore synth device core: a small pool of [`Bore`] voices behind the knobs of
//! [`crate::bore_cal::Knobs`] (docs/bore.md, docs/engine-api.md "kind 10"). Same timing model
//! as [`crate::synth::Synth`]: the caller passes `release_at` in its own clock and calls
//! [`BoreSynth::release_due`] at each control split.
//!
//! Position and bore are fixed when a note starts (they set the delay lengths); every other knob
//! glides and is re-resolved through the calibration once per sub-block. No allocation after `new`.

use crate::bore::{Bore, NoteSetup, SUB_BLOCK};
use crate::bore_cal::{self, Knobs};
use crate::smooth::Ramp;

pub const VOICES: usize = 8;
pub const STEAL_FADE: u32 = 64;

pub const P_CHARACTER: u32 = 0;
pub const P_STIFFNESS: u32 = 1;
pub const P_APERTURE: u32 = 2;
pub const P_POSITION: u32 = 3;
pub const P_BORE: u32 = 4;
pub const P_DAMPING: u32 = 5;
pub const P_DECAY: u32 = 6;
pub const P_BREATH: u32 = 7;
pub const P_NOISE: u32 = 8;
pub const P_VIBRATO_RATE: u32 = 9;
pub const P_VIBRATO_DEPTH: u32 = 10;
pub const P_ATTACK_MS: u32 = 11;
pub const P_RELEASE_MS: u32 = 12;
pub const P_GAIN: u32 = 13;
pub const P_VIBRATO_PITCH: u32 = 14;
pub const P_VIBRATO_DELAY_MS: u32 = 15;
pub const P_BELL: u32 = 16;

#[derive(Clone, Copy)]
struct Pending {
    key: u32,
    velocity: f32,
    release_at: i64,
    age: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Free,
    Active,
    Stealing,
}

struct Voice {
    bore: Bore,
    state: State,
    key: u32,
    velocity: f32,
    age: u64,
    release_at: i64,
    released: bool,
    steal_left: u32,
    pending: Option<Pending>,
    /// Bore and fold chosen at note start.
    open: bool,
    position: f32,
}

pub struct BoreSynth {
    smooth_samples: f64,
    sample_rate: f32,
    voices: Box<[Voice]>,
    next_age: u64,
    character: Ramp,
    stiffness: Ramp,
    aperture: Ramp,
    damping: Ramp,
    decay: Ramp,
    breath: Ramp,
    noise: Ramp,
    vibrato_depth: Ramp,
    pitch_vibrato: Ramp,
    bell: Ramp,
    gain: Ramp,
    position: f32,
    open: bool,
    vibrato_hz: f32,
    vibrato_delay_ms: f32,
    attack_ms: f32,
    release_ms: f32,
    /// Seeds the per-note noise.
    seed: u32,
}

#[inline]
fn midi_hz(pitch: u32) -> f32 {
    440.0 * (((pitch.min(127) as f32) - 69.0) / 12.0).exp2()
}

impl BoreSynth {
    pub fn new(sample_rate: f32) -> Self {
        let d = Knobs::default();
        Self {
            smooth_samples: sample_rate as f64 * 0.010,
            sample_rate,
            voices: (0..VOICES)
                .map(|_| Voice { bore: Bore::new(sample_rate), state: State::Free, key: 0, velocity: 0.0, age: 0, release_at: i64::MAX, released: false, steal_left: 0, pending: None, open: true, position: 0.3 })
                .collect(),
            next_age: 0,
            character: Ramp::new(d.character as f64),
            stiffness: Ramp::new(d.stiffness as f64),
            aperture: Ramp::new(d.aperture as f64),
            damping: Ramp::new(d.damping as f64),
            decay: Ramp::new(d.decay as f64),
            breath: Ramp::new(d.breath as f64),
            noise: Ramp::new(d.noise as f64),
            vibrato_depth: Ramp::new(d.vibrato_depth as f64),
            pitch_vibrato: Ramp::new(d.pitch_vibrato as f64),
            bell: Ramp::new(d.bell as f64),
            gain: Ramp::new(1.0),
            position: d.position,
            open: d.open,
            vibrato_hz: 5.0,
            vibrato_delay_ms: 0.0,
            attack_ms: 30.0,
            release_ms: 120.0,
            seed: 1,
        }
    }

    pub fn set_param(&mut self, id: u32, value: f32) {
        self.set_param_smooth(id, value, self.smooth_samples);
    }

    pub fn set_param_smooth(&mut self, id: u32, value: f32, s: f64) {
        if !value.is_finite() {
            return;
        }
        let unit = |v: f32| v.clamp(0.0, 1.0) as f64;
        match id {
            P_CHARACTER => self.character.set_target(unit(value), s),
            P_STIFFNESS => self.stiffness.set_target(unit(value), s),
            P_APERTURE => self.aperture.set_target(unit(value), s),
            P_POSITION => self.position = value.clamp(0.0, 1.0),
            P_BORE => self.open = value >= 0.5,
            P_DAMPING => self.damping.set_target(unit(value), s),
            P_DECAY => self.decay.set_target(unit(value), s),
            P_BREATH => self.breath.set_target(unit(value), s),
            P_NOISE => self.noise.set_target(unit(value), s),
            P_VIBRATO_RATE => self.vibrato_hz = value.clamp(0.0, 20.0),
            P_VIBRATO_DEPTH => self.vibrato_depth.set_target(unit(value), s),
            P_VIBRATO_PITCH => self.pitch_vibrato.set_target(unit(value), s),
            P_ATTACK_MS => self.attack_ms = value.clamp(0.0, 5000.0),
            P_VIBRATO_DELAY_MS => self.vibrato_delay_ms = value.clamp(0.0, 5000.0),
            P_BELL => self.bell.set_target(unit(value), s),
            P_RELEASE_MS => self.release_ms = value.clamp(1.0, 10000.0),
            P_GAIN => self.gain.set_target(value.clamp(0.0, 2.0) as f64, s),
            _ => {}
        }
    }

    /// The knobs as of now (position / bore are the values a new note would take).
    fn knobs(&self) -> Knobs {
        Knobs {
            character: self.character.value() as f32,
            stiffness: self.stiffness.value() as f32,
            aperture: self.aperture.value() as f32,
            position: self.position,
            open: self.open,
            damping: self.damping.value() as f32,
            decay: self.decay.value() as f32,
            breath: self.breath.value() as f32,
            noise: self.noise.value() as f32,
            vibrato_depth: self.vibrato_depth.value() as f32,
            pitch_vibrato: self.pitch_vibrato.value() as f32,
            bell: self.bell.value() as f32,
        }
    }

    /// Whether the current settings can play `pitch`: inside the calibrated note range and short
    /// enough for the delay lines. Notes outside it are rejected (no voice).
    pub fn accepts(&self, pitch: u32) -> bool {
        let fold = bore_cal::fold(self.position);
        let (lo, hi) = bore_cal::note_range(self.character.target() as f32, fold, self.open);
        let p = pitch as f32;
        p >= lo && p <= hi && Bore::fits(self.sample_rate, midi_hz(pitch), self.open, bore_cal::junction_position(self.position, self.open))
    }

    fn start_voice(&mut self, idx: usize, n: Pending) {
        let k = self.knobs();
        let r = bore_cal::resolve(n.key as f32, &k);
        self.seed = self.seed.wrapping_add(1);
        let setup = NoteSetup {
            freq_hz: midi_hz(n.key),
            open: k.open,
            position: r.position,
            tune_cents: r.tune_cents,
            velocity: n.velocity,
            seed: self.seed,
            attack_ms: self.attack_ms,
            release_ms: self.release_ms,
            vibrato_hz: self.vibrato_hz,
            vibrato_delay_ms: self.vibrato_delay_ms,
        };
        let v = &mut self.voices[idx];
        v.bore.start(&setup);
        v.key = n.key;
        v.velocity = n.velocity;
        v.age = n.age;
        v.release_at = n.release_at;
        v.released = false;
        v.steal_left = 0;
        v.pending = None;
        v.open = k.open;
        v.position = k.position;
        v.state = State::Active;
    }

    pub fn note_on(&mut self, pitch: u32, velocity: f32, release_at: i64) {
        if !self.accepts(pitch) {
            return;
        }
        let note = Pending { key: pitch, velocity: velocity.clamp(0.0, 1.0), release_at, age: self.next_age };
        self.next_age += 1;
        if let Some(i) = self.voices.iter().position(|v| v.state == State::Free) {
            self.start_voice(i, note);
            return;
        }
        let target = self.voices.iter_mut().filter(|v| v.state == State::Active).min_by_key(|v| v.age);
        if let Some(v) = target {
            v.state = State::Stealing;
            v.steal_left = STEAL_FADE;
            v.pending = Some(note);
        } else if let Some(v) = self.voices.iter_mut().filter(|v| v.state == State::Stealing).min_by_key(|v| v.pending.map_or(u64::MAX, |p| p.age)) {
            v.pending = Some(note);
        }
    }

    fn release_voice(v: &mut Voice, release_ms: f32) {
        v.released = true;
        v.bore.set_release_ms(release_ms);
        v.bore.release();
    }

    pub fn release_key(&mut self, pitch: u32) {
        let rm = self.release_ms;
        for v in self.voices.iter_mut() {
            match v.state {
                State::Active if !v.released && v.key == pitch && v.release_at == i64::MAX => Self::release_voice(v, rm),
                State::Stealing => {
                    if v.pending.is_some_and(|p| p.key == pitch && p.release_at == i64::MAX) {
                        v.pending = None;
                    }
                }
                _ => {}
            }
        }
    }

    pub fn release_due(&mut self, now: i64) {
        let rm = self.release_ms;
        for v in self.voices.iter_mut() {
            if v.state == State::Active && !v.released && v.release_at <= now {
                Self::release_voice(v, rm);
            }
        }
    }

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

    pub fn release_all(&mut self) {
        let rm = self.release_ms;
        for v in self.voices.iter_mut() {
            match v.state {
                State::Active if !v.released => Self::release_voice(v, rm),
                State::Stealing => v.pending = None,
                _ => {}
            }
        }
    }

    pub fn release_scheduled(&mut self) {
        let rm = self.release_ms;
        for v in self.voices.iter_mut() {
            match v.state {
                State::Active if !v.released && v.release_at != i64::MAX => Self::release_voice(v, rm),
                State::Stealing => {
                    if v.pending.is_some_and(|p| p.release_at != i64::MAX) {
                        v.pending = None;
                    }
                }
                _ => {}
            }
        }
    }

    pub fn reset(&mut self) {
        for v in self.voices.iter_mut() {
            v.state = State::Free;
            v.pending = None;
        }
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.state != State::Free).count()
    }

    pub fn is_active(&self) -> bool {
        self.active_voices() > 0 || self.is_ramping()
    }

    pub fn is_ramping(&self) -> bool {
        self.character.is_moving()
            || self.stiffness.is_moving()
            || self.aperture.is_moving()
            || self.damping.is_moving()
            || self.decay.is_moving()
            || self.breath.is_moving()
            || self.noise.is_moving()
            || self.vibrato_depth.is_moving()
            || self.pitch_vibrato.is_moving()
            || self.bell.is_moving()
            || self.gain.is_moving()
    }

    pub fn render_add(&mut self, out: &mut [f32]) {
        for chunk in out.chunks_mut(SUB_BLOCK) {
            self.render_block(chunk);
        }
    }

    fn render_block(&mut self, out: &mut [f32]) {
        let len = out.len();
        let mut knobs = self.knobs();
        let g0 = self.gain.value() as f32;
        for r in [&mut self.character, &mut self.stiffness, &mut self.aperture, &mut self.damping, &mut self.decay, &mut self.breath, &mut self.noise, &mut self.vibrato_depth, &mut self.pitch_vibrato, &mut self.bell] {
            r.advance(len);
        }
        let g1 = self.gain.advance(len) as f32;
        let dg = (g1 - g0) / len as f32;
        let vib_hz = self.vibrato_hz;

        let mut acc = [0.0f32; SUB_BLOCK];
        let mut mult = [0.0f32; SUB_BLOCK];
        for i in 0..self.voices.len() {
            if self.voices[i].state == State::Stealing && self.voices[i].steal_left == 0 {
                match self.voices[i].pending {
                    Some(p) => self.start_voice(i, p),
                    None => self.voices[i].state = State::Free,
                }
            }
            let v = &mut self.voices[i];
            if v.state == State::Free {
                continue;
            }
            knobs.open = v.open;
            knobs.position = v.position;
            let r = bore_cal::resolve(v.key as f32, &knobs);
            v.bore.set_vibrato_hz(vib_hz);
            let amp = r.gain * (0.5 + 0.5 * v.velocity);
            let stealing = v.state == State::Stealing;
            for (j, m) in mult[..len].iter_mut().enumerate() {
                *m = if stealing { amp * v.steal_left.saturating_sub(j as u32) as f32 / STEAL_FADE as f32 } else { amp };
            }
            v.bore.render_add(&r.raw, &mut acc[..len], Some(&mult[..len]));
            if stealing {
                v.steal_left = v.steal_left.saturating_sub(len as u32);
            } else if v.bore.is_finished() {
                v.state = State::Free;
            }
        }
        for (j, (o, a)) in out.iter_mut().zip(acc[..len].iter()).enumerate() {
            *o += a * (g0 + dg * (j + 1) as f32);
        }
    }
}
