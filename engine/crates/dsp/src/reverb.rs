//! A stereo reverb in the Freeverb mould (Jezar): eight parallel damped feedback combs per
//! channel into four series allpasses, with the right channel's delays offset for width.
//!
//! ```text
//!   in (L+R) -> predelay -> 8 x comb (feedback, low-passed by `damp`) -> 4 x allpass -> wet
//!   out = dry * (1 - mix) + wet * mix
//! ```
//!
//! * `size` (0..1) sets the comb feedback, `0.70 + 0.28 * size`: the decay time.
//! * `damp` (0..1) is the one-pole low-pass in each comb's feedback: higher is a darker tail.
//! * Delay lengths are the classic 44.1 kHz tunings scaled to the sample rate. All buffers are
//!   allocated up front (in `new`), so `process` never allocates.

use crate::util::flush_denormal;

const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
/// Right-channel delay offset (44.1 kHz samples).
const SPREAD: usize = 23;
const INPUT_GAIN: f32 = 0.015;
const WET_GAIN: f32 = 3.0;
const ALLPASS_FEEDBACK: f32 = 0.5;
pub const MAX_PREDELAY_MS: f32 = 200.0;

#[derive(Clone, Debug)]
struct Comb {
    buf: Vec<f32>,
    i: usize,
    lp: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], i: 0, lp: 0.0 }
    }
    #[inline]
    fn tick(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
        let y = self.buf[self.i];
        self.lp = flush_denormal(y * (1.0 - damp) + self.lp * damp);
        self.buf[self.i] = flush_denormal(x + self.lp * feedback);
        self.i += 1;
        if self.i == self.buf.len() {
            self.i = 0;
        }
        y
    }
    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.lp = 0.0;
    }
}

#[derive(Clone, Debug)]
struct Allpass {
    buf: Vec<f32>,
    i: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], i: 0 }
    }
    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        let d = self.buf[self.i];
        let y = d - x;
        self.buf[self.i] = flush_denormal(x + d * ALLPASS_FEEDBACK);
        self.i += 1;
        if self.i == self.buf.len() {
            self.i = 0;
        }
        y
    }
    fn clear(&mut self) {
        self.buf.fill(0.0);
    }
}

#[derive(Clone, Debug)]
pub struct Reverb {
    combs: [Vec<Comb>; 2],
    allpasses: [Vec<Allpass>; 2],
    predelay: Vec<f32>,
    pre_i: usize,
    pre_len: usize,
    sample_rate: f32,
}

impl Reverb {
    pub fn new(sample_rate: f32) -> Self {
        let k = sample_rate as f64 / 44100.0;
        let scaled = |n: usize, extra: usize| (((n + extra) as f64) * k).round() as usize;
        let side = |extra: usize| {
            (
                COMBS.iter().map(|&n| Comb::new(scaled(n, extra))).collect::<Vec<_>>(),
                ALLPASSES.iter().map(|&n| Allpass::new(scaled(n, extra))).collect::<Vec<_>>(),
            )
        };
        let ((cl, al), (cr, ar)) = (side(0), side(SPREAD));
        let max_pre = (MAX_PREDELAY_MS as f64 * 1e-3 * sample_rate as f64).ceil() as usize + 1;
        Self { combs: [cl, cr], allpasses: [al, ar], predelay: vec![0.0; max_pre], pre_i: 0, pre_len: 0, sample_rate }
    }

    /// Clear the tail.
    pub fn reset(&mut self) {
        for c in self.combs.iter_mut().flatten() {
            c.clear();
        }
        for a in self.allpasses.iter_mut().flatten() {
            a.clear();
        }
        self.predelay.fill(0.0);
    }

    /// Process in place. `size`, `damp` in 0..1; `predelay_ms` in 0..=200; `mix` in 0..1.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], size: f32, damp: f32, predelay_ms: f32, mix: f32) {
        let feedback = 0.70 + 0.28 * size.clamp(0.0, 1.0);
        let damp = damp.clamp(0.0, 1.0) * 0.4;
        let mix = mix.clamp(0.0, 1.0);
        let pre = ((predelay_ms.clamp(0.0, MAX_PREDELAY_MS) * 1e-3 * self.sample_rate) as usize).min(self.predelay.len() - 1);
        self.pre_len = pre;
        let n = self.predelay.len();
        for k in 0..l.len().min(r.len()) {
            let (dl, dr) = (l[k], r[k]);
            // predelay: write now, read `pre` samples back
            self.predelay[self.pre_i] = (dl + dr) * INPUT_GAIN;
            let input = self.predelay[(self.pre_i + n - self.pre_len) % n];
            self.pre_i = (self.pre_i + 1) % n;
            let mut wet = [0.0f32; 2];
            for (ch, w) in wet.iter_mut().enumerate() {
                let mut s = 0.0;
                for c in self.combs[ch].iter_mut() {
                    s += c.tick(input, feedback, damp);
                }
                for a in self.allpasses[ch].iter_mut() {
                    s = a.tick(s);
                }
                *w = s * WET_GAIN;
            }
            l[k] = dl * (1.0 - mix) + wet[0] * mix;
            r[k] = dr * (1.0 - mix) + wet[1] * mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f32 = 48000.0;

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn an_impulse_rings_out_and_decays_and_dry_mix_is_untouched() {
        let mut rv = Reverb::new(SR);
        let (mut l, mut r) = (vec![0.0f32; 48000], vec![0.0f32; 48000]);
        l[0] = 1.0;
        r[0] = 1.0;
        rv.process(&mut l, &mut r, 0.5, 0.5, 0.0, 1.0);
        let (early, late) = (rms(&l[2000..8000]), rms(&l[40000..]));
        assert!(early > 1e-3, "no tail: {early}");
        assert!(late < early, "tail should decay: {late} vs {early}");
        assert!(l.iter().chain(r.iter()).all(|v| v.is_finite() && v.abs() < 2.0));
        assert!(l[3000..].iter().zip(&r[3000..]).any(|(a, b)| a != b), "channels should decorrelate");

        let mut rv = Reverb::new(SR);
        let (mut l, mut r) = (vec![0.5f32; 256], vec![0.25f32; 256]);
        rv.process(&mut l, &mut r, 0.5, 0.5, 0.0, 0.0);
        assert!(l.iter().all(|&v| v == 0.5) && r.iter().all(|&v| v == 0.25));
    }

    #[test]
    fn size_lengthens_the_tail_and_predelay_delays_it() {
        let tail = |size: f32| {
            let mut rv = Reverb::new(SR);
            let (mut l, mut r) = (vec![0.0f32; 96000], vec![0.0f32; 96000]);
            l[0] = 1.0;
            r[0] = 1.0;
            rv.process(&mut l, &mut r, size, 0.3, 0.0, 1.0);
            rms(&l[60000..])
        };
        assert!(tail(1.0) > 5.0 * tail(0.2));

        let mut rv = Reverb::new(SR);
        let (mut l, mut r) = (vec![0.0f32; 12000], vec![0.0f32; 12000]);
        l[0] = 1.0;
        r[0] = 1.0;
        rv.process(&mut l, &mut r, 0.5, 0.3, 100.0, 1.0); // 100 ms = 4800 samples
        assert!(l[..4800].iter().all(|&v| v == 0.0), "silent before the predelay");
        assert!(l[4800..].iter().any(|&v| v != 0.0));
    }
}
