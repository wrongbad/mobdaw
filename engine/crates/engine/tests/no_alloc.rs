//! `engine_process` (and the transport, note and parameter calls) must never allocate.
//! A counting global allocator wraps the system allocator; the count is per thread, so other
//! test threads cannot disturb it. This file holds a single test for the same reason.

use engine::Engine;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    static COUNT: Cell<usize> = const { Cell::new(0) };
}

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if ARMED.with(|a| a.get()) {
            COUNT.with(|c| c.set(c.get() + 1));
        }
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if ARMED.with(|a| a.get()) {
            COUNT.with(|c| c.set(c.get() + 1));
        }
        System.realloc(p, l, n)
    }
}

#[global_allocator]
static A: Counting = Counting;

#[test]
fn process_never_allocates_across_a_busy_scene() {
    const SR: f32 = 48000.0;
    let mut e = Engine::new(SR);

    // ---- setup (allocation allowed) ----
    let sine: Vec<f32> = (0..96_000).map(|n| (n as f32 * 0.05).sin()).collect();
    e.load_source(1, &[&sine, &sine]);
    for t in 1..=8u32 {
        e.track_upsert(t, 0, 0.8, (t as f32 - 4.0) / 4.0, false, false);
        e.device_upsert(100 + t, t, 1, 1.0, false);
        e.device_upsert(200 + t, t, 1, 2.0, t % 2 == 0);
        e.device_upsert(1200 + t, t, 6, 3.0, false); // tape delay
        for c in 0..6u32 {
            // overlapping clips with fades of every shape
            let h = t * 10 + c;
            e.clip_audio_upsert(h, t, 1, (c * 7000) as i64, 20_000, (c * 100) as i64, 0.9, 500.0, 900.0, c % 3);
        }
    }
    for t in 20..24u32 {
        e.track_upsert(t, 1, 1.0, 0.0, false, false);
        e.device_upsert(300 + t, t, 1, 2.0, false);
        e.device_upsert(400 + t, t, 2, 1.0, false);
        e.clip_midi_upsert(500 + t, t, 0, 100.0 + t as f64, 960, 30_000.0);
        e.clip_midi_upsert(600 + t, t, 40_000, 140.0, 480, 30_000.0);
        for n in 0..120u32 {
            // dense chords: more than 64 voices sound at once on some tracks
            e.note_upsert(t * 1000 + n, 500 + t, (n * 40) as f64, 20_000.0, 36 + n % 48, 0.8);
            e.note_upsert(t * 1000 + 500 + n, 600 + t, (n * 25) as f64, 300.0, 40 + n % 40, 0.8);
        }
    }
    for t in 30..32u32 {
        // soundscape tracks: 4 loopers each, with pads, speeds and regions that wrap often
        e.track_upsert(t, 2, 1.0, 0.0, false, false);
        e.clip_audio_upsert(700 + t, t, 1, 0, 90_000, 0, 1.0, 0.0, 0.0, 0);
        for k in 0..4u32 {
            e.looper_upsert(800 + t * 10 + k, t, 0.25 + k as f64, 5000 * k as i64, 3000 + 1000 * k as i64);
        }
    }
    for t in 30..32u32 {
        for g in 0..6u32 {
            e.pad_upsert(5000 + t * 10 + g, t, (g * 12_000) as i64 + 1000 * t as i64, 7_000);
        }
    }
    // automation: a filter cutoff and a synth rolloff, a master filter, and a looper's level, speed and tape
    e.device_upsert(900, engine::MASTER_TRACK, 1, 1.0, false);
    for (lane, kind, target, param, min, max, scale) in [
        (1u32, 0u32, 101u32, 1u32, 20.0, 20_000.0, 1u32),
        (2, 0, 421, 0, 0.001, 3.0, 1),
        (3, 0, 900, 1, 20.0, 20_000.0, 1),
        (4, 1, 1100, 0, 0.0, 1.0, 0),
        (5, 1, 1101, 1, 0.1, 4.0, 1),
        (6, 1, 1102, 3, 200.0, 20_000.0, 1),
    ] {
        e.lane_upsert(lane, kind, target, param, true, min, max, scale);
        for k in 0..200u32 {
            e.point_upsert(lane * 1000 + k, lane, (k * 477) as i64, ((k * 37 + lane * 11) % 100) as f32 / 100.0, k % 3 == 0);
        }
    }
    e.preview_upsert(950, 30, 0);
    e.preview_upsert(951, 31, 1);
    e.preview_play(950, 1000);
    e.preview_play(951, 0);
    e.set_param(engine::PARAM_GATE, 1.0); // M1 test voice too
    e.play(0);

    // Sanity: the counter really sees allocations.
    ARMED.with(|a| a.set(true));
    drop(std::hint::black_box(vec![0u8; 16]));
    ARMED.with(|a| a.set(false));
    assert_eq!(COUNT.with(|c| c.replace(0)), 1, "counting allocator is not counting");

    // ---- measured section ----
    ARMED.with(|a| a.set(true));
    for block in 0..2000u32 {
        e.process(128);
        match block % 97 {
            10 => e.param_set(101, 1, 200.0 + block as f32),
            20 => e.param_set(424, 0, 0.05 + (block % 7) as f32 * 0.1),
            30 => e.seek((block as i64 * 53) % 90_000),
            40 => e.track_upsert(3, 0, 0.3, 0.5, block % 2 == 0, block % 3 == 0),
            50 => e.param_set(423, 6, 1.5),
            90 => e.param_set(1203, 1, 20.0 + (block % 11) as f32 * 150.0), // delay time: the head moves
            80 => e.preview_seek(950, (block as i64 * 17) % 40_000),
            70 => e.looper_upsert(1100, 30, 1.0 + (block % 5) as f64 * 0.3, 1000, 4000),
            60 => {
                e.stop();
                e.play((block as i64 * 31) % 50_000);
            }
            _ => {}
        }
    }
    ARMED.with(|a| a.set(false));
    let allocs = COUNT.with(|c| c.get());
    println!("allocations during 2000 blocks of a busy scene: {allocs}");
    assert_eq!(allocs, 0);
    let (l, r) = e.output();
    assert!(l.iter().chain(r).all(|x| x.is_finite()));
}
