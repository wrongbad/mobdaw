//! Variable-rate resampler (the idea is wade's `variable_resampler`, `interp.h`), stereo, with
//! `f64` read positions so long timelines don't lose precision.
//!
//! The input is turned into a continuous signal (zero-order hold or first-order hold: linear
//! interpolation between samples), and an analog low-pass filter is integrated across it. Reading
//! at position `to` means "step the filter over every input interval between the previous position
//! and `to`". The filter's time axis is scaled by `scale = min(1, 1/speed)`, so
//!   * `speed <= 1` (upsampling): one filter time unit = one *input* sample; the filter removes the
//!     images of the hold;
//!   * `speed > 1` (downsampling): one filter time unit = one *output* sample, so the cutoff
//!     drops with the speed and removes what would alias.
//!
//! # Exact modal stepping
//! The filter is a bank of 4 complex one-poles (see [`crate::analog`]), stepped *exactly* (no Taylor
//! truncation, so no spurs at non-integer speeds). The state is kept only at integer input
//! positions: a full step is one table lookup (cached per `scale`) and an update of 4 lanes x
//! (L, R) x (re, im); the fractional position is *evaluated* from a 256-entry table over
//! `dt` in `[0, 1]` and never stored. The 4 modes are the 4 lanes of one `f32x4` (explicit
//! `simd128` on wasm, the same arithmetic in the same order as the scalar fallback, so the two
//! agree bit for bit).
//!
//! # Designs
//! * [`Resampler::new`] (vintage): Chebyshev-I order 5, 2 dB, cutoff 1 rad, zero-order hold: the
//!   tape delay's "every pass darkens" character (-0.9 dB at 1 kHz, -7 dB at 8 kHz, -37 dB at
//!   12 kHz at speed 1).
//! * [`Resampler::clean`]: first-order hold, Chebyshev-I order 7, 0.5 dB, 2.2 rad: a wider,
//!   flatter filter with strong image rejection. Used by the looper.
//!
//! The coefficient tables are built once (first construction of a resampler of that design) and
//! shared. Construct resamplers off the audio thread (they are, as part of device creation).

use crate::analog::{cheby1, phi1, phi2, Mode, C};
use crate::util::flush_denormal;
use std::sync::OnceLock;

const K: usize = 4;
const M: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Design {
    /// Chebyshev-I N5, 2 dB, 1 rad, zero-order hold.
    Vintage,
    /// First-order hold, Chebyshev-I N7, 0.5 dB, 2.2 rad.
    Clean,
}

// ---- design parameters --------------------------------------------------------------------
pub const VINTAGE_CUTOFF: f64 = 1.0;
pub const VINTAGE_RIPPLE_DB: f64 = 2.0;

#[derive(Clone, Copy, Debug)]
#[repr(C, align(16))]
struct V([f32; K]);

#[derive(Clone, Copy, Debug)]
struct Co {
    er: V,
    ei: V,
    ar: V,
    ai: V,
    br: V,
    bi: V,
}

/// The shared per-design tables.
#[derive(Debug)]
pub struct Table {
    co: Box<[Co]>,
    /// Output weights: 2 for a conjugate pair, 1 for a real pole, 0 for an unused lane.
    w: V,
    foh: bool,
    /// Input samples (per unit of `max(speed, 1)`) after which a fresh filter's state is
    /// within ~1e-5 of settled.
    settle: f64,
}

fn coefs(modes: &[Mode], foh: bool, dt: f64) -> Co {
    let mut c = Co {
        er: V([0.0; K]),
        ei: V([0.0; K]),
        ar: V([0.0; K]),
        ai: V([0.0; K]),
        br: V([0.0; K]),
        bi: V([0.0; K]),
    };
    for (k, m) in modes.iter().enumerate() {
        let z = m.pole.scale(dt);
        let e = z.exp();
        let a = m.residue.mul(phi1(z)).scale(dt);
        let b = if foh { m.residue.mul(phi2(z)).scale(dt) } else { C::new(0.0, 0.0) };
        c.er.0[k] = e.re as f32;
        c.ei.0[k] = e.im as f32;
        c.ar.0[k] = a.re as f32;
        c.ai.0[k] = a.im as f32;
        c.br.0[k] = b.re as f32;
        c.bi.0[k] = b.im as f32;
    }
    c
}

impl Table {
    fn build(modes: &[Mode], foh: bool) -> Table {
        assert!(modes.len() <= K);
        let co: Vec<Co> = (0..=M).map(|j| coefs(modes, foh, j as f64 / M as f64)).collect();
        let mut w = [0.0f32; K];
        let mut slowest = f64::MAX;
        for (k, m) in modes.iter().enumerate() {
            w[k] = if m.pair { 2.0 } else { 1.0 };
            slowest = slowest.min(-m.pole.re);
        }
        Table { co: co.into_boxed_slice(), w: V(w), foh, settle: 12.0 / slowest }
    }

    /// Coefficients for a step of `dt` filter units (linear between table nodes).
    #[inline(always)]
    fn at(&self, dt: f32) -> Co {
        let u = dt.clamp(0.0, 1.0) * M as f32;
        let j = (u as usize).min(M - 1);
        let t = u - j as f32;
        let (a, b) = (&self.co[j], &self.co[j + 1]);
        Co {
            er: lerp(a.er, b.er, t),
            ei: lerp(a.ei, b.ei, t),
            ar: lerp(a.ar, b.ar, t),
            ai: lerp(a.ai, b.ai, t),
            br: lerp(a.br, b.br, t),
            bi: lerp(a.bi, b.bi, t),
        }
    }
}

/// The vintage mode set (Chebyshev-I order 5, 2 dB, 1 rad).
pub fn vintage_modes() -> Vec<Mode> {
    cheby1(5, VINTAGE_RIPPLE_DB, VINTAGE_CUTOFF)
}

/// The clean design: Chebyshev-I order 7, 0.5 dB, 2.2 rad, first-order hold.
pub const CLEAN_CUTOFF: f64 = 2.2;
pub const CLEAN_RIPPLE_DB: f64 = 0.5;

pub fn clean_modes() -> Vec<Mode> {
    cheby1(7, CLEAN_RIPPLE_DB, CLEAN_CUTOFF)
}

static VINTAGE: OnceLock<Table> = OnceLock::new();
static CLEAN: OnceLock<Table> = OnceLock::new();

fn table(d: Design) -> &'static Table {
    match d {
        Design::Vintage => VINTAGE.get_or_init(|| Table::build(&vintage_modes(), false)),
        Design::Clean => CLEAN.get_or_init(|| Table::build(&clean_modes(), true)),
    }
}

// ---- f32x4 kernels ------------------------------------------------------------------------
// The wasm path and the scalar path perform the same f32 operations in the same order (no fused
// multiply-add anywhere), so they agree bit for bit.

type State = [V; 4];

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod vec4 {
    use super::{Co, State, V};
    use core::arch::wasm32::*;
    #[inline(always)]
    fn ld(a: &V) -> v128 {
        // SAFETY: `V` is 16-byte aligned and exactly 4 f32.
        unsafe { v128_load(a as *const V as *const v128) }
    }
    #[inline(always)]
    fn st(a: v128) -> V {
        let mut o = V([0.0; 4]);
        // SAFETY: as above.
        unsafe { v128_store(&mut o as *mut V as *mut v128, a) };
        o
    }
    #[inline(always)]
    pub fn lerp(a: V, b: V, t: f32) -> V {
        let (a, b) = (ld(&a), ld(&b));
        st(f32x4_add(a, f32x4_mul(f32x4_sub(b, a), f32x4_splat(t))))
    }
    #[inline(always)]
    pub fn apply(c: &Co, s: &State, u0: (f32, f32), du: (f32, f32)) -> State {
        let (er, ei, ar, ai, br, bi) = (ld(&c.er), ld(&c.ei), ld(&c.ar), ld(&c.ai), ld(&c.br), ld(&c.bi));
        let (u0l, u0r, dul, dur) = (f32x4_splat(u0.0), f32x4_splat(u0.1), f32x4_splat(du.0), f32x4_splat(du.1));
        let (lr, li, rr, ri) = (ld(&s[0]), ld(&s[1]), ld(&s[2]), ld(&s[3]));
        let o0 = f32x4_add(f32x4_add(f32x4_sub(f32x4_mul(er, lr), f32x4_mul(ei, li)), f32x4_mul(ar, u0l)), f32x4_mul(br, dul));
        let o1 = f32x4_add(f32x4_add(f32x4_add(f32x4_mul(er, li), f32x4_mul(ei, lr)), f32x4_mul(ai, u0l)), f32x4_mul(bi, dul));
        let o2 = f32x4_add(f32x4_add(f32x4_sub(f32x4_mul(er, rr), f32x4_mul(ei, ri)), f32x4_mul(ar, u0r)), f32x4_mul(br, dur));
        let o3 = f32x4_add(f32x4_add(f32x4_add(f32x4_mul(er, ri), f32x4_mul(ei, rr)), f32x4_mul(ai, u0r)), f32x4_mul(bi, dur));
        [st(o0), st(o1), st(o2), st(o3)]
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod vec4 {
    use super::{Co, State, V};
    #[inline(always)]
    pub fn lerp(a: V, b: V, t: f32) -> V {
        let mut o = a;
        for k in 0..super::K {
            o.0[k] = a.0[k] + (b.0[k] - a.0[k]) * t;
        }
        o
    }

    /// `s <- e s + a u0 + b du` per lane, for L (re, im) and R (re, im). `s = [Lre, Lim, Rre, Rim]`.
    #[inline(always)]
    pub fn apply(c: &Co, s: &State, u0: (f32, f32), du: (f32, f32)) -> State {
        let mut o = [V([0.0; 4]); 4];
        for k in 0..4 {
            o[0].0[k] = c.er.0[k] * s[0].0[k] - c.ei.0[k] * s[1].0[k] + c.ar.0[k] * u0.0 + c.br.0[k] * du.0;
            o[1].0[k] = c.er.0[k] * s[1].0[k] + c.ei.0[k] * s[0].0[k] + c.ai.0[k] * u0.0 + c.bi.0[k] * du.0;
            o[2].0[k] = c.er.0[k] * s[2].0[k] - c.ei.0[k] * s[3].0[k] + c.ar.0[k] * u0.1 + c.br.0[k] * du.1;
            o[3].0[k] = c.er.0[k] * s[3].0[k] + c.ei.0[k] * s[2].0[k] + c.ai.0[k] * u0.1 + c.bi.0[k] * du.1;
        }
        o
    }
}

use vec4::{apply, lerp};

type P = (f32, f32);

#[derive(Clone, Debug)]
pub struct Resampler {
    t: &'static Table,
    /// Modal state at the integer input position `i`.
    s: State,
    /// Step counter: the denormal flush of `s` runs every 16th step.
    n: u32,
    i: i64,
    pos: f64,
    /// Whether `x`/`e` hold the input around `i` (cleared by restart / clear_cache).
    primed: bool,
    /// Raw input at i-1, i, i+1, i+2 (x[1] = x[i], x[2] = x[i+1]; the vintage design only uses x[1]).
    x: [P; 4],
    /// The (compensated) hold values at i and i+1.
    e0: P,
    e1: P,
    full: Co,
    full_scale: f32,
}

impl Default for Resampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Resampler {
    /// The vintage response (Chebyshev-I 5th order, 2 dB, ZOH): what the tape delay uses.
    pub fn new() -> Self {
        Self::with_design(Design::Vintage)
    }

    /// The clean response (first-order hold, wide and flat): what the looper uses.
    pub fn clean() -> Self {
        Self::with_design(Design::Clean)
    }

    pub fn with_design(d: Design) -> Self {
        let t = table(d);
        Self {
            t,
            s: [V([0.0; K]); 4],
            n: 0,
            i: 0,
            pos: 0.0,
            primed: false,
            x: [(0.0, 0.0); 4],
            e0: (0.0, 0.0),
            e1: (0.0, 0.0),
            full: t.co[M],
            full_scale: f32::NAN,
        }
    }

    /// Input samples a fresh filter needs before the read position to be settled, at `speed`.
    pub fn warmup(&self, speed: f64) -> i64 {
        (self.t.settle * speed.max(1.0)).ceil() as i64
    }

    /// Forget all history and start reading at input index `at`.
    pub fn restart(&mut self, at: i64) {
        self.s = [V([0.0; K]); 4];
        self.i = at;
        self.pos = at as f64;
        self.primed = false;
    }

    pub fn pos(&self) -> f64 {
        self.pos
    }

    /// Drop the cached input samples (call when the input signal may have changed).
    pub fn clear_cache(&mut self) {
        self.primed = false;
    }

    fn prime(&mut self, input: &mut impl FnMut(i64) -> P) {
        let i = self.i;
        let t = self.t;
        if t.foh {
            self.x[1] = input(i);
            self.x[2] = input(i + 1);
            self.x[3] = input(i + 2);
            self.e0 = self.x[1];
            self.e1 = self.x[2];
        } else {
            self.x[1] = input(i);
            self.e0 = self.x[1];
            self.e1 = self.x[1];
        }
        self.primed = true;
    }

    /// Move the state from integer position `i` to `i + 1`, with `full` the coefficients of a
    /// whole step.
    #[inline(always)]
    fn step(&mut self, input: &mut impl FnMut(i64) -> P) {
        let du = (self.e1.0 - self.e0.0, self.e1.1 - self.e0.1);
        self.s = apply(&self.full, &self.s, self.e0, du);
        // A decaying mode needs thousands of steps to cross the denormal range (wasm has no FTZ), so
        // flushing it a few steps late is harmless and keeps the check off the recurrence's chain.
        self.n = self.n.wrapping_add(1);
        if self.n & 15 == 0 {
            for v in &mut self.s {
                for x in &mut v.0 {
                    *x = flush_denormal(*x);
                }
            }
        }
        self.i += 1;
        let t = self.t;
        if t.foh {
            self.x[1] = self.x[2];
            self.x[2] = self.x[3];
            self.x[3] = input(self.i + 2);
            self.e0 = self.e1;
            self.e1 = self.x[2];
        } else {
            self.x[1] = input(self.i);
            self.e0 = self.x[1];
            self.e1 = self.x[1];
        }
    }

    /// Move the read position forward to `to` (>= the current position) and return the output
    /// there. `scale` is `min(1, 1/speed)`.
    pub fn advance(&mut self, input: &mut impl FnMut(i64) -> P, to: f64, scale: f32) -> P {
        if !self.primed {
            self.prime(input);
        }
        let ti = (to.floor() as i64).max(self.i);
        if self.i < ti {
            if scale != self.full_scale {
                self.full = self.t.at(scale);
                self.full_scale = scale;
            }
            while self.i < ti {
                self.step(input);
            }
        }
        let f = ((to - self.i as f64).max(0.0) as f32).min(1.0);
        let du = ((self.e1.0 - self.e0.0) * f, (self.e1.1 - self.e0.1) * f);
        let y = apply(&self.t.at(f * scale), &self.s, self.e0, du);
        let w = &self.t.w.0;
        let l = (w[0] * y[0].0[0] + w[1] * y[0].0[1]) + (w[2] * y[0].0[2] + w[3] * y[0].0[3]);
        let r = (w[0] * y[2].0[0] + w[1] * y[2].0[1]) + (w[2] * y[2].0[2] + w[3] * y[2].0[3]);
        self.pos = to;
        (l, r)
    }
}
