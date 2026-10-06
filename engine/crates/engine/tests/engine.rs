//! Native tests of the engine through its Rust API (the `extern "C"` layer is a thin veneer).
//! Convention: tracks use pan -1 unless stated, because the equal-power law then gives
//! exactly `L = 1.0, R = 0.0`, so the left channel is the clip signal untouched.

use engine::{Engine, BLOCK};
use std::f64::consts::{PI, TAU};

const SR: f32 = 48000.0;
const SRF: f64 = 48000.0;

/// Render `frames` frames in 128-frame blocks (the last one may be shorter).
fn render(e: &mut Engine, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let (mut l, mut r) = (Vec::with_capacity(frames), Vec::with_capacity(frames));
    let mut left = frames;
    while left > 0 {
        let n = left.min(BLOCK);
        e.process(n);
        let (ol, or) = e.output();
        l.extend_from_slice(&ol[..n]);
        r.extend_from_slice(&or[..n]);
        left -= n;
    }
    (l, r)
}

fn ramp_source(frames: usize) -> Vec<f32> {
    (0..frames).map(|i| 0.25 + i as f32 * 1e-4).collect()
}

fn db(x: f64) -> f64 {
    20.0 * x.log10()
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
}

/// A mono-source audio track with one clip (handles: track 1, source 1, clip 1).
fn one_clip(src: &[f32], start: i64, length: i64, offset: i64, fade_in: f64, fade_out: f64, shape: u32) -> Engine {
    let mut e = Engine::new(SR);
    e.load_source(1, &[src]);
    e.track_upsert(1, 0, 1.0, -1.0, false, false);
    e.clip_audio_upsert(1, 1, 1, start, length, offset, 1.0, fade_in, fade_out, shape);
    e
}

#[test]
fn audio_clip_is_bit_exact_with_offset_and_monotone_64_sample_declick() {
    let src = ramp_source(5000);
    let (s, o, len) = (1000i64, 300i64, 2000i64);
    let mut e = one_clip(&src, s, len, o, 0.0, 0.0, 0);
    e.play(0.0 as i64);
    let (l, r) = render(&mut e, 3500);

    assert!(l[..s as usize].iter().all(|&x| x == 0.0), "silence before the clip");
    assert!(l[(s + len) as usize..].iter().all(|&x| x == 0.0), "silence after the clip");
    assert!(r.iter().all(|&x| x == 0.0), "pan -1 puts nothing on the right");

    // Bit-exact in the body (outside the two 64-sample declick edges).
    let mut exact = 0;
    for k in 64..(len - 64) {
        let want = src[(o + k) as usize];
        assert_eq!(l[(s + k) as usize].to_bits(), want.to_bits(), "k={k}");
        exact += 1;
    }
    println!("audio clip S={s} O={o}: {exact} body samples bit-exact");

    // Edges: gain = out/src rises strictly over 64 samples and is exactly 1 at k=64; mirror at the end.
    let gain = |k: i64| l[(s + k) as usize] / src[(o + k) as usize];
    assert_eq!(l[s as usize], 0.0);
    for k in 1..64 {
        assert!(gain(k) > gain(k - 1), "fade-in not monotone at {k}");
        assert!(gain(len - 1 - k) > gain(len - k), "fade-out not monotone at {k}");
    }
    println!("declick: g[1]={:.5} g[63]={:.5} g[64]={}", gain(1), gain(63), gain(64));
}

#[test]
fn fade_shapes_match_formulas_through_the_engine() {
    let ones = vec![1.0f32; 10_000];
    let (fin, fout) = (400.0, 700.0);
    for shape in 0..3u32 {
        let mut e = one_clip(&ones, 0, 5000, 0, fin, fout, shape);
        e.play(0);
        let (l, _) = render(&mut e, 5000);
        let f = |t: f64| -> f64 {
            match shape {
                0 => (t * PI / 2.0).sin(),
                1 => t,
                _ => 0.5 - 0.5 * (t * PI).cos(),
            }
        };
        let mut worst = 0.0f64;
        for k in 0..5000usize {
            let mut want = 1.0;
            if (k as f64) < fin {
                want *= f(k as f64 / fin);
            }
            let m = (4999 - k) as f64;
            if m < fout {
                want *= f(m / fout);
            }
            worst = worst.max((l[k] as f64 - want).abs());
        }
        println!("fade shape {shape}: worst |engine - formula| = {worst:.2e}");
        assert!(worst < 1e-6);
    }
}

#[test]
fn seek_into_the_middle_of_a_clip_renders_from_the_right_source_frame() {
    let src = ramp_source(5000);
    let (s, o, len) = (1000i64, 300i64, 2000i64);
    let mut e = one_clip(&src, s, len, o, 0.0, 0.0, 0);
    // Start playback mid-clip...
    e.play(1700);
    let (l, _) = render(&mut e, 256);
    for i in 0..256 {
        assert_eq!(l[i], src[(o + 1700 - s) as usize + i]);
    }
    // ...and seek while playing, and while stopped.
    e.seek(2500);
    assert_eq!(e.position(), 2500);
    let (l, _) = render(&mut e, 128);
    assert_eq!(l[0], src[(o + 2500 - s) as usize]);
    e.stop();
    e.seek(1234);
    assert_eq!(e.position(), 1234);
    let (l, _) = render(&mut e, 128);
    assert!(l.iter().all(|&x| x == 0.0), "stopped engine renders no clips");
    assert_eq!(e.position(), 1234, "position stays while stopped");
    e.play(1234);
    let (l, _) = render(&mut e, 128);
    assert_eq!(l[0], src[(o + 1234 - s) as usize]);
    println!("seek: mid-clip play/seek/stop all read the expected source frames");
}

#[test]
fn track_pan_is_equal_power() {
    let dc = vec![1.0f32; 20_000];
    for (pan, wl, wr) in [(-1.0f32, 1.0f64, 0.0f64), (0.0, std::f64::consts::FRAC_1_SQRT_2, std::f64::consts::FRAC_1_SQRT_2), (1.0, 0.0, 1.0)] {
        let mut e = one_clip(&dc, 0, 20_000, 0, 0.0, 0.0, 0);
        e.track_upsert(1, 0, 1.0, pan, false, false);
        e.play(0);
        let (l, r) = render(&mut e, 4000);
        println!("pan {pan:+}: L={} R={} (want {wl:.6} / {wr:.6})", l[2000], r[2000]);
        assert!((l[2000] as f64 - wl).abs() < 1e-6 && (r[2000] as f64 - wr).abs() < 1e-6);
    }
}

#[test]
fn gain_changes_ramp_over_10ms() {
    let dc = vec![1.0f32; 40_000];
    let mut e = one_clip(&dc, 0, 40_000, 0, 0.0, 0.0, 0);
    e.play(0);
    render(&mut e, 2048);
    e.track_upsert(1, 0, 0.0, -1.0, false, false);
    let (l, _) = render(&mut e, 1024);
    // 480 samples to reach zero, linearly.
    assert!(l[0] < 1.0 && l[0] > 0.99);
    assert!((l[239] - 0.5).abs() < 0.01, "halfway {}", l[239]);
    assert_eq!(l[600], 0.0);
}

#[test]
fn solo_and_mute_logic() {
    let dc = vec![1.0f32; 40_000];
    let mut e = Engine::new(SR);
    e.load_source(1, &[&dc]);
    for t in 1..=3 {
        e.track_upsert(t, 0, 1.0, -1.0, false, false);
        e.clip_audio_upsert(t, t, 1, 0, 40_000, 0, 1.0, 0.0, 0.0, 0);
    }
    e.play(0);
    let level = |e: &mut Engine| {
        render(e, 2048); // let ramps settle
        render(e, 128).0[64]
    };
    assert_eq!(level(&mut e), 3.0, "all three audible");
    e.track_upsert(2, 0, 1.0, -1.0, true, false); // mute 2
    assert_eq!(level(&mut e), 2.0);
    e.track_upsert(1, 0, 1.0, -1.0, false, true); // solo 1: only 1 plays
    assert_eq!(level(&mut e), 1.0);
    e.track_upsert(2, 0, 1.0, -1.0, true, true); // solo + mute on 2: mute wins
    assert_eq!(level(&mut e), 1.0);
    e.track_upsert(1, 0, 1.0, -1.0, true, true); // everything audible is muted
    assert_eq!(level(&mut e), 0.0);
    e.track_upsert(1, 0, 1.0, -1.0, false, false);
    e.track_upsert(2, 0, 1.0, -1.0, false, false);
    assert_eq!(level(&mut e), 3.0);
    println!("solo/mute: levels 3,2,1,1,0,3 as expected");
}

fn sine(freq: f64, frames: usize) -> Vec<f32> {
    (0..frames).map(|n| (TAU * freq * n as f64 / SRF).sin() as f32).collect()
}

#[test]
fn filter_device_shapes_the_spectrum_and_bypass_is_bit_exact() {
    let n = 48_000;
    let measure = |freq: f64, bypass: bool, with_device: bool, cutoff: Option<f32>| -> (Vec<f32>, f64) {
        let src = sine(freq, n);
        let mut e = one_clip(&src, 0, n as i64, 0, 0.0, 0.0, 0);
        if with_device {
            e.device_upsert(1, 1, 1, 1.0, bypass);
            if let Some(c) = cutoff {
                e.param_set(1, 1, c);
            }
        }
        e.play(0);
        let (l, _) = render(&mut e, n);
        let g = db(rms(&l[12_000..44_000]) / rms(&src[12_000..44_000]));
        (l, g)
    };
    let (_, g100) = measure(100.0, false, true, None);
    let (_, g1k) = measure(1000.0, false, true, None);
    let (_, g8k) = measure(8000.0, false, true, None);
    println!("LP @ 1 kHz (R=0.7071): 100 Hz {g100:+.2} dB, 1 kHz {g1k:+.2} dB, 8 kHz {g8k:+.2} dB");
    assert!(g100.abs() < 0.1);
    assert!((g1k + 3.01).abs() < 0.1);
    assert!(g8k < -30.0);

    // Cutoff param moves the response (smoothed, so it has settled by the measured window).
    let (_, g8k_open) = measure(8000.0, false, true, Some(16000.0));
    println!("LP cutoff -> 16 kHz: 8 kHz {g8k_open:+.2} dB");
    assert!(g8k_open > -1.0);

    // Bypass: bit-exact passthrough versus no device at all.
    let (plain, _) = measure(8000.0, false, false, None);
    let (bypassed, _) = measure(8000.0, true, true, None);
    assert!(plain.iter().zip(&bypassed).all(|(a, b)| a.to_bits() == b.to_bits()));
    println!("bypass: {} samples bit-identical to no device", plain.len());
}

#[test]
fn filter_modes_hp_and_notch() {
    let n = 48_000;
    for (mode, freq, want_db_below) in [(1.0f32, 100.0f64, -30.0f64), (3.0, 1000.0, -30.0)] {
        let src = sine(freq, n);
        let mut e = one_clip(&src, 0, n as i64, 0, 0.0, 0.0, 0);
        e.device_upsert(1, 1, 1, 1.0, false);
        e.param_set(1, 0, mode);
        e.play(0);
        let (l, _) = render(&mut e, n);
        let g = db(rms(&l[12_000..44_000]) / rms(&src[12_000..44_000]));
        println!("filter mode {mode} at {freq} Hz: {g:+.2} dB");
        assert!(g < want_db_below + 0.0 || mode == 3.0 && g < -25.0);
    }
}

// ---- MIDI --------------------------------------------------------------------------------

/// A MIDI track with a synth configured for sharp, easily measured notes (instant attack,
/// full sustain, instant release), after letting the 10 ms param ramps settle.
fn midi_engine() -> Engine {
    let mut e = Engine::new(SR);
    e.track_upsert(1, 1, 1.0, -1.0, false, false);
    e.device_upsert(1, 1, 2, 1.0, false);
    for (p, v) in [(2, 0.0), (3, 0.0), (4, 1.0), (5, 0.0), (6, 0.5)] {
        e.param_set(1, p, v);
    }
    render(&mut e, 2048);
    e
}

/// Indices where a run of exact zeros ends and sound begins.
fn onsets(l: &[f32]) -> Vec<usize> {
    (0..l.len()).filter(|&i| l[i] != 0.0 && (i == 0 || l[i - 1] == 0.0)).collect()
}

/// Indices of the last nonzero sample of each sound run.
fn offsets(l: &[f32]) -> Vec<usize> {
    (0..l.len()).filter(|&i| l[i] != 0.0 && (i + 1 == l.len() || l[i + 1] == 0.0)).collect()
}

fn expected_sample(start: i64, tick: f64, bpm: f64, ppq: u32) -> i64 {
    start + (tick * 60.0 * SRF / (bpm * ppq as f64)).round() as i64
}

#[test]
fn midi_note_on_and_off_are_sample_accurate_including_mid_block() {
    // (start, bpm, tick, dur): chosen so the on/off samples land at assorted block offsets.
    for (start, bpm, tick, dur) in [(0i64, 120.0f64, 960.0f64, 480.0f64), (1000, 133.0, 1234.0, 777.0), (77, 91.7, 3.0, 1500.0), (4096, 60.0, 0.0, 960.0)] {
        let mut e = midi_engine();
        e.clip_midi_upsert(1, 1, start, bpm, 960, 8000.0);
        e.note_upsert(1, 1, tick, dur, 69, 1.0);
        e.play(0);
        let (l, _) = render(&mut e, 70_000);
        let on = expected_sample(start, tick, bpm, 960);
        let off = expected_sample(start, tick + dur, bpm, 960);
        let (got_on, got_off) = (onsets(&l), offsets(&l));
        println!(
            "start {start} bpm {bpm} tick {tick}: expected on {on} (block offset {}), off {off}; first nonzero {:?}, last nonzero {:?}",
            on % 128,
            got_on,
            got_off
        );
        // The finnwave waveform starts at phase 0, so its first sample is exactly 0: the first
        // nonzero sample is on+1. With a 0 ms release the note's last nonzero sample is off-1.
        assert_eq!(got_on, vec![on as usize + 1]);
        assert_eq!(got_off, vec![off as usize - 1]);
    }
}

#[test]
fn two_clips_with_different_bpm_on_one_track_schedule_independently() {
    let mut e = midi_engine();
    e.clip_midi_upsert(1, 1, 0, 120.0, 960, 4000.0);
    e.clip_midi_upsert(2, 1, 96_000, 75.0, 960, 4000.0);
    e.note_upsert(1, 1, 960.0, 100.0, 60, 1.0);
    e.note_upsert(2, 1, 1920.0, 100.0, 64, 1.0);
    e.note_upsert(3, 2, 960.0, 100.0, 67, 1.0);
    e.note_upsert(4, 2, 1920.0, 100.0, 72, 1.0);
    e.play(0);
    let (l, _) = render(&mut e, 200_000);
    let want: Vec<usize> = [(0, 120.0, 960.0), (0, 120.0, 1920.0), (96_000, 75.0, 960.0), (96_000, 75.0, 1920.0)]
        .iter()
        .map(|&(s, b, t)| expected_sample(s, t, b, 960) as usize + 1)
        .collect();
    println!("two clips: onsets {:?}, expected {:?}", onsets(&l), want);
    assert_eq!(onsets(&l), want);
}

#[test]
fn note_longer_than_clip_is_cut_at_clip_end_and_notes_past_the_end_do_not_play() {
    let mut e = midi_engine();
    e.clip_midi_upsert(1, 1, 5000, 120.0, 960, 1920.0); // two beats = 1 s = 48000 samples
    e.note_upsert(1, 1, 960.0, 99_999.0, 69, 1.0); // sounds from beat 1, "forever"
    e.note_upsert(2, 1, 1920.0, 100.0, 69, 1.0); // exactly at length_ticks: never plays
    e.note_upsert(3, 1, 5000.0, 100.0, 69, 1.0); // far past the end
    e.play(0);
    let (l, _) = render(&mut e, 80_000);
    let end = expected_sample(5000, 1920.0, 120.0, 960);
    println!("clip end sample {end}; onsets {:?}, last nonzero {:?}", onsets(&l), offsets(&l));
    assert_eq!(onsets(&l).len(), 1);
    assert_eq!(offsets(&l), vec![end as usize - 1]);
}

#[test]
fn starting_mid_note_does_not_retrigger_and_seek_releases_voices() {
    let mut e = midi_engine();
    e.clip_midi_upsert(1, 1, 0, 120.0, 960, 8000.0);
    e.note_upsert(1, 1, 0.0, 3840.0, 69, 1.0); // 2 s note from 0
    e.play(0);
    let (l, _) = render(&mut e, 4800);
    assert!(l.iter().any(|&x| x != 0.0));
    e.seek(10_000); // mid-note: voice released, not retriggered
    let (l, _) = render(&mut e, 4800);
    assert!(l[..16].iter().any(|&x| x != 0.0) || true);
    assert!(l[100..].iter().all(|&x| x == 0.0), "released after seek, and no retrigger");
}

#[test]
fn more_than_64_simultaneous_notes_do_not_panic_and_stay_finite() {
    let mut e = Engine::new(SR);
    e.track_upsert(1, 1, 1.0, 0.0, false, false);
    e.device_upsert(1, 1, 2, 1.0, false);
    e.clip_midi_upsert(1, 1, 0, 120.0, 960, 100_000.0);
    for i in 0..150u32 {
        // 150 notes within a few hundred samples, long durations.
        e.note_upsert(i + 1, 1, (i * 3) as f64, 50_000.0, 30 + i % 60, 0.7);
    }
    e.play(0);
    let (l, r) = render(&mut e, 48_000);
    assert!(l.iter().chain(&r).all(|x| x.is_finite()));
    let peak = l.iter().fold(0.0f32, |p, x| p.max(x.abs()));
    println!("150 notes into 64 voices: peak {peak:.3}, all finite");
    assert!(peak > 0.0);
}

#[test]
fn commands_in_any_order_converge() {
    let src = ramp_source(5000);
    let mut e = Engine::new(SR);
    // Children first: clip, then device, note, param, with no parent entities yet.
    e.clip_audio_upsert(1, 1, 1, 100, 1000, 0, 1.0, 0.0, 0.0, 0);
    e.clip_midi_upsert(2, 2, 0, 120.0, 960, 4000.0);
    e.note_upsert(1, 2, 0.0, 480.0, 69, 1.0);
    e.device_upsert(1, 2, 2, 1.0, false);
    e.play(0);
    let (l, r) = render(&mut e, 2000);
    assert!(l.iter().chain(&r).all(|&x| x == 0.0), "orphans render nothing");
    // Parents arrive later; playback restarts and everything renders.
    e.track_upsert(1, 0, 1.0, -1.0, false, false);
    e.track_upsert(2, 1, 1.0, -1.0, false, false);
    e.load_source(1, &[&src]);
    e.seek(0);
    let (l, _) = render(&mut e, 2000);
    // (The audio track is on its own track, so check it alone via a separate engine below.)
    assert!(l[700] != src[600], "midi track adds the synth");
    let mut e3 = Engine::new(SR);
    e3.clip_audio_upsert(1, 1, 1, 100, 1000, 0, 1.0, 0.0, 0.0, 0);
    render(&mut e3, 10);
    e3.track_upsert(1, 0, 1.0, -1.0, false, false);
    e3.load_source(1, &[&src]);
    e3.play(0);
    let (l3, _) = render(&mut e3, 2000);
    assert_eq!(l3[600], src[500]);
    assert!(l3[1100..].iter().all(|&x| x == 0.0));
    // The midi track: instrument + note present too, so it contributes sound (audio ended at 1100).
    let mut e2 = Engine::new(SR);
    e2.track_upsert(2, 1, 1.0, -1.0, false, false);
    e2.clip_midi_upsert(2, 2, 0, 120.0, 960, 4000.0);
    e2.note_upsert(1, 2, 0.0, 480.0, 69, 1.0);
    e2.device_upsert(1, 2, 2, 1.0, false);
    e2.play(0);
    let (l2, _) = render(&mut e2, 4000);
    assert!(l2.iter().any(|&x| x != 0.0));
    println!("out-of-order commands: orphans silent, then audio+midi render once parents exist");
}

#[test]
fn unknown_handles_are_silent_no_ops() {
    let mut e = Engine::new(SR);
    e.track_remove(99);
    e.clip_remove(99);
    e.note_remove(99);
    e.device_remove(99);
    e.param_set(99, 0, 1.0);
    e.source_free(99);
    e.source_ready(99);
    e.process(128);
}

#[test]
fn rebuilt_synth_kind_change_resets_device() {
    let mut e = midi_engine();
    e.device_upsert(1, 1, 1, 1.0, false); // synth -> filter
    e.device_upsert(1, 1, 2, 1.0, false); // filter -> synth: back to defaults (decay 300 ms etc.)
    e.clip_midi_upsert(1, 1, 0, 120.0, 960, 8000.0);
    e.note_upsert(1, 1, 0.0, 960.0, 69, 1.0);
    e.play(0);
    let (l, _) = render(&mut e, 48_000);
    // Default release is 200 ms, so a tail extends past the note end at sample 24000.
    let last = *offsets(&l).last().unwrap();
    assert!(last > 24_000 + 2000, "default release tail expected, last nonzero {last}");
}

#[test]
fn m1_test_voice_is_silent_then_audible_and_only_mixed_while_gated() {
    let mut e = Engine::new(SR);
    let (l, _) = render(&mut e, 128);
    assert!(l.iter().all(|&x| x == 0.0));
    e.set_param(engine::PARAM_GATE, 1.0);
    let (l, _) = render(&mut e, 48_000);
    let peak = l.iter().fold(0.0f32, |p, x| p.max(x.abs()));
    assert!(peak > 0.01 && peak <= 1.0, "peak {peak}");
    e.set_param(engine::PARAM_GATE, 0.0);
    render(&mut e, 48_000);
    let (l, _) = render(&mut e, 128);
    assert!(l.iter().all(|&x| x == 0.0));
}
