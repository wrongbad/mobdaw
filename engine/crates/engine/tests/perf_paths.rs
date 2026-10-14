//! Tests of the fast paths: the clip renderer against its per-sample reference, ramped
//! automation, effects over whole blocks, and the cheap rounding.

use engine::clip::{round_away, AudioClip};
use engine::device::{Device, KIND_FILTER};
use engine::source::{Source, LIVE_CHUNK};
use engine::{Engine, BLOCK};
use dsp::FadeShape;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> i64 {
        (self.next() % n) as i64
    }
    fn f(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32 * 2.0 - 1.0
    }
}

fn flat_source(rng: &mut Rng, channels: usize, frames: usize) -> Source {
    let mut s = Source::new(channels, frames);
    for x in s.data_mut() {
        *x = rng.f();
    }
    s.set_ready();
    s
}

fn live_source(rng: &mut Rng, channels: usize, written: usize) -> Source {
    let mut s = Source::live(channels);
    s.live_reserve(written.max(1) + LIVE_CHUNK);
    let mut done = 0;
    while done < written {
        let m = (written - done).min(5000);
        let a: Vec<f32> = (0..m).map(|_| rng.f()).collect();
        let b: Vec<f32> = (0..m).map(|_| rng.f()).collect();
        s.live_append(&[&a, &b]);
        done += m;
    }
    s
}

#[test]
fn clip_render_matches_the_per_sample_reference_bit_for_bit() {
    let mut rng = Rng(0x1234_5678_9abc_def1);
    let mut checked = 0u64;
    for case in 0..600 {
        let channels = 1 + (case % 2);
        let frames = [50usize, 700, 5000, 70_000][rng.below(4) as usize];
        let src = if case % 3 == 0 {
            { let w = rng.below(frames as u64 + 1) as usize; live_source(&mut rng, channels, w) }
        } else {
            flat_source(&mut rng, channels, frames)
        };
        let length = 1 + rng.below(30_000);
        let looping = rng.below(3) != 0;
        let loop_length = if looping { { let m = [5u64, 100, 900, 12_000, 40_000][rng.below(5) as usize]; 1 + rng.below(m) } } else { 0 };
        let clip = AudioClip {
            track: 1,
            source: 1,
            start: rng.below(2000) - 500,
            length,
            source_offset: [0, rng.below(300), rng.below(2000)][rng.below(3) as usize] - if rng.below(5) == 0 { 40 } else { 0 },
            gain: [1.0, 0.7, 1.9][rng.below(3) as usize],
            fade_in: [0.0, 10.0, 300.5, 50_000.0][rng.below(4) as usize],
            fade_out: [0.0, 64.0, 777.0, 90_000.0][rng.below(4) as usize],
            shape: [FadeShape::EqualPower, FadeShape::Linear, FadeShape::SCurve][rng.below(3) as usize],
            loop_length,
            loop_phase: if loop_length > 0 { rng.below(loop_length as u64) } else { 0 },
            seam_max: 480,
        };
        let mut block = clip.start - 200;
        while block < clip.start + clip.length + 200 {
            let n = [128usize, 128, 128, 37, 1][rng.below(5) as usize];
            let base: Vec<f32> = (0..2 * n).map(|_| rng.f()).collect();
            let (mut l1, mut r1) = (base[..n].to_vec(), base[n..].to_vec());
            let (mut l2, mut r2) = (l1.clone(), r1.clone());
            clip.render_add(&src, block, &mut l1, &mut r1);
            clip.render_add_reference(&src, block, &mut l2, &mut r2);
            for j in 0..n {
                assert_eq!(l1[j].to_bits(), l2[j].to_bits(), "case {case} block {block} j {j}");
                assert_eq!(r1[j].to_bits(), r2[j].to_bits(), "case {case} block {block} j {j}");
            }
            checked += n as u64;
            block += n as i64 * if length > 3000 { 7 } else { 1 };
        }
    }
    println!("clip render: {checked} samples bit-identical");
}

#[test]
fn round_away_equals_f64_round() {
    let mut rng = Rng(99);
    let mut vals = vec![0.0, -0.0, 0.5, -0.5, 0.49999999999999994, -0.49999999999999994, 1.5, 2.5, -2.5, 4503599627370495.5, 1e300, f64::INFINITY, f64::NEG_INFINITY];
    for _ in 0..2_000_000 {
        let bits = rng.next();
        vals.push(f64::from_bits(bits));
        vals.push((bits >> 11) as f64 / (1u64 << 30) as f64 - 1000.0);
        vals.push(((bits >> 20) as i64 % 100_000) as f64 + 0.5);
    }
    for v in vals {
        let (a, b) = (round_away(v), v.round());
        assert!(a == b || (a.is_nan() && b.is_nan()), "{v}: {a} vs {b}");
    }
}

/// Effects with static params don't care how the block is cut.
#[test]
fn effect_over_a_block_matches_segmented_processing_when_params_are_at_rest() {
    let mut rng = Rng(5);
    for mode in 0..7 {
        let mut a = Device::new(1, KIND_FILTER, 0.0, false, 48000.0);
        let mut b = Device::new(1, KIND_FILTER, 0.0, false, 48000.0);
        for d in [&mut a, &mut b] {
            d.set_param_auto(0, mode as f32, mode as f32, 0);
            d.set_param_auto(1, 1500.0, 1500.0, 0);
            d.set_param_auto(3, 6.0, 6.0, 0);
        }
        for _ in 0..10 {
            let l: Vec<f32> = (0..BLOCK).map(|_| rng.f()).collect();
            let r: Vec<f32> = (0..BLOCK).map(|_| rng.f()).collect();
            let (mut l1, mut r1, mut l2, mut r2) = (l.clone(), r.clone(), l, r);
            a.process(&mut l1, &mut r1, 48000.0);
            for (lc, rc) in l2.chunks_mut(32).zip(r2.chunks_mut(32)) {
                b.process(lc, rc, 48000.0);
            }
            assert!(l1.iter().zip(&l2).all(|(x, y)| x.to_bits() == y.to_bits()), "mode {mode}");
            assert!(r1.iter().zip(&r2).all(|(x, y)| x.to_bits() == y.to_bits()), "mode {mode}");
        }
    }
}

/// A synth playing one long note with its gain automated by a lane with `points`
/// (`(pos, normalised value, hold)`; range 0..2, so 0.5 is unity). Returns the left channel.
fn synth_with_gain_lane(points: &[(i64, f32, bool)], blocks: usize) -> Vec<f32> {
    let mut e = Engine::new(48000.0);
    e.track_upsert(1, 1, false, false, false);
    e.clip_midi_upsert(1, 1, 0, 120.0, 480, 480.0 * 16.0, 0.0);
    e.note_upsert(1, 1, 0.0, 480.0 * 16.0, 69, 1.0);
    e.device_upsert(1, 1, 2, 0.0, false);
    e.lane_upsert(1, engine::LANE_DEVICE, 1, 6, true, 0.0, 2.0, 0);
    for (i, &(pos, v, hold)) in points.iter().enumerate() {
        e.point_upsert(1 + i as u32, 1, pos, v, hold);
    }
    e.play(0);
    let mut out = Vec::new();
    for _ in 0..blocks {
        e.process(BLOCK);
        out.extend_from_slice(e.output().0);
    }
    out
}

#[test]
fn linear_lane_ramps_per_sample_and_hold_steps_at_the_breakpoint() {
    // Unity reference: a flat lane at 0.5.
    let unity = synth_with_gain_lane(&[(0, 0.5, false)], 3);
    let peak = unity.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    assert!(peak > 0.01);

    // Linear 0 -> 2 over samples 0..256: gain(j) = j / 128.
    let ramp = synth_with_gain_lane(&[(0, 0.0, false), (256, 1.0, false)], 3);
    let mut worst = 0.0f32;
    let mut used = 0;
    for j in 0..256 {
        if unity[j].abs() > 0.2 * peak {
            let gain = ramp[j] / unity[j];
            worst = worst.max((gain - (j as f32 + 1.0) / 128.0).abs());
            used += 1;
        }
    }
    println!("linear lane: {used} samples, worst gain error {worst:.4} (a 32-step staircase would be about 0.25)");
    assert!(used > 20 && worst < 0.03, "worst {worst}");

    // Hold: 1.0 until sample 100, then 2.0, with no ramp across the corner.
    let held = synth_with_gain_lane(&[(0, 0.5, true), (100, 1.0, false)], 3);
    for j in 0..200 {
        if unity[j].abs() > 0.2 * peak {
            let gain = held[j] / unity[j];
            let want = if j < 100 { 1.0 } else { 2.0 };
            assert!((gain - want).abs() < 1e-3, "j {j}: gain {gain}");
        }
    }
}
