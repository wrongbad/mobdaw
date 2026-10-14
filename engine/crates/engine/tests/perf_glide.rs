//! Knob glides keep their 32-frame control steps even though effects run over whole blocks.

use engine::device::{Device, KIND_COMPRESSOR, KIND_REVERB, KIND_TREMOLO};
use engine::{Engine, BLOCK};

/// A 10 ms knob glide is applied in control segments of at most 32 frames: the engine matches a
/// device driven in 32-frame chunks, bit for bit.
#[test]
fn knob_glide_steps_at_32_frames() {
    let mut s = 7u64;
    let src: Vec<f32> = (0..200_000)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            ((s >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 0.5
        })
        .collect();
    for (kind, param, value) in [(KIND_REVERB, 0u32, 0.9f32), (KIND_COMPRESSOR, 4, 12.0), (KIND_TREMOLO, 1, 0.9)] {
        let mut e = Engine::new(48000.0);
        e.load_source(1, &[&src]);
        e.track_upsert(1, 0, false, false, false);
        // Starts before 0 and runs on, so there are no clip fades in the rendered range.
        e.clip_audio_upsert(1, 1, 1, -100_000, 300_000, 0, 1.0, 0.0, 0.0, 0, 0, 0);
        e.device_upsert(1, 1, kind, 0.0, false);
        e.play(0);
        let mut d = Device::new(1, kind, 0.0, false, 48000.0);
        let mut pos = 100_000usize;
        for step in 0..11 {
            if step == 3 {
                e.param_set(1, param, value);
                d.set_param(param, value);
            }
            e.process(BLOCK);
            let mut l = src[pos..pos + BLOCK].to_vec();
            let mut r = l.clone();
            for (lc, rc) in l.chunks_mut(32).zip(r.chunks_mut(32)) {
                d.process(lc, rc, 48000.0);
            }
            let out = e.output().0;
            assert!(out.iter().zip(&l).all(|(a, b)| a.to_bits() == b.to_bits()), "kind {kind} block {step}");
            pos += BLOCK;
        }
    }
}
