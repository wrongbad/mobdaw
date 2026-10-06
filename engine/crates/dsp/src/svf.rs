use crate::util::flush_denormal;

/// Resonant state-variable filter (topology-preserving transform / zero-delay feedback,
/// after Zavalishin). Ported from the wade C++ `state_variable_filter`.
///
/// One tick yields low-pass, band-pass and high-pass outputs simultaneously. Unlike a
/// direct-form biquad, the state variables are the two integrator (capacitor) states, so the
/// filter stays well behaved when cutoff and damping change every sample.
///
/// # Math
/// Continuous prototype, with `s` normalised to the cutoff and `R` the damping:
///
/// ```text
/// HP = s^2 / (s^2 + 2R s + 1)    BP = s / (s^2 + 2R s + 1)    LP = 1 / (s^2 + 2R s + 1)
/// ```
///
/// The two integrators are discretised with the trapezoidal rule (bilinear transform), which
/// maps analog frequency `w` to digital `2*atan(w/2)`. Pre-warping with `g = tan(w0/2)`
/// (w0 in radians/sample) makes the digital cutoff land exactly on `w0` at any frequency, up
/// to Nyquist. The loop is solved algebraically (no unit delay in the feedback path), which
/// gives `norm = 1 / (1 + 2R*g + g^2)`.
///
/// * `damping` is `R`; larger means less resonance. `R = 1/sqrt(2)` is Butterworth (maximally
///   flat, -3.01 dB at the cutoff); `Q = 1/(2R)`.
/// * Notch is `lp + hp`, peak is `lp - hp`. Shelves and bells can be built by mixing outputs.
#[derive(Clone, Debug)]
pub struct Svf {
    g: f32,
    r2g: f32,
    norm: f32,
    hp: f32,
    bp: f32,
    lp: f32,
    s1: f32,
    s2: f32,
}

impl Default for Svf {
    fn default() -> Self {
        let mut f = Self { g: 0.0, r2g: 0.0, norm: 1.0, hp: 0.0, bp: 0.0, lp: 0.0, s1: 0.0, s2: 0.0 };
        f.set_hz(1000.0, std::f32::consts::FRAC_1_SQRT_2, 48000.0);
        f
    }
}

impl Svf {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set from a cutoff in Hz. The tangent is evaluated in f64 so it stays accurate close
    /// to Nyquist, where `tan` blows up; the cutoff is clamped just below Nyquist.
    pub fn set_hz(&mut self, cutoff_hz: f32, damping: f32, sample_rate: f32) {
        let sr = sample_rate as f64;
        let fc = (cutoff_hz as f64).clamp(1.0, 0.499 * sr);
        self.set_g(((std::f64::consts::PI * fc / sr).tan()) as f32, damping);
    }

    /// `f0` is the cutoff in radians/sample; pre-warped with `tan` (the C++ `set_exact`).
    pub fn set_exact(&mut self, f0: f32, damping: f32) {
        self.set(((f0 / 2.0).tan()) * 2.0, damping);
    }

    /// `f0` is the *already pre-warped* cutoff, `2*tan(w0/2)` (the C++ `set`). Cheap, so it
    /// suits modulation where the caller computes the warp some other way.
    pub fn set(&mut self, f0: f32, damping: f32) {
        self.set_g(f0 / 2.0, damping);
    }

    #[inline]
    fn set_g(&mut self, g: f32, damping: f32) {
        self.g = g;
        self.r2g = damping * 2.0 + g;
        self.norm = 1.0 / (1.0 + self.r2g * g);
    }

    /// Clear the integrator states.
    pub fn reset(&mut self) {
        self.hp = 0.0;
        self.bp = 0.0;
        self.lp = 0.0;
        self.s1 = 0.0;
        self.s2 = 0.0;
    }

    /// Process one sample; read the results from `lp()`, `bp()`, `hp()` etc.
    #[inline]
    pub fn process(&mut self, x: f32) -> &mut Self {
        // Solve the zero-delay loop for the high-pass output first...
        self.hp = (x - self.r2g * self.s1 - self.s2) * self.norm;
        // ...then run the two trapezoidal integrators. Each outputs `g*in + s` and stores
        // `g*in + output` as the next state.
        self.bp = self.g * self.hp + self.s1;
        self.s1 = flush_denormal(self.g * self.hp + self.bp);
        self.lp = self.g * self.bp + self.s2;
        self.s2 = flush_denormal(self.g * self.bp + self.lp);
        self
    }

    #[inline]
    pub fn lp(&self) -> f32 {
        self.lp
    }
    #[inline]
    pub fn bp(&self) -> f32 {
        self.bp
    }
    #[inline]
    pub fn hp(&self) -> f32 {
        self.hp
    }
    /// Band-reject: `lp + hp` = (s^2 + 1) / (s^2 + 2R s + 1), zero at the cutoff.
    #[inline]
    pub fn notch(&self) -> f32 {
        self.lp + self.hp
    }
    /// `lp - hp` = (1 - s^2) / (s^2 + 2R s + 1), gain 1/R at the cutoff.
    #[inline]
    pub fn peak(&self) -> f32 {
        self.lp - self.hp
    }
}
