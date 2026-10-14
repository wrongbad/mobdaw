//! Wasm micro-benchmarks for `dsp` blocks and `engine` scenes, driven by `engine/bench/run.mjs`
//! (`npm run bench`). Every block export takes a block count and does its own setup, so the harness
//! times f(B) - f(0). Engine scenes are built by `scene` (untimed) and advanced by `run`.
//! Public APIs only. Exports return a checksum so the optimizer cannot drop the work.
#![allow(static_mut_refs)]

use dsp::*;
use engine::clip::AudioClip;
use engine::device::{KIND_COMPRESSOR, KIND_DELAY, KIND_FILTER, KIND_REVERB, KIND_TREMOLO};
use engine::engine::Engine;
use engine::source::Source;

const SR: f32 = 48000.0;
const N: usize = 32;

fn noise(seed: &mut u32) -> f32 {
    let mut x = *seed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *seed = x;
    x as f32 * (2.0 / u32::MAX as f32) - 1.0
}
fn fill(l: &mut [f32], r: &mut [f32], s: &mut u32) {
    for i in 0..l.len() {
        l[i] = noise(s) * 0.5;
        r[i] = noise(s) * 0.5;
    }
}
fn sum(l: &[f32], r: &[f32]) -> f32 {
    l.iter().chain(r).sum()
}
fn tape() -> Vec<f32> {
    let mut s = 1u32;
    (0..1 << 16).map(|_| noise(&mut s)).collect()
}

// ---- devices / dsp blocks (N-sample blocks of stereo noise) ------------------------------------
#[no_mangle]
pub extern "C" fn svf(blocks: u32) -> f32 {
    let (mut a, mut b) = (Svf::new(), Svf::new());
    let (mut l, mut r, mut s, mut acc) = ([0.0f32; N], [0.0f32; N], 1u32, 0.0);
    for _ in 0..blocks {
        fill(&mut l, &mut r, &mut s);
        a.set_hz(1200.0, 0.7, SR);
        b.set_hz(1200.0, 0.7, SR);
        for x in l.iter_mut() {
            *x = a.process(*x).lp();
        }
        for x in r.iter_mut() {
            *x = b.process(*x).lp();
        }
        acc += sum(&l, &r);
    }
    acc
}
#[no_mangle]
pub extern "C" fn reverb(blocks: u32) -> f32 {
    let mut rv = Reverb::new(SR);
    let (mut l, mut r, mut s, mut acc) = ([0.0f32; N], [0.0f32; N], 1u32, 0.0);
    for _ in 0..blocks {
        fill(&mut l, &mut r, &mut s);
        rv.process(&mut l, &mut r, 0.6, 0.5, 20.0, 0.3);
        acc += sum(&l, &r);
    }
    acc
}
#[no_mangle]
pub extern "C" fn compressor(blocks: u32) -> f32 {
    let mut c = Compressor::new();
    let p = CompParams::default();
    let (mut l, mut r, mut s, mut acc) = ([0.0f32; N], [0.0f32; N], 1u32, 0.0);
    for _ in 0..blocks {
        fill(&mut l, &mut r, &mut s);
        c.process(&mut l, &mut r, &p, SR);
        acc += sum(&l, &r);
    }
    acc
}
#[no_mangle]
pub extern "C" fn tremolo(blocks: u32) -> f32 {
    let mut t = Tremolo::new();
    let p = TremParams { spread: 0.5, ..Default::default() };
    let (mut l, mut r, mut s, mut acc) = ([0.0f32; N], [0.0f32; N], 1u32, 0.0);
    for _ in 0..blocks {
        fill(&mut l, &mut r, &mut s);
        t.process(&mut l, &mut r, &p, SR);
        acc += sum(&l, &r);
    }
    acc
}
/// Tape delay; `warble_x100` is the warble amount times 100 (25 is the default).
#[no_mangle]
pub extern "C" fn delay(blocks: u32, warble_x100: u32) -> f32 {
    let mut d = TapeDelay::new(SR);
    let p = DelayParams { warble: warble_x100 as f32 / 100.0, ..Default::default() };
    let (mut l, mut r, mut s, mut acc) = ([0.0f32; N], [0.0f32; N], 1u32, 0.0);
    for _ in 0..blocks {
        fill(&mut l, &mut r, &mut s);
        d.process(&mut l, &mut r, &p);
        acc += sum(&l, &r);
    }
    acc
}
/// `voices` held notes, rendered in N-sample blocks.
#[no_mangle]
pub extern "C" fn synth(blocks: u32, voices: u32) -> f32 {
    let mut sy = Synth::new(SR);
    for v in 0..voices {
        sy.note_on(48 + v, 0.8, i64::MAX);
    }
    let (mut m, mut acc) = ([0.0f32; N], 0.0);
    for _ in 0..blocks {
        m.fill(0.0);
        sy.render_add(&mut m);
        acc += m.iter().sum::<f32>();
    }
    acc
}
/// Resampler alone, reading a noise tape at `speed_x100 / 100` times.
#[no_mangle]
pub extern "C" fn resampler(blocks: u32, speed_x100: u32) -> f32 {
    let tape = tape();
    let mut rs = Resampler::new();
    rs.restart(0);
    let speed = speed_x100 as f64 / 100.0;
    let scale = (1.0 / speed).min(1.0) as f32;
    let (mut pos, mut acc) = (0.0f64, 0.0f32);
    let mut input = |i: i64| {
        let v = tape[(i as usize) & 0xffff];
        (v, v)
    };
    for _ in 0..blocks {
        for _ in 0..N {
            pos += speed;
            let (a, b) = rs.advance(&mut input, pos, scale);
            acc += a + b;
        }
    }
    acc
}
/// One looper voice at speed 1 with the given warble times 100.
#[no_mangle]
pub extern "C" fn looper(blocks: u32, warble_x100: u32) -> f32 {
    let tape = tape();
    let p = LoopParams { speed: 1.0, start: 1000, length: 30000, warble: warble_x100 as f64 / 100.0, sample_rate: SR as f64 };
    let mut v = LoopVoice::new();
    let mut input = |i: i64| {
        let x = tape[(i as usize) & 0xffff];
        (x, x)
    };
    let (mut l, mut r, mut acc) = ([0.0f32; N], [0.0f32; N], 0.0);
    for b in 0..blocks {
        l.fill(0.0);
        r.fill(0.0);
        v.render_add(&p, 0, (b as i64) * N as i64, &mut input, &mut l, &mut r);
        acc += sum(&l, &r);
    }
    acc
}
/// One audio clip playing (20 s source, fades, no loop), rendered in 128-frame blocks.
#[no_mangle]
pub extern "C" fn clip(blocks: u32) -> f32 {
    let len = 48000 * 20;
    let mut src = Source::new(2, len);
    {
        let mut s = 1u32;
        for v in src.data_mut().iter_mut() {
            *v = noise(&mut s) * 0.1;
        }
    }
    src.set_ready();
    let c = AudioClip {
        track: 1,
        source: 1,
        start: 0,
        length: len as i64,
        source_offset: 0,
        gain: 0.8,
        fade_in: 480.0,
        fade_out: 480.0,
        shape: FadeShape::EqualPower,
        loop_length: 0,
        loop_phase: 0,
        seam_max: 480,
    };
    let (mut l, mut r, mut acc) = ([0.0f32; 128], [0.0f32; 128], 0.0);
    for b in 0..blocks as i64 {
        l.fill(0.0);
        r.fill(0.0);
        c.render_add(&src, (b * 128) % (c.length - 128), &mut l, &mut r);
        acc += l[5] + r[7];
    }
    acc
}

// ---- engine scene -------------------------------------------------------------------------------
static mut ENG: Option<Engine> = None;
const SCENE_LEN: usize = 48000 * 30;

/// Builds a fresh engine and starts playback from 0 (call before every timed `run`, so clips are
/// sounding). `clips_per_track` 1 is one 30 s clip; more are 1 s clips spaced 1 s apart.
/// `device_mask` bit i enables device kinds [filter, compressor, tremolo, reverb, delay] (31 is all five).
#[no_mangle]
pub extern "C" fn scene(tracks: u32, clips_per_track: u32, device_mask: u32) {
    let mut e = Engine::new(SR);
    let src: Vec<f32> = {
        let mut s = 1u32;
        (0..SCENE_LEN).map(|_| noise(&mut s) * 0.1).collect()
    };
    e.load_source(1, &[&src, &src]);
    let (mut ch, mut dh) = (100u32, 10000u32);
    for t in 0..tracks {
        e.track_upsert(t + 1, 0, false, false, false);
        for c in 0..clips_per_track {
            let start = c as i64 * 48000;
            let clen = if clips_per_track == 1 { SCENE_LEN as i64 } else { 48000 };
            e.clip_audio_upsert(ch, t + 1, 1, start, clen, 0, 1.0, 0.0, 0.0, 0, 0, 0);
            ch += 1;
        }
        for (d, kind) in [KIND_FILTER, KIND_COMPRESSOR, KIND_TREMOLO, KIND_REVERB, KIND_DELAY].into_iter().enumerate() {
            if device_mask & (1 << d) != 0 {
                e.device_upsert(dh, t + 1, kind, d as f64, false);
                dh += 1;
            }
        }
    }
    e.play(0);
    unsafe { ENG = Some(e) };
}
/// Renders `blocks` 128-frame blocks of the current scene.
#[no_mangle]
pub extern "C" fn run(blocks: u32) -> f32 {
    let e = unsafe { ENG.as_mut().expect("call scene() first") };
    let mut acc = 0.0;
    for _ in 0..blocks {
        e.process(128);
        let (l, _) = e.output();
        acc += l[0];
    }
    acc
}
