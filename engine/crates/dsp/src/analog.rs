//! Analog-prototype IIR filter that can be stepped over *arbitrary* time intervals
//! (a port of `analog_filter` / `analog_cheby1_lowpass` from wrongbad/wade, `filters.h`).
//!
//! # Idea
//! The filter is the continuous-time ODE `y^(N) + c[N-1] y^(N-1) + ... + c[0] y = x`, whose
//! characteristic polynomial has the Chebyshev-I poles. The state is `[y, y', .., y^(N-1)]`.
//! To advance by `dt` with the input held constant at `x` (zero-order hold), the next `TAYLOR`
//! derivatives are computed from the ODE itself (`y^(N+i) = x^(i) - sum_j c[j] y^(i+j)`, with
//! `x' = x'' = 0`) and the state is extrapolated with a Taylor series. Since `dt` is just a
//! number, one filter serves any ratio between input and output sample times: that is what
//! makes it a *variable* resampler (see `resampler.rs`).
//!
//! Time is measured in units where the cutoff is 1 rad per unit (`cutoff` scales it).
//! The Taylor truncation is only accurate for `|pole| * dt` of order one or less, so keep
//! `dt <= 1` (the resampler guarantees it).

pub const ORDER: usize = 5;
pub const TAYLOR: usize = 3;

#[derive(Clone, Debug)]
pub struct AnalogCheby1 {
    coef: [f32; ORDER],
    state: [f32; ORDER],
}

impl AnalogCheby1 {
    /// Chebyshev-I low-pass with passband edge `cutoff` (rad per time unit) and `ripple_db` of
    /// passband ripple. The DC gain is 1 (odd order).
    pub fn new(cutoff: f32, ripple_db: f32) -> Self {
        // Denominator polynomial built from the left-half-plane poles, as in the reference.
        let mut coef = [0.0f64; ORDER];
        coef[0] = 1.0;
        let n = ORDER as f64;
        let e = (10f64.powf(ripple_db as f64 / 10.0) - 1.0).sqrt();
        let rad_real = ((1.0 / e).asinh() / n).sinh() * cutoff as f64;
        let rad_imag = ((1.0 / e).asinh() / n).cosh() * cutoff as f64;
        let mut i = 1;
        while i <= ORDER {
            // Angle measured counter-clockwise from the +imaginary axis.
            let theta = i as f64 * std::f64::consts::PI / (2.0 * n);
            let pole_r = rad_real * -theta.sin();
            let pole_i = rad_imag * theta.cos();
            let (a, b, c) = if i < ORDER {
                // complex pair: s^2 - 2 Re(p) s + |p|^2
                (1.0, -pole_r * 2.0, pole_r * pole_r + pole_i * pole_i)
            } else {
                (0.0, 1.0, -pole_r) // real pole: s - p
            };
            // coef(s) *= (a s^2 + b s + c); the top (monic) coefficient is implicit.
            for j in (0..ORDER).rev() {
                coef[j] *= c;
                if j >= 1 {
                    coef[j] += b * coef[j - 1];
                }
                if j >= 2 {
                    coef[j] += a * coef[j - 2];
                }
            }
            i += 2;
        }
        let mut c32 = [0.0f32; ORDER];
        for (d, s) in c32.iter_mut().zip(coef) {
            *d = s as f32;
        }
        Self { coef: c32, state: [0.0; ORDER] }
    }

    pub fn reset(&mut self) {
        self.state = [0.0; ORDER];
    }

    /// Hold `input` for `dt` time units; returns the output at the end of the interval.
    pub fn step(&mut self, input: f32, dt: f32) -> f32 {
        let mut y = [0.0f32; ORDER + TAYLOR];
        y[..ORDER].copy_from_slice(&self.state);
        for i in 0..TAYLOR {
            let mut v = if i == 0 { input } else { 0.0 };
            for j in 0..ORDER {
                v -= y[i + j] * self.coef[j];
            }
            y[ORDER + i] = v;
        }
        for i in 0..ORDER {
            let mut s = y[i];
            let mut d = 1.0f32;
            for j in 1..=TAYLOR {
                d *= dt / j as f32;
                s += y[i + j] * d;
            }
            self.state[i] = s;
        }
        self.state[0] * self.coef[0]
    }
}
