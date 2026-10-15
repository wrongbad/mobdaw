use engine::device::{EqDevice, FilterDevice};

const SR: f32 = 48000.0;

fn noise(n: usize) -> Vec<f32> {
    let mut s = 0x9e37_79b9u32;
    (0..n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s as f32 * (2.0 / u32::MAX as f32) - 1.0
        })
        .collect()
}

#[test]
fn all_bands_at_zero_db_is_bit_exact_identity() {
    let x = noise(3000);
    let mut e = EqDevice::new(SR);
    let (mut l, mut r) = (x.clone(), x.clone());
    for (a, b) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
        e.process(a, b, SR);
    }
    assert_eq!(l, x);
    assert_eq!(r, x);
}

#[test]
fn single_active_bell_matches_filter_device_bell() {
    let x = noise(4096);
    let mut f = FilterDevice::new(SR);
    f.set_param_smooth(0, 5.0, 0.0);
    f.set_param_smooth(1, 1500.0, 0.0);
    f.set_param_smooth(2, 0.4, 0.0);
    f.set_param_smooth(3, 9.0, 0.0);
    let mut e = EqDevice::new(SR);
    e.set_param_smooth(3, 1500.0, 0.0);
    e.set_param_smooth(4, 9.0, 0.0);
    e.set_param_smooth(5, 0.4, 0.0);
    let (mut fl, mut fr) = (x.clone(), x.clone());
    let (mut el, mut er) = (x.clone(), x.clone());
    for (a, b) in fl.chunks_mut(64).zip(fr.chunks_mut(64)) {
        f.process(a, b, SR);
    }
    for (a, b) in el.chunks_mut(64).zip(er.chunks_mut(64)) {
        e.process(a, b, SR);
    }
    for (a, b) in fl.iter().zip(&el) {
        assert!((a - b).abs() < 1e-5, "{a} vs {b}");
    }
    assert_eq!(el, er);
}

/// Peak magnitude of the steady output for a sine at `hz`.
fn sine_gain(e: &mut EqDevice, hz: f32) -> f32 {
    let n = 9600;
    let x: Vec<f32> = (0..n).map(|i| (std::f32::consts::TAU * hz * i as f32 / SR).sin()).collect();
    let (mut l, mut r) = (x.clone(), x.clone());
    for (a, b) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
        e.process(a, b, SR);
    }
    l[n / 2..].iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

#[test]
fn body_is_eight_bells_with_output_at_24() {
    let x = noise(3000);
    let mut b = EqDevice::body(SR);
    let (mut l, mut r) = (x.clone(), x.clone());
    for (a, c) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
        b.process(a, c, SR);
    }
    assert_eq!(l, x, "all bands at 0 dB is a passthrough");

    // Band 7 (the last) as a narrow +12 dB bell at 3 kHz: boosts 3 kHz by ~4x, leaves 300 Hz alone.
    let mut b = EqDevice::body(SR);
    b.set_param_smooth(21, 3000.0, 0.0);
    b.set_param_smooth(22, 12.0, 0.0);
    assert!((sine_gain(&mut b, 3000.0) - 3.98).abs() < 0.1);
    b.reset();
    assert!((sine_gain(&mut b, 300.0) - 1.0).abs() < 0.02);

    // Output gain is param 24 for the body (12 for the EQ).
    let mut b = EqDevice::body(SR);
    b.set_param_smooth(24, -6.0, 0.0);
    assert!((sine_gain(&mut b, 1000.0) - 0.501).abs() < 0.01);
}
