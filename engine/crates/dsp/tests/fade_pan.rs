use dsp::fade::{clip_edge_gain, fade_in_gain, DECLICK_SAMPLES};
use dsp::pan::equal_power;
use dsp::FadeShape;
use std::f64::consts::PI;

#[test]
fn fade_shapes_match_their_formulas() {
    for i in 0..=100 {
        let t = i as f64 / 100.0;
        let eq = fade_in_gain(FadeShape::EqualPower, t) as f64;
        let li = fade_in_gain(FadeShape::Linear, t) as f64;
        let sc = fade_in_gain(FadeShape::SCurve, t) as f64;
        assert!((eq - (t * PI / 2.0).sin()).abs() < 1e-6);
        assert!((li - t).abs() < 1e-6);
        assert!((sc - (0.5 - 0.5 * (t * PI).cos())).abs() < 1e-6);
    }
    // Endpoints, and the equal-power property of in vs mirrored out: g_in^2 + g_out^2 = 1.
    for s in [FadeShape::EqualPower, FadeShape::Linear, FadeShape::SCurve] {
        assert_eq!(fade_in_gain(s, 0.0), 0.0);
        assert!((fade_in_gain(s, 1.0) - 1.0).abs() < 1e-7);
    }
    for i in 0..=20 {
        let t = i as f64 / 20.0;
        let (gi, go) = (fade_in_gain(FadeShape::EqualPower, t), fade_in_gain(FadeShape::EqualPower, 1.0 - t));
        assert!((gi * gi + go * go - 1.0).abs() < 1e-6);
    }
}

#[test]
fn declick_is_64_samples_monotone_and_symmetric() {
    let len = 1000;
    for shape in [FadeShape::EqualPower, FadeShape::Linear, FadeShape::SCurve] {
        let g: Vec<f32> = (0..len).map(|k| clip_edge_gain(k, len, 0.0, 0.0, shape)).collect();
        assert_eq!(g[0], 0.0);
        for k in 1..DECLICK_SAMPLES as usize {
            assert!(g[k] > g[k - 1], "{shape:?} not strictly rising at {k}");
        }
        assert_eq!(g[64], 1.0);
        assert_eq!(g[len as usize - 65], 1.0);
        for k in 0..len as usize {
            assert_eq!(g[k], g[len as usize - 1 - k], "mirror at {k}");
        }
        println!("declick {shape:?}: g[1]={:.5} g[32]={:.5} g[63]={:.5} g[64]={}", g[1], g[32], g[63], g[64]);
    }
}

#[test]
fn user_fades_longer_than_declick_win() {
    let g = |k| clip_edge_gain(k, 10_000, 500.0, 0.0, FadeShape::Linear);
    assert!((g(250) - 0.5).abs() < 1e-6);
    assert_eq!(g(500), 1.0);
}

#[test]
fn pan_law_is_equal_power() {
    let (l, r) = equal_power(-1.0);
    println!("pan -1: L={l} R={r}");
    assert_eq!((l, r), (1.0, 0.0));
    let (l, r) = equal_power(0.0);
    println!("pan  0: L={l} R={r}");
    assert!((l - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6 && (r - l).abs() < 1e-6);
    let (l, r) = equal_power(1.0);
    println!("pan +1: L={l:e} R={r}");
    assert!(l.abs() < 1e-6 && (r - 1.0).abs() < 1e-6);
    for i in -10..=10 {
        let (l, r) = equal_power(i as f32 / 10.0);
        assert!((l * l + r * r - 1.0).abs() < 1e-6);
    }
}
