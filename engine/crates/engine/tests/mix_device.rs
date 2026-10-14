use engine::device::{Device, MixDevice, KIND_MIX};

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
fn master_at_unity_and_centre_is_bit_exact_identity() {
    let x = noise(3000);
    let mut m = MixDevice::new(SR, true);
    let (mut l, mut r) = (x.clone(), x.clone());
    for (a, b) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
        m.process(a, b);
    }
    assert_eq!((l, r), (x.clone(), x));
}

#[test]
fn track_pan_law_is_equal_power_and_gain_scales_both_sides() {
    for (pan, wl, wr) in [(-1.0f32, 1.0f32, 0.0f32), (0.0, 0.70710677, 0.70710677), (1.0, 0.0, 1.0)] {
        let mut m = MixDevice::new(SR, false);
        m.set_param(0, 0.5);
        m.set_param(1, pan);
        let (mut l, mut r) = (vec![1.0f32; 64], vec![1.0f32; 64]);
        m.process(&mut l, &mut r);
        assert!((l[63] - 0.5 * wl).abs() < 1e-6 && (r[63] - 0.5 * wr).abs() < 1e-6, "pan {pan}: {} {}", l[63], r[63]);
    }
}

#[test]
fn stereo_input_keeps_its_sides_and_only_scales_them() {
    let mut m = MixDevice::new(SR, true);
    m.set_param(1, 1.0);
    let (mut l, mut r) = (vec![0.5f32; 64], vec![-0.25f32; 64]);
    m.process(&mut l, &mut r);
    assert!(l[63].abs() < 1e-7 && r[63] == -0.25, "hard right keeps the right side as it is: {} {}", l[63], r[63]);
}

#[test]
fn a_change_glides_linearly_over_10ms_but_the_first_value_snaps() {
    let mut m = MixDevice::new(SR, false);
    m.set_param(0, 1.0); // first: snaps
    m.set_param(1, -1.0);
    let (mut l, mut r) = (vec![1.0f32; 1], vec![1.0f32; 1]);
    m.process(&mut l, &mut r);
    assert_eq!(l[0], 1.0, "no glide in from the defaults");
    m.set_param(0, 0.0);
    let mut out = Vec::new();
    for _ in 0..10 {
        let (mut l, mut r) = (vec![1.0f32; 64], vec![1.0f32; 64]);
        m.process(&mut l, &mut r);
        out.extend(l);
    }
    assert!(out[0] < 1.0 && out[0] > 0.99);
    assert!((out[239] - 0.5).abs() < 0.01, "halfway {}", out[239]);
    assert!(out[512..].iter().all(|&x| x == 0.0));
    assert!(out.windows(2).all(|w| w[1] <= w[0]), "monotone");
}

#[test]
fn reports_glides_and_sleeps_when_at_rest() {
    let mut d = Device::new(1, KIND_MIX, 1.0, false, SR);
    assert!(!d.is_ramping() && d.is_asleep());
    d.set_param(0, 0.5);
    assert!(!d.is_ramping(), "the first value snaps");
    d.set_param(0, 1.0);
    assert!(d.is_ramping() && !d.is_asleep());
    // an automated value ramps the smoothed params across the segment
    d.set_param_auto(1, 0.0, 1.0, 32);
    assert!(d.is_ramping());
    let (mut l, mut r) = (vec![1.0f32; 32], vec![1.0f32; 32]);
    d.process(&mut l, &mut r, SR);
    assert!(r[31] > r[0] && l[31] < l[0], "pan moved right across the segment");
}
