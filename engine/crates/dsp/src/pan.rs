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

/// Left/right gains of a balance control on a stereo signal: the same equal-power curve scaled so the centre is
/// unity, then capped at 1, so panning only ever turns the far side down. Hard left is `(1, 0)`, hard right `(0, 1)`.
pub fn balance(pan: f32) -> (f32, f32) {
    let pan = if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { 0.0 };
    let angle = (pan as f64 + 1.0) * FRAC_PI_4;
    ((angle.cos() * std::f64::consts::SQRT_2).min(1.0) as f32, (angle.sin() * std::f64::consts::SQRT_2).min(1.0) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_power_law() {
        assert_eq!(equal_power(-1.0).1, 0.0);
        assert!((equal_power(1.0).0).abs() < 1e-7);
        let (l, r) = equal_power(0.0);
        assert!((l - 0.70710677).abs() < 1e-6 && l == r);
        for p in [-1.0, -0.6, -0.1, 0.3, 0.9] {
            let (l, r) = equal_power(p);
            assert!((l * l + r * r - 1.0).abs() < 1e-6);
        }
    }

    #[test]
    fn balance_is_unity_at_the_centre_and_never_boosts() {
        assert_eq!(balance(0.0), (1.0, 1.0));
        assert_eq!(balance(-1.0), (1.0, 0.0));
        let (l, r) = balance(1.0);
        assert!(l.abs() < 1e-7 && r == 1.0);
        for p in [-0.8, -0.3, 0.2, 0.7] {
            let (l, r) = balance(p);
            assert!(l <= 1.0 && r <= 1.0 && (l == 1.0 || r == 1.0));
        }
    }
}
