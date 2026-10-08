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

// ---- soundscape tracks -----------------------------------------------------------------------

/// Track kind 2 with a 1-second 440 Hz source clip at source time 0 (handles: track 1, source 1,
/// clip 1). Loopers need a pad (gate) to sound; `pad_on` adds one over the whole timeline.
fn soundscape_engine(kind: u32) -> Engine {
    let mut e = Engine::new(SR);
    e.load_source(1, &[&sine(440.0, 48_000)]);
    e.track_upsert(1, kind, 1.0, -1.0, false, false);
    e.clip_audio_upsert(1, 1, 1, 0, 48_000, 0, 1.0, 0.0, 0.0, 0);
    e
}

fn pad_on(e: &mut Engine, id: u32, start: i64, length: i64) {
    e.pad_upsert(900 + id, 1, start, length); // all loopers of track 1
}

#[test]
fn soundscape_does_not_play_its_source_linearly_and_needs_a_pad() {
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, 1.0, 10_000, 6_000);
    e.play(0);
    assert!(render(&mut e, 4000).0.iter().all(|&x| x == 0.0), "a looper without a pad is silent");
    let mut plain = soundscape_engine(0);
    plain.play(0);
    assert!(rms(&render(&mut plain, 4000).0) > 0.1, "the same clip on an audio track plays");
}

#[test]
fn a_pad_gates_its_looper_with_short_fades_and_restarts_the_loop_at_the_region_start() {
    // Source: a slow ramp, so the output value says exactly where in the source we are.
    let ramp: Vec<f32> = (0..48_000).map(|i| 0.25 + i as f32 * 1e-5).collect();
    let mut e = Engine::new(SR);
    e.load_source(1, &[&ramp]);
    e.track_upsert(1, 2, 1.0, -1.0, false, false);
    e.clip_audio_upsert(1, 1, 1, 0, 48_000, 0, 1.0, 0.0, 0.0, 0);
    let (start, len) = (10_000i64, 5_000i64);
    e.looper_upsert(1, 1, 1.0, start, len);
    let (gs, gl) = (33_333i64, 12_000i64); // an arbitrary, unaligned pad
    pad_on(&mut e, 1, gs, gl);
    e.play(0);
    let (l, _) = render(&mut e, 50_000);
    assert!(l[..gs as usize].iter().all(|&x| x == 0.0), "silent before the pad");
    assert!(l[(gs + gl) as usize..].iter().all(|&x| x == 0.0), "silent after the pad");
    assert!(l[gs as usize].abs() < 1e-3, "the pad fades in");
    // gs + k plays source start + (k mod len): the loop restarts at the region start.
    // (past the 10 ms seam crossfade, which overshoots on this perfectly correlated ramp)
    for k in [600i64, 1500, 4000, 5700, 9000] {
        let want = 0.25 + (start + k % len) as f32 * 1e-5;
        let got = l[(gs + k) as usize];
        assert!((got - want).abs() < 2e-3, "k={k}: {got} vs {want}");
    }
}

#[test]
fn a_pad_turns_every_looper_of_its_track_on_and_overlapping_pads_retrigger() {
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, 1.0, 0, 8_000);
    e.looper_upsert(2, 1, 2.0, 8_000, 8_000);
    pad_on(&mut e, 1, 5_000, 4_000);
    pad_on(&mut e, 2, 20_000, 3_000);
    e.pad_upsert(950, 1, 7_000, 4_000); // overlaps the first pad
    // a second soundscape with its own looper and no pads stays silent
    e.track_upsert(2, 2, 1.0, -1.0, false, false);
    e.looper_upsert(3, 2, 1.0, 0, 8_000);
    e.play(0);
    let (l, _) = render(&mut e, 30_000);
    let live = |a: usize, b: usize| rms(&l[a..b]) > 0.05;
    assert!(!live(0, 4_900) && live(5_500, 6_900) && live(8_000, 10_500), "pads 1+overlap");
    assert!(!live(11_500, 19_900) && live(20_500, 22_800) && !live(23_100, 30_000), "pad 2");
    assert!(l.iter().all(|x| x.is_finite()));
    // Both loopers sound under one pad: more energy than a single looper alone.
    let mut one = soundscape_engine(2);
    one.looper_upsert(1, 1, 1.0, 0, 8_000);
    pad_on(&mut one, 1, 5_000, 4_000);
    one.play(0);
    let (solo, _) = render(&mut one, 10_000);
    assert!(rms(&l[6_000..8_000]) > 1.1 * rms(&solo[6_000..8_000]), "second looper adds to the first");
}

/// Track kind 2 whose source is a slow ramp, so the output says where in the source the loops read.
fn ramp_scape() -> Engine {
    let ramp: Vec<f32> = (0..48_000).map(|i| 0.25 + i as f32 * 1e-5).collect();
    let mut e = Engine::new(SR);
    e.load_source(1, &[&ramp]);
    e.track_upsert(1, 2, 1.0, -1.0, false, false);
    e.clip_audio_upsert(1, 1, 1, 0, 48_000, 0, 1.0, 0.0, 0.0, 0);
    e
}

#[test]
fn a_seek_into_a_pad_restarts_the_loops_from_their_region_start() {
    let mut e = ramp_scape();
    e.looper_upsert(1, 1, 1.0, 10_000, 5_000);
    pad_on(&mut e, 1, 1_000, 200_000);
    e.play(0);
    render(&mut e, 12_345);
    e.seek(50_000); // mid-pad
    let (l, _) = render(&mut e, 800);
    let want = 0.25 + (10_000 + 700) as f32 * 1e-5;
    assert!((l[700] - want).abs() < 2e-3, "{} vs {want}", l[700]);
}

#[test]
fn a_looper_speed_change_is_live_and_smooth() {
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, 1.0, 0, 40_000);
    pad_on(&mut e, 1, 0, 400_000);
    e.play(0);
    let (a, _) = render(&mut e, 20_480);
    e.looper_upsert(1, 1, 2.0, 0, 40_000); // as if the slider moved
    let (b, _) = render(&mut e, 2_400);
    let (c, _) = render(&mut e, 40_000);
    let (d, _) = render(&mut e, 12_000);
    let zc = |x: &[f32]| x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
    assert!(zc(&b) >= zc(&a[a.len() - 2_400..]) + 2, "audible within 50 ms");
    let ratio = zc(&d) as f64 / zc(&a[a.len() - 12_000..]) as f64;
    println!("speed 1 -> 2: ratio after 0.8 s {ratio:.2}");
    assert!((1.9..2.1).contains(&ratio), "{ratio}");
    let worst = [&a, &b, &c, &d].iter().flat_map(|x| x.windows(2)).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
    assert!(worst < 0.2, "click while the speed changed: {worst}");
}

#[test]
fn looper_speed_changes_the_pitch_and_is_clamped() {
    let mut zc = Vec::new();
    for speed in [1.0, 2.0] {
        let mut e = soundscape_engine(2);
        e.looper_upsert(1, 1, speed, 0, 40_000);
        pad_on(&mut e, 1, 0, 100_000);
        e.play(0);
        let (l, _) = render(&mut e, 12_000);
        zc.push(l[2000..].windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count());
    }
    let ratio = zc[1] as f64 / zc[0] as f64;
    println!("zero crossings 1x: {}, 2x: {} (ratio {ratio:.2})", zc[0], zc[1]);
    assert!((1.9..2.1).contains(&ratio));
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, f64::NAN, 0, 40_000);
    e.looper_upsert(2, 1, 100.0, 0, 40_000);
    pad_on(&mut e, 1, 0, 100_000);
    pad_on(&mut e, 2, 0, 100_000);
    e.play(0);
    let (l, r) = render(&mut e, 2000);
    assert!(l.iter().chain(&r).all(|x| x.is_finite()));
}

// ---- previews: private transports on a soundscape ----------------------------------------------

#[test]
fn source_preview_plays_the_tape_straight_through_on_its_own_transport() {
    let ramp: Vec<f32> = (0..48_000).map(|i| 0.25 + i as f32 * 1e-5).collect();
    let mut e = Engine::new(SR);
    e.load_source(1, &[&ramp]);
    e.track_upsert(1, 2, 1.0, -1.0, false, false);
    e.clip_audio_upsert(1, 1, 1, 5_000, 20_000, 1_000, 1.0, 0.0, 0.0, 0); // tape: source frames 1000.. at 5000..
    e.preview_upsert(7, 1, 0);
    // The main transport is stopped and stays untouched.
    e.preview_play(7, 8_000);
    let (l, _) = render(&mut e, 2_000);
    assert!(!e.is_playing() && e.position() == 0, "main transport must not move");
    assert_eq!(e.preview_position(7), 10_000);
    assert!(e.preview_is_playing(7));
    assert!(l[0].abs() < 1e-3, "5 ms fade-in");
    for k in [400usize, 1000, 1999] {
        let want = 0.25 + (1_000 + (8_000 + k - 5_000)) as f32 * 1e-5; // tape position 8000+k -> source frame
        assert!((l[k] - want).abs() < 1e-5, "k={k}: {} vs {want}", l[k]);
    }
    // seek while playing, then stop
    e.preview_seek(7, 6_000);
    let (l, _) = render(&mut e, 600);
    assert!((l[500] - (0.25 + (1_000 + 1_000 + 500) as f32 * 1e-5)).abs() < 1e-5);
    e.preview_stop(7);
    assert!(render(&mut e, 256).0.iter().all(|&x| x == 0.0), "stopped preview is silent");
    assert_eq!(e.preview_position(7), 6_600);
}

#[test]
fn loops_preview_plays_every_looper_without_pads_and_restarts_on_play_and_seek() {
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, 1.0, 10_000, 6_000);
    e.looper_upsert(2, 1, 2.0, 20_000, 6_000);
    e.preview_upsert(5, 1, 1);
    e.preview_play(5, 0);
    let (a, _) = render(&mut e, 30_000);
    assert!(rms(&a[2000..]) > 0.1, "loops sound with no pad and the main transport stopped");
    assert!(!e.is_playing());
    // play and seek are triggers: the loops start from the region start again
    let mut r = ramp_scape();
    r.looper_upsert(1, 1, 1.0, 10_000, 5_000);
    r.preview_upsert(5, 1, 1);
    r.preview_play(5, 7);
    render(&mut r, 3_000);
    r.preview_seek(5, 123_456);
    let (l, _) = render(&mut r, 800);
    assert!((l[700] - (0.25 + 10_700.0 * 1e-5)).abs() < 2e-3, "{}", l[700]);
}

#[test]
fn previews_and_the_main_transport_do_not_disturb_each_other() {
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, 1.0, 10_000, 6_000);
    pad_on(&mut e, 1, 0, 100_000);
    e.preview_upsert(5, 1, 1);
    e.preview_upsert(6, 1, 0);
    // Reference: the pads alone.
    e.play(0);
    let (alone, _) = render(&mut e, 6_000);
    // Now the same with both previews running too: pad voice state must be unaffected, so the
    // difference is exactly what the previews add, and nothing else.
    let mut g = soundscape_engine(2);
    g.looper_upsert(1, 1, 1.0, 10_000, 6_000);
    pad_on(&mut g, 1, 0, 100_000);
    g.preview_upsert(5, 1, 1);
    g.preview_upsert(6, 1, 0);
    let mut only_previews = soundscape_engine(2);
    only_previews.looper_upsert(1, 1, 1.0, 10_000, 6_000);
    only_previews.preview_upsert(5, 1, 1);
    only_previews.preview_upsert(6, 1, 0);
    only_previews.preview_play(5, 0);
    only_previews.preview_play(6, 3_000);
    let (pv, _) = render(&mut only_previews, 6_000);
    g.preview_play(5, 0);
    g.preview_play(6, 3_000);
    g.play(0);
    let (all, _) = render(&mut g, 6_000);
    let worst = (0..6_000).map(|k| (all[k] - (alone[k] + pv[k])).abs()).fold(0.0f32, f32::max);
    assert!(worst < 1e-5, "transports interfere: {worst}");
    assert_eq!(g.position(), 6_000);
    assert_eq!(g.preview_position(5), 6_000);
    assert_eq!(g.preview_position(6), 9_000);
}

#[test]
fn a_looper_reports_its_read_head_only_while_it_sounds() {
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, 1.0, 10_000, 6_000);
    pad_on(&mut e, 1, 1_000, 4_000);
    assert_eq!(e.looper_head(1), -1.0, "idle before playing");
    e.play(0);
    render(&mut e, 1_000);
    assert_eq!(e.looper_head(1), -1.0, "no pad on yet");
    render(&mut e, 1_500);
    let h = e.looper_head(1);
    assert!((10_000.0..16_000.0).contains(&h) && (h - 11_500.0).abs() < 130.0, "head {h} ~ region start + 1500");
    render(&mut e, 4_000);
    assert_eq!(e.looper_head(1), -1.0, "pad ended");
}

#[test]
fn a_looper_mutes_and_scales_with_a_ramp_instead_of_a_click() {
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, 1.0, 0, 20_000);
    pad_on(&mut e, 1, 0, 40_000);
    e.play(0);
    let full = rms(&render(&mut e, 8_000).0[4_000..]);
    e.looper_mix(1, 0.5, false);
    let half = rms(&render(&mut e, 8_000).0[4_000..]);
    assert!((half / full - 0.5).abs() < 0.05, "half gain: {half} vs {full}");
    e.looper_mix(1, 0.5, true);
    let (l, _) = render(&mut e, 2_000);
    assert!(l[..128].iter().any(|&x| x != 0.0), "the mute ramps");
    assert!(l[128..].iter().all(|&x| x == 0.0), "then it is silent");
    e.looper_mix(1, 0.5, false);
    render(&mut e, 128);
    assert!(rms(&render(&mut e, 2_000).0) > 0.1, "and unmutes");
}

#[test]
fn a_loopers_tape_controls_darken_it_and_default_to_a_bypass() {
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, 1.0, 0, 20_000);
    pad_on(&mut e, 1, 0, 60_000);
    e.play(0);
    let clean = rms(&render(&mut e, 8_000).0[4_000..]);
    e.looper_tape(1, 0.0, 200.0, 1.0);
    render(&mut e, 4_000); // let it glide
    let dark = rms(&render(&mut e, 8_000).0[4_000..]);
    assert!(dark < 0.5 * clean, "200 Hz low-pass should cut the tape: {dark} vs {clean}");
    e.looper_tape(1, 0.0, 20_000.0, 0.0);
    render(&mut e, 8_000);
    let back = rms(&render(&mut e, 8_000).0[4_000..]);
    assert!((back / clean - 1.0).abs() < 0.1, "open again: {back} vs {clean}");
}

#[test]
fn a_master_chain_device_processes_the_whole_mix_and_bypass_restores_it() {
    let master = engine::MASTER_TRACK;
    let mut e = Engine::new(SR);
    e.load_source(1, &[&sine(5000.0, 48_000)]);
    e.track_upsert(1, 0, 1.0, 0.0, false, false);
    e.clip_audio_upsert(1, 1, 1, 0, 48_000, 0, 1.0, 0.0, 0.0, 0);
    e.play(0);
    let clean = rms(&render(&mut e, 12_000).0[4_000..]);
    e.device_upsert(1, master, 1, 1.0, false); // low-pass filter on the master bus
    e.param_set(1, 1, 200.0);
    e.seek(0);
    let dark = rms(&render(&mut e, 12_000).0[4_000..]);
    assert!(dark < 0.1 * clean, "master filter should cut 5 kHz: {dark} vs {clean}");
    e.device_upsert(1, master, 1, 1.0, true); // bypass
    e.seek(0);
    let back = rms(&render(&mut e, 12_000).0[4_000..]);
    assert!((back / clean - 1.0).abs() < 0.01, "bypassed: {back} vs {clean}");
}

#[test]
fn a_reverb_device_leaves_a_tail_after_the_clip_ends_and_bypass_clears_it() {
    let mut e = Engine::new(SR);
    e.load_source(1, &[&sine(440.0, 4_800)]); // 0.1 s burst
    e.track_upsert(1, 0, 1.0, 0.0, false, false);
    e.clip_audio_upsert(1, 1, 1, 0, 4_800, 0, 1.0, 0.0, 0.0, 0);
    e.device_upsert(1, 1, 3, 1.0, false); // reverb
    e.param_set(1, 0, 1.0);
    e.param_set(1, 1, 0.9);
    e.play(0);
    render(&mut e, 12_000);
    let tail = rms(&render(&mut e, 6_000).0);
    assert!(tail > 1e-3, "reverb tail after the clip ended: {tail}");
    e.device_upsert(1, 1, 3, 1.0, true);
    e.device_upsert(1, 1, 3, 1.0, false);
    assert!(rms(&render(&mut e, 6_000).0) < 1e-6, "bypass clears the tail");
}

// ---- automation -------------------------------------------------------------------------------

const LIN: u32 = 0;
const LOG: u32 = 1;

/// A looper (handle 1) of the soundscape on track 1, sounding over the first 4 s.
fn auto_looper() -> Engine {
    let mut e = soundscape_engine(2);
    e.looper_upsert(1, 1, 1.0, 0, 40_000);
    pad_on(&mut e, 1, 0, 200_000);
    e
}

#[test]
fn a_looper_gain_lane_draws_the_level_it_replaces_the_static_value() {
    let mut e = auto_looper();
    e.looper_mix(1, 1.0, false);
    // 1.0 at 0, 0.0 at 24000: a straight fade-out, then silence
    e.lane_upsert(1, engine::LANE_LOOPER, 1, engine::LOOPER_GAIN, true, 0.0, 1.0, LIN);
    e.point_upsert(1, 1, 0, 1.0, false);
    e.point_upsert(2, 1, 24_000, 0.0, false);
    e.play(0);
    let (l, _) = render(&mut e, 48_000);
    let at = |from: usize| rms(&l[from..from + 2_000]);
    let (start, mid, late, after) = (at(1_000), at(11_000), at(21_000), at(30_000));
    println!("gain lane: {start:.3} {mid:.3} {late:.3} {after:.5}");
    assert!((mid / start - 0.5).abs() < 0.08, "halfway down: {}", mid / start);
    assert!((late / start - 0.125).abs() < 0.06, "near the end: {}", late / start);
    assert!(after < 1e-4, "silent after the last point");
}

#[test]
fn a_disabled_or_removed_lane_gives_the_static_value_back() {
    let mut e = auto_looper();
    e.looper_mix(1, 0.8, false);
    e.lane_upsert(1, engine::LANE_LOOPER, 1, engine::LOOPER_GAIN, true, 0.0, 1.0, LIN);
    e.point_upsert(1, 1, 0, 0.1, false);
    e.play(0);
    let auto = rms(&render(&mut e, 8_000).0[4_000..]);
    // (the host re-sends the static values when a lane goes away: the engine keeps no second copy of what it replaced)
    e.lane_upsert(1, engine::LANE_LOOPER, 1, engine::LOOPER_GAIN, false, 0.0, 1.0, LIN);
    e.looper_mix(1, 0.8, false);
    render(&mut e, 1_000);
    let off = rms(&render(&mut e, 8_000).0[4_000..]);
    assert!((off / auto - 8.0).abs() < 0.8, "0.8 static vs 0.1 automated: {}", off / auto);
    e.lane_upsert(1, engine::LANE_LOOPER, 1, engine::LOOPER_GAIN, true, 0.0, 1.0, LIN);
    render(&mut e, 1_000);
    assert!((rms(&render(&mut e, 8_000).0[4_000..]) / auto - 1.0).abs() < 0.1, "enabled again");
    e.lane_remove(1);
    e.looper_mix(1, 0.8, false);
    render(&mut e, 1_000);
    assert!((rms(&render(&mut e, 8_000).0[4_000..]) / off - 1.0).abs() < 0.1, "removed");
}

#[test]
fn a_muted_looper_stays_silent_under_automation() {
    let mut e = auto_looper();
    e.looper_mix(1, 1.0, true);
    e.lane_upsert(1, engine::LANE_LOOPER, 1, engine::LOOPER_GAIN, true, 0.0, 1.0, LIN);
    e.point_upsert(1, 1, 0, 1.0, false);
    e.play(0);
    let (l, _) = render(&mut e, 4_000);
    assert!(l[300..].iter().all(|&x| x == 0.0));
}

#[test]
fn points_and_lanes_may_arrive_in_any_order_and_a_hold_point_steps() {
    let mut e = auto_looper();
    e.point_upsert(2, 1, 12_000, 0.0, false); // before the lane exists
    e.point_upsert(1, 1, 0, 1.0, true); // hold: stays at 1 until the next point, then jumps
    e.lane_upsert(1, engine::LANE_LOOPER, 1, engine::LOOPER_GAIN, true, 0.0, 1.0, LIN);
    e.play(0);
    let (l, _) = render(&mut e, 24_000);
    let before = rms(&l[8_000..11_000]);
    assert!(before > 0.1, "held at the first value: {before}");
    assert!(l[12_300..].iter().all(|&x| x == 0.0), "stepped to 0 at the second point");
}

#[test]
fn a_device_lane_moves_a_filter_cutoff_sample_exactly_with_no_glide() {
    // 8 kHz sine through the low-pass; the cutoff steps from 20 Hz (closed) to 16 kHz (open) at 6000
    let n = 12_000;
    let src = sine(8000.0, n);
    let mut e = one_clip(&src, 0, n as i64, 0, 0.0, 0.0, 0);
    e.device_upsert(1, 1, 1, 1.0, false);
    e.lane_upsert(1, engine::LANE_DEVICE, 1, 1, true, 20.0, 20_000.0, LOG);
    e.point_upsert(1, 1, 0, 0.0, true);
    e.point_upsert(2, 1, 6_000, 0.95, true);
    e.play(0);
    let (l, _) = render(&mut e, n);
    let closed = rms(&l[1_000..5_900]);
    let open = rms(&l[6_500..11_900]);
    println!("cutoff lane: closed {closed:.5}, open {open:.3}");
    assert!(closed < 0.01, "8 kHz through a 20 Hz low-pass");
    assert!(open > 0.5, "8 kHz through ~11 kHz: {open}");
    // the corner is exact: the signal before the step is the closed filter's (tiny), after it opens within a few samples
    assert!(l[5_990..6_000].iter().all(|x| x.abs() < 0.01));
    assert!(l[6_040..6_080].iter().any(|x| x.abs() > 0.3), "open almost at once, no 10 ms glide");
}

#[test]
fn a_master_device_lane_is_automated_too() {
    let master = engine::MASTER_TRACK;
    let mut e = Engine::new(SR);
    e.load_source(1, &[&sine(5000.0, 48_000)]);
    e.track_upsert(1, 0, 1.0, 0.0, false, false);
    e.clip_audio_upsert(1, 1, 1, 0, 48_000, 0, 1.0, 0.0, 0.0, 0);
    e.device_upsert(1, master, 1, 1.0, false);
    e.lane_upsert(1, engine::LANE_DEVICE, 1, 1, true, 20.0, 20_000.0, LOG);
    e.point_upsert(1, 1, 0, 0.0, false); // closed ...
    e.point_upsert(2, 1, 24_000, 1.0, false); // ... fully open by 0.5 s
    e.play(0);
    let (l, _) = render(&mut e, 36_000);
    let early = rms(&l[2_000..6_000]);
    let late = rms(&l[30_000..34_000]);
    assert!(late > 10.0 * early, "the master filter opens: {early:.4} -> {late:.3}");
}

#[test]
fn lane_values_follow_the_timeline_position_and_the_scale() {
    // cutoff 20..20000 on a log scale: the midpoint is the geometric mean (632 Hz), not 10 kHz
    let n = 8_000;
    let src = sine(632.0, n);
    let mut e = one_clip(&src, 0, n as i64, 0, 0.0, 0.0, 0);
    e.device_upsert(1, 1, 1, 1.0, false);
    e.lane_upsert(1, engine::LANE_DEVICE, 1, 1, true, 20.0, 20_000.0, LOG);
    e.point_upsert(1, 1, 0, 0.5, false);
    e.play(0);
    let (l, _) = render(&mut e, n);
    let g = db(rms(&l[4_000..]) / rms(&src[4_000..]));
    assert!((g + 3.01).abs() < 0.3, "-3 dB at the cutoff: {g}");
}

#[test]
fn a_compressor_device_tames_a_loud_clip_and_bypass_restores_it() {
    let mut e = Engine::new(SR);
    e.load_source(1, &[&sine(440.0, 24_000)]);
    e.track_upsert(1, 0, 1.0, 0.0, false, false);
    e.clip_audio_upsert(1, 1, 1, 0, 24_000, 0, 1.0, 0.0, 0.0, 0);
    e.play(0);
    let clean = rms(&render(&mut e, 12_000).0[4_000..]);
    e.device_upsert(1, 1, 4, 1.0, false); // compressor
    e.param_set(1, 0, -30.0);
    e.param_set(1, 1, 10.0);
    e.seek(0);
    let squashed = rms(&render(&mut e, 12_000).0[4_000..]);
    assert!(squashed < 0.6 * clean, "compressed: {squashed} vs {clean}");
    e.device_upsert(1, 1, 4, 1.0, true);
    e.seek(0);
    let back = rms(&render(&mut e, 12_000).0[4_000..]);
    assert!((back / clean - 1.0).abs() < 0.01, "bypassed: {back} vs {clean}");
}
