//! Equal-power pan law.

use std::f64::consts::FRAC_PI_4;

/// Left/right gains for `pan` in -1..1 (clamped):
///
/// ```text
///   L = cos((pan + 1) * pi/4)        R = sin((pan + 1) * pi/4)
/// ```
///
/// `L^2 + R^2 = 1` for every pan, so total power is constant across the field. The price is
/// that a centred mono signal is 3 dB down in each channel (`cos(pi/4) = 0.7071`), the
/// standard "-3 dB pan law". Hard left is `(1, 0)` and hard right is `(0, 1)`.
pub fn equal_power(pan: f32) -> (f32, f32) {
    let pan = if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { 0.0 };
    let angle = (pan as f64 + 1.0) * FRAC_PI_4;
    (angle.cos() as f32, angle.sin() as f32)
}
