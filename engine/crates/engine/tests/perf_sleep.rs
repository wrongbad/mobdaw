//! Sleep: a silent track's provably silent chain is skipped without changing the rendered audio.

use engine::device::{KIND_COMPRESSOR, KIND_DELAY, KIND_FILTER, KIND_REVERB, KIND_TREMOLO};
use engine::{Engine, BLOCK};

const TOTAL: usize = 700_000;

/// Noise bursts at 0..20000 and 400000..420000, silence elsewhere.
fn source() -> Vec<f32> {
    let mut s = 11u64;
    (0..TOTAL)
        .map(|i| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            if i < 20_000 || (400_000..420_000).contains(&i) {
                ((s >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 0.6
            } else {
                0.0
            }
        })
        .collect()
}

fn render(kinds: &[(u32, &[(u32, f32)])], sleep: bool) -> (Vec<f32>, u64) {
    let src = source();
    let mut e = Engine::new(48000.0);
    e.set_sleep(sleep);
    e.load_source(1, &[&src]);
    e.track_upsert(1, 0, false, false, false);
    e.clip_audio_upsert(1, 1, 1, 0, TOTAL as i64, 0, 1.0, 0.0, 0.0, 0, 0, 0);
    for (i, (kind, params)) in kinds.iter().enumerate() {
        e.device_upsert(i as u32 + 1, 1, *kind, i as f64, false);
        for &(p, v) in params.iter() {
            e.param_set(i as u32 + 1, p, v);
        }
    }
    e.play(0);
    let mut out = Vec::new();
    for _ in 0..TOTAL / BLOCK {
        e.process(BLOCK);
        out.extend_from_slice(e.output().0);
    }
    (out, e.sleep_skips())
}

#[test]
fn filter_compressor_tremolo_sleep_is_bit_identical() {
    let chain: &[(u32, &[(u32, f32)])] = &[(KIND_FILTER, &[]), (KIND_COMPRESSOR, &[]), (KIND_TREMOLO, &[])];
    let (a, skips) = render(chain, true);
    let (b, _) = render(chain, false);
    assert!(skips > 1000, "slept {skips} blocks");
    assert!(a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()));
    assert!(a[400_000..].iter().any(|x| x.abs() > 0.01), "second burst is heard");
}

#[test]
fn reverb_and_delay_tails_are_not_cut_early() {
    // Alone, not chained: a downstream device only sleeps once the one before it hands it exact zeros.
    let reverb: &[(u32, &[(u32, f32)])] = &[(KIND_REVERB, &[(1, 0.5)])];
    let delay: &[(u32, &[(u32, f32)])] = &[(KIND_DELAY, &[(1, 100.0), (2, 0.1), (3, 0.0)])];
    for chain in [reverb, delay] {
        let (a, skips) = render(chain, true);
        let (b, _) = render(chain, false);
        assert!(skips > 100, "slept {skips} blocks");
        let worst = a.iter().zip(&b).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        assert!(worst < 1e-5, "sleep changed the output by {worst}");
        // The tail is audible after the burst ends.
        assert!(a[30_000..40_000].iter().any(|x| x.abs() > 1e-4));
    }
}
