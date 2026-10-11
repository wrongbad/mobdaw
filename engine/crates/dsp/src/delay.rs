//! A tape echo: a stereo delay line read by the looper's variable-rate [`Resampler`], with a
//! state-variable filter and a soft saturator in the feedback loop.
//!
//! ```text
//!   in --+--------------------------------------------> dry ----------+-> out
//!        |                                                             |
//!        +-> [tape: write head] ... [read head: Resampler] -> SVF -> wet --+
//!                  ^                                          |
//!                  +------- DC block <- saturate <- feedback --+
//! ```
//!
//! # The tape
//! The write head puts one sample on the tape per output sample. The read head sits `delay`
//! samples behind it and is a [`Resampler`] running at a *speed*, exactly as in the looper:
//!
//! ```text
//!   read_pos = write_pos - delay        speed = d(read_pos)/dt = 1 - d(delay)/dt
//! ```
//!
//! so changing the delay time moves the head and bends the pitch of the echoes (a sweep up when
//! the delay shortens, down when it lengthens) the way a tape echo's time knob does, and the
//! wobble below is a speed deviation on the same head. The resampler's low-pass (about 0.16 of the
//! sample rate) is part of the sound: every pass round the loop darkens a little.
//!
//! # Time
//! The target time is approached with a one-pole glide ([`TIME_TAU_S`]) whose rate is capped at
//! [`MAX_SLEW`] samples per sample, so the head never stops or runs backwards however far the knob
//! is thrown (at the cap the echoes bend by a fifth up or an octave down).
//!
//! # Warble
//! `warble` (0..1) is the looper's wow, flutter and drift ([`Warble`]), applied as a time offset
//! of a few ms at full depth. The depth glides ([`WARBLE_TAU_S`]), so the knob never zippers.
//!
//! # The loop
//! The read head's output goes through the SVF (low-pass, high-pass or band-pass) and is the wet
//! signal: the first echo has been through the filter once, the second twice, and so on. What is
//! fed back is that signal, saturated (see [`Saturator::unity_gain`]: small signals pass at unity,
//! so the tail decays at `feedback` per echo and only loud echoes are squashed), with DC removed,
//! times `feedback`. Feedback above 1 builds until the saturator holds it: the echo oscillates.
//!
//! `mix` 0 is a bit-exact passthrough of the dry signal. All buffers are allocated in `new`.

use crate::resampler::Resampler;
use crate::svf::Svf;
use crate::tape::Saturator;
use crate::util::flush_denormal;
use crate::warble::Warble;

pub const TIME_MIN_MS: f32 = 10.0;
pub const TIME_MAX_MS: f32 = 2000.0;
pub const FEEDBACK_MAX: f32 = 1.2;
pub const CUTOFF_MIN: f32 = 100.0;
pub const CUTOFF_MAX: f32 = 20000.0;
/// Filter modes: low-pass, high-pass, band-pass.
pub const MODES: u32 = 3;
/// Damping at full `resonance` (zero resonance is Butterworth, `1/sqrt(2)`).
const DAMPING_MIN: f32 = 0.15;
/// Time constant of the delay-time glide and the cap on its rate (samples per sample).
pub const TIME_TAU_S: f64 = 0.2;
pub const MAX_SLEW: f64 = 0.5;
pub const WARBLE_TAU_S: f64 = 0.15;
/// Never read closer to the write head than this (samples).
const MIN_DELAY: f64 = 2.0;
/// Spare room on the tape past the longest delay for the warble's offset (ms).
const MARGIN_MS: f64 = 10.0;
/// One-pole DC blocker pole in the feedback path (about 38 Hz at 48 kHz).
const DC_POLE: f32 = 0.995;

#[derive(Clone, Copy, Debug)]
pub struct DelayParams {
    pub time_ms: f32,
    /// 0..[`FEEDBACK_MAX`]: the gain of one trip round the loop.
    pub feedback: f32,
    /// 0..1, dry to wet.
    pub mix: f32,
    /// 0..1, tape wow and flutter depth.
    pub warble: f32,
    /// 0..1, saturation in the loop.
    pub drive: f32,
    /// 0 low-pass, 1 high-pass, 2 band-pass.
    pub mode: u32,
    pub cutoff_hz: f32,
    /// 0..1: 0 is a Butterworth response, 1 rings.
    pub resonance: f32,
}

impl Default for DelayParams {
    fn default() -> Self {
        Self { time_ms: 375.0, feedback: 0.4, mix: 0.3, warble: 0.25, drive: 0.0, mode: 0, cutoff_hz: 4000.0, resonance: 0.0 }
    }
}

#[derive(Clone, Debug)]
pub struct TapeDelay {
    tape: Vec<(f32, f32)>,
    /// Absolute index of the next sample to write.
    n: i64,
    head: Resampler,
    /// The glided delay time (samples); `None` until the first block snaps it to its target.
    delay: Option<f64>,
    warble: Warble,
    depth: f64,
    svf: [Svf; 2],
    /// DC blocker state per channel: previous input and output.
    dc: [(f32, f32); 2],
    sample_rate: f64,
}

impl TapeDelay {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate as f64;
        let len = ((TIME_MAX_MS as f64 + MARGIN_MS) * 1e-3 * sr).ceil() as usize + 2;
        Self {
            tape: vec![(0.0, 0.0); len],
            n: 0,
            head: Resampler::new(),
            delay: None,
            warble: Warble::new(),
            depth: 0.0,
            svf: [Svf::new(), Svf::new()],
            dc: [(0.0, 0.0); 2],
            sample_rate: sr,
        }
    }

    /// Wipe the tape and the loop: the echoes stop, and the delay time snaps on the next block.
    pub fn reset(&mut self) {
        self.tape.fill((0.0, 0.0));
        self.delay = None;
        self.depth = 0.0;
        self.svf[0].reset();
        self.svf[1].reset();
        self.dc = [(0.0, 0.0); 2];
    }

    /// Process `l`/`r` in place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], p: &DelayParams) {
        let sr = self.sample_rate;
        let inv_sr = 1.0 / sr;
        let fin = |v: f32, d: f32| if v.is_finite() { v } else { d };
        let time_ms = fin(p.time_ms, 375.0).clamp(TIME_MIN_MS, TIME_MAX_MS);
        let target = time_ms as f64 * 1e-3 * sr;
        let feedback = fin(p.feedback, 0.0).clamp(0.0, FEEDBACK_MAX);
        let mix = fin(p.mix, 0.0).clamp(0.0, 1.0);
        let warble = fin(p.warble, 0.0).clamp(0.0, 1.0) as f64;
        let sat = Saturator::new(fin(p.drive, 0.0).clamp(0.0, 1.0));
        let (sat_gain, mode) = (sat.unity_gain(), p.mode.min(MODES - 1));
        let cutoff = fin(p.cutoff_hz, CUTOFF_MAX).clamp(CUTOFF_MIN, CUTOFF_MAX);
        let res = fin(p.resonance, 0.0).clamp(0.0, 1.0);
        let damping = std::f32::consts::FRAC_1_SQRT_2 * (1.0 - res) + DAMPING_MIN * res;
        for svf in self.svf.iter_mut() {
            svf.set_hz(cutoff, damping, sr as f32);
        }
        let pick: fn(&Svf) -> f32 = match mode {
            0 => Svf::lp,
            1 => Svf::hp,
            _ => Svf::bp,
        };
        let time_coef = 1.0 / (TIME_TAU_S * sr);
        let depth_coef = 1.0 - (-1.0 / (WARBLE_TAU_S * sr)).exp();
        let len = self.tape.len() as i64;
        let max_delay = (len - 2) as f64;

        let Self { tape, n, head, delay, warble: wob, depth, svf, dc, .. } = self;
        let mut cur = match *delay {
            Some(d) => d,
            None => {
                // A fresh tape: the head starts on the time, and nothing is on the tape to read.
                head.restart(*n - target as i64);
                target
            }
        };
        for k in 0..l.len().min(r.len()) {
            cur += ((target - cur) * time_coef).clamp(-MAX_SLEW, MAX_SLEW);
            *depth += (warble - *depth) * depth_coef;
            if *depth < 1e-6 && warble == 0.0 {
                *depth = 0.0;
            }
            wob.advance(inv_sr);
            let offset = if *depth > 0.0 { *depth * wob.delay_seconds() * sr } else { 0.0 };
            let d = (cur + offset).clamp(MIN_DELAY, max_delay);

            // Read: `to` is at most `n - 2`, so everything the head touches is already written.
            let to = (*n as f64 - d).max(head.pos());
            let speed = (to - head.pos()).max(0.05);
            let scale = (1.0 / speed).min(1.0) as f32;
            let (wl, wr) = head.advance(&mut |i| tape[i.rem_euclid(len) as usize], to, scale);
            let wl = pick(svf[0].process(wl));
            let wr = pick(svf[1].process(wr));

            // Feedback: saturate, remove DC, write.
            let mut back = [wl, wr];
            for (b, (x1, y1)) in back.iter_mut().zip(dc.iter_mut()) {
                let x = sat.shape(*b) * sat_gain;
                let y = flush_denormal(x - *x1 + DC_POLE * *y1);
                (*x1, *y1) = (x, y);
                *b = y * feedback;
            }
            let (dl, dr) = (l[k], r[k]);
            let (il, ir) = (fin(dl, 0.0), fin(dr, 0.0));
            tape[(*n).rem_euclid(len) as usize] = (flush_denormal(il + back[0]), flush_denormal(ir + back[1]));
            *n += 1;

            l[k] = dl * (1.0 - mix) + wl * mix;
            r[k] = dr * (1.0 - mix) + wr * mix;
        }
        *delay = Some(cur);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f32 = 48000.0;

    /// Run `x` (both channels) through a fresh delay in `chunk`-sized blocks.
    fn run(p: &DelayParams, x: &[f32], chunk: usize) -> (Vec<f32>, Vec<f32>) {
        let mut d = TapeDelay::new(SR);
        let (mut l, mut r) = (x.to_vec(), x.to_vec());
        for (lc, rc) in l.chunks_mut(chunk).zip(r.chunks_mut(chunk)) {
            d.process(lc, rc, p);
        }
        (l, r)
    }
    fn impulse(n: usize) -> Vec<f32> {
        let mut x = vec![0.0; n];
        x[0] = 1.0;
        x
    }
    fn sine(f: f64, n: usize, amp: f64) -> Vec<f32> {
        (0..n).map(|i| (amp * (std::f64::consts::TAU * f * i as f64 / SR as f64).sin()) as f32).collect()
    }
    fn peak_in(x: &[f32], lo: usize, hi: usize) -> (usize, f32) {
        let (i, v) = x[lo..hi].iter().enumerate().fold((0, 0.0f32), |a, (i, &v)| if v.abs() > a.1.abs() { (i, v) } else { a });
        (lo + i, v.abs())
    }
    /// A clean loop: nothing but the delay and the resampler's own low-pass.
    fn clean() -> DelayParams {
        DelayParams { mix: 1.0, warble: 0.0, drive: 0.0, cutoff_hz: CUTOFF_MAX, ..Default::default() }
    }

    #[test]
    fn mix_zero_is_a_bit_exact_passthrough() {
        let x = sine(330.0, 4096, 0.5);
        let p = DelayParams { mix: 0.0, feedback: 1.0, warble: 1.0, drive: 1.0, ..Default::default() };
        let (l, r) = run(&p, &x, 64);
        assert_eq!(l, x);
        assert_eq!(r, x);
    }

    #[test]
    fn echoes_land_on_the_time_and_fall_by_the_feedback() {
        let p = DelayParams { time_ms: 100.0, feedback: 0.5, ..clean() };
        let (l, _) = run(&p, &impulse(30_000), 32);
        // 100 ms is 4800 samples; the filters add a few samples of lag on every pass
        let (i1, a1) = peak_in(&l, 4000, 5600);
        let (i2, a2) = peak_in(&l, 9000, 10400);
        let (i3, a3) = peak_in(&l, 14000, 15200);
        assert!((i1 as i64 - 4800).abs() <= 8, "first echo at {i1}");
        assert!((i2 as i64 - 9600).abs() <= 16, "second echo at {i2}");
        assert!((i3 as i64 - 14400).abs() <= 24, "third echo at {i3}");
        assert!(a1 > 0.1, "first echo {a1}");
        // the low-pass rounds each pass's peak a little, so a bit under half
        assert!(a2 < 0.55 * a1 && a2 > 0.25 * a1, "second {a2} vs first {a1}");
        assert!(a3 < 0.55 * a2 && a3 > 0.25 * a2, "third {a3} vs second {a2}");

        let (l, _) = run(&DelayParams { feedback: 0.0, ..p }, &impulse(30_000), 32);
        assert!(peak_in(&l, 9000, 30_000).1 < 1e-3, "no feedback, no second echo");
    }

    #[test]
    fn the_loop_filter_darkens_the_repeats() {
        let burst = |p: &DelayParams| {
            let mut x = sine(6000.0, 2400, 0.4);
            x.resize(40_000, 0.0);
            let (l, _) = run(p, &x, 32);
            l
        };
        let rms = |x: &[f32]| (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt();
        let p = DelayParams { time_ms: 200.0, feedback: 0.8, ..clean() };
        let open = burst(&p);
        let dark = burst(&DelayParams { cutoff_hz: 500.0, ..p });
        assert!(rms(&dark) < 0.1 * rms(&open), "{} vs {}", rms(&dark), rms(&open));
        // high-pass takes a 100 Hz tone away and leaves the 6 kHz one
        let low = || {
            let mut x = sine(100.0, 9600, 0.4);
            x.resize(20_000, 0.0);
            x
        };
        let (l, _) = run(&DelayParams { mode: 1, cutoff_hz: 2000.0, time_ms: 50.0, ..clean() }, &low(), 32);
        let (lo, _) = run(&DelayParams { mode: 0, cutoff_hz: 2000.0, time_ms: 50.0, ..clean() }, &low(), 32);
        assert!(rms(&l[2400..]) < 0.2 * rms(&lo[2400..]));
    }

    #[test]
    fn saturation_holds_loud_echoes_but_lets_the_tail_decay() {
        let p = DelayParams { time_ms: 50.0, feedback: 0.7, drive: 1.0, ..clean() };
        let mut loud = sine(200.0, 4800, 0.9);
        loud.resize(96_000, 0.0);
        let (l, _) = run(&p, &loud, 32);
        let rms = |x: &[f32]| (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt();
        assert!(l.iter().all(|v| v.is_finite() && v.abs() < 1.5));
        assert!(rms(&l[90_000..]) < 1e-3 * rms(&l[..9600]), "tail should die: {}", rms(&l[90_000..]));
    }

    #[test]
    fn feedback_past_one_oscillates_but_stays_bounded() {
        let p = DelayParams { time_ms: 80.0, feedback: FEEDBACK_MAX, drive: 0.5, ..clean() };
        let mut x = sine(300.0, 2400, 0.3);
        x.resize(480_000, 0.0); // 10 s
        let (l, r) = run(&p, &x, 32);
        let late = &l[400_000..];
        assert!(l.iter().chain(&r).all(|v| v.is_finite() && v.abs() < 2.0));
        assert!(late.iter().any(|v| v.abs() > 0.02), "should still be ringing");
    }

    #[test]
    fn moving_the_time_glides_without_clicks() {
        let x = sine(440.0, 96_000, 0.5);
        let mut d = TapeDelay::new(SR);
        let (mut l, mut r) = (x.clone(), x);
        let mut p = DelayParams { time_ms: 100.0, feedback: 0.3, ..clean() };
        let mut worst: f32 = 0.0;
        let mut prev = 0.0f32;
        for (i, (lc, rc)) in l.chunks_mut(32).zip(r.chunks_mut(32)).enumerate() {
            // throw the knob from 100 ms to 1.5 s and back
            p.time_ms = if (1000..2000).contains(&i) { 1500.0 } else { 100.0 };
            d.process(lc, rc, &p);
            if i > 200 {
                for &v in lc.iter() {
                    worst = worst.max((v - prev).abs());
                    prev = v;
                }
            } else {
                prev = *lc.last().unwrap();
            }
        }
        // a 0.5 sine at 440 Hz moves 0.03 per sample at most; bent up to 1.5x it is 0.05
        assert!(worst < 0.1, "step of {worst}");
        assert!(l.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn warble_wobbles_the_echo_and_zero_warble_does_not() {
        let x = sine(1000.0, 48_000, 0.5);
        let p = DelayParams { time_ms: 100.0, feedback: 0.0, ..clean() };
        // Each channel is the same, so compare two runs: the warbled echo must stray from the steady one.
        let (steady, _) = run(&p, &x, 32);
        let (wob, _) = run(&DelayParams { warble: 1.0, ..p }, &x, 32);
        let diff = steady[10_000..].iter().zip(&wob[10_000..]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(diff > 0.05, "warble made no difference: {diff}");
        assert!(wob.iter().all(|v| v.is_finite() && v.abs() < 1.0));
    }

    #[test]
    fn blocks_of_any_size_give_the_same_signal_and_hostile_params_stay_finite() {
        let x = sine(220.0, 12_000, 0.5);
        let p = DelayParams { time_ms: 37.0, warble: 0.6, drive: 0.5, ..Default::default() };
        assert_eq!(run(&p, &x, 7).0, run(&p, &x, 1000).0);

        let wild = DelayParams {
            time_ms: f32::NAN,
            feedback: f32::INFINITY,
            mix: 50.0,
            warble: -3.0,
            drive: f32::NAN,
            mode: 99,
            cutoff_hz: -1.0,
            resonance: 9.0,
        };
        let (l, r) = run(&wild, &x, 64);
        assert!(l.iter().chain(&r).all(|v| v.is_finite()));
    }

    #[test]
    fn reset_silences_the_tail() {
        let p = DelayParams { time_ms: 100.0, feedback: 0.9, ..clean() };
        let mut d = TapeDelay::new(SR);
        let (mut l, mut r) = (sine(300.0, 4800, 0.5), sine(300.0, 4800, 0.5));
        d.process(&mut l, &mut r, &p);
        d.reset();
        let (mut l, mut r) = (vec![0.0; 24_000], vec![0.0; 24_000]);
        d.process(&mut l, &mut r, &p);
        assert!(l.iter().chain(&r).all(|&v| v == 0.0));
    }
}
