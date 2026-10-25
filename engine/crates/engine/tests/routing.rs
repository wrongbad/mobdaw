//! Routing phase 1 (docs/routing.md): buses, parents, taps (fx send / fx recv), the compressor's key, the schedule,
//! mute and solo across the graph. Signals are constants (a DC clip per track) so the sums are exact to read.

use engine::device::Input;
use engine::{Engine, BLOCK, MASTER_TRACK};

const SR: f32 = 48000.0;
const BUS: u32 = 3;
const MIX: u32 = 9;
const COMP: u32 = 4;
const SEND: u32 = 12;
const RECV: u32 = 13;

fn render(e: &mut Engine, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let (mut l, mut r) = (Vec::new(), Vec::new());
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

/// Render 0.3 s (past every 10 ms ramp) and return the last frame.
fn settle(e: &mut Engine) -> (f32, f32) {
    let (l, r) = render(e, 14400);
    (*l.last().unwrap(), *r.last().unwrap())
}

fn near(a: f32, b: f32) -> bool {
    (a - b).abs() < 2e-3
}

fn assert_lr(got: (f32, f32), want: (f32, f32), what: &str) {
    assert!(near(got.0, want.0) && near(got.1, want.1), "{what}: got {got:?}, want {want:?}");
}

/// A constant-valued track (handle `t`, source `100 + t`, clip `200 + t`), playing from 0.
fn dc(e: &mut Engine, t: u32, v: f32) {
    e.load_source(100 + t, &[&vec![v; 480_000]]);
    e.track_upsert(t, 0, false, false, false);
    e.clip_audio_upsert(200 + t, t, 100 + t, 0, 480_000, 0, 1.0, 0.0, 0.0, 0, 0, 0);
}

fn bus(e: &mut Engine, t: u32, parent: u32) {
    e.track_upsert(t, BUS, false, false, false);
    e.track_set_parent(t, parent);
}

/// The track's mix device (handle `1000 + t`), fader `gain`, pan knob `pan` (-1 is hard left: left passes at unity, right is cut).
fn fader(e: &mut Engine, t: u32, gain: f32, pan: f32) {
    e.device_upsert(1000 + t, t, MIX, 1e6, false);
    e.param_set(1000 + t, 0, gain);
    e.param_set(1000 + t, 1, pan);
}

fn engine() -> Engine {
    let mut e = Engine::new(SR);
    e.play(0);
    e
}

#[test]
fn a_bus_sums_its_children_and_runs_its_own_chain() {
    let mut e = engine();
    dc(&mut e, 1, 0.25);
    dc(&mut e, 2, 0.5);
    bus(&mut e, 10, MASTER_TRACK);
    e.track_set_parent(1, 10);
    e.track_set_parent(2, 10);
    fader(&mut e, 10, 0.5, -1.0); // the bus: half level, hard left
    assert_eq!(e.parent_of(1), Some(10));
    assert_lr(settle(&mut e), (0.375, 0.0), "(0.25 + 0.5) * 0.5, left only");
    // an unrouted track beside it still reaches the master
    dc(&mut e, 3, 0.1);
    assert_lr(settle(&mut e), (0.475, 0.1), "plus the track on the master");
    let sched = e.schedule();
    assert_eq!(sched.last(), Some(&MASTER_TRACK));
    assert!(sched.iter().position(|&h| h == 1) < sched.iter().position(|&h| h == 10), "children run before their bus: {sched:?}");
}

#[test]
fn order_independence_the_parent_may_arrive_before_the_bus_exists() {
    let mut e = engine();
    dc(&mut e, 1, 0.25);
    e.track_set_parent(1, 10); // no bus 10 yet: master
    assert_eq!(e.parent_of(1), Some(MASTER_TRACK));
    assert_lr(settle(&mut e), (0.25, 0.25), "falls back to the master");
    bus(&mut e, 10, MASTER_TRACK);
    fader(&mut e, 10, 0.5, -1.0);
    assert_eq!(e.parent_of(1), Some(10), "resolves once the bus exists");
    assert_lr(settle(&mut e), (0.125, 0.0), "through the bus");
}

#[test]
fn nested_buses_chain_their_devices() {
    let mut e = engine();
    dc(&mut e, 1, 0.8);
    bus(&mut e, 10, 11); // 10 sums into 11 (declared before 11 exists)
    bus(&mut e, 11, MASTER_TRACK);
    e.track_set_parent(10, 11);
    e.track_set_parent(1, 10);
    fader(&mut e, 10, 0.5, -1.0);
    fader(&mut e, 11, 0.5, -1.0);
    assert_eq!(e.parent_of(10), Some(11));
    assert_lr(settle(&mut e), (0.2, 0.0), "0.8 * 0.5 * 0.5");
    let s = e.schedule();
    let at = |h| s.iter().position(|&x| x == h).unwrap();
    assert!(at(1) < at(10) && at(10) < at(11) && at(11) < at(MASTER_TRACK), "{s:?}");
}

#[test]
fn a_parent_that_is_not_a_bus_or_loops_back_goes_to_the_master() {
    let mut e = engine();
    dc(&mut e, 1, 0.25);
    dc(&mut e, 2, 0.25);
    e.track_set_parent(2, 1); // 1 is a plain track
    assert_eq!(e.parent_of(2), Some(MASTER_TRACK));
    bus(&mut e, 10, 11);
    bus(&mut e, 11, 10); // a loop; the smallest handle in it is detached
    assert_eq!(e.parent_of(10), Some(MASTER_TRACK));
    assert_eq!(e.parent_of(11), Some(10));
    e.track_set_parent(1, 11);
    assert_lr(settle(&mut e), (0.5, 0.5), "all still reaches the master");
}

#[test]
fn a_muted_bus_silences_its_subtree_but_not_the_taps_inside_it() {
    let mut e = engine();
    dc(&mut e, 1, 0.25);
    dc(&mut e, 2, 0.5);
    bus(&mut e, 10, MASTER_TRACK);
    e.track_set_parent(1, 10);
    dc(&mut e, 3, 0.0);
    e.device_upsert(31, 3, RECV, 1.0, false); // a return fed by track 1's tap
    e.device_input(31, Input::Track(1));
    assert_lr(settle(&mut e), (0.5 + 0.25 + 0.25, 0.5 + 0.25 + 0.25), "everything");
    e.track_upsert(10, BUS, true, false, false);
    assert_lr(settle(&mut e), (0.5 + 0.25, 0.5 + 0.25), "track 1 inside the muted bus is gone; its tap still feeds the return");
    e.track_upsert(10, BUS, false, false, false);
    assert_lr(settle(&mut e), (1.0, 1.0), "unmuted again");
}

#[test]
fn solo_keeps_the_soloed_ancestors_descendants_and_what_it_feeds() {
    let mut e = engine();
    dc(&mut e, 1, 0.01); // in bus 10
    dc(&mut e, 2, 0.02); // in bus 10
    dc(&mut e, 3, 0.04); // on the master
    dc(&mut e, 4, 0.08); // a return fed by track 1's send
    bus(&mut e, 10, MASTER_TRACK);
    e.track_set_parent(1, 10);
    e.track_set_parent(2, 10);
    e.device_upsert(11, 1, SEND, 0.5, false);
    e.device_upsert(41, 4, RECV, 0.5, false);
    e.device_input(41, Input::Send(11));
    let all = 0.01 + 0.02 + 0.04 + 0.08 + 0.01; // the return also hears track 1
    assert_lr(settle(&mut e), (all, all), "no solo");

    e.track_upsert(1, 0, false, true, false);
    let want = 0.01 + 0.08 + 0.01; // track 1 (through its bus, an ancestor) and the return it feeds, not 2 or 3
    assert_lr(settle(&mut e), (want, want), "solo a child");

    e.track_upsert(1, 0, false, false, false);
    e.track_upsert(10, BUS, false, true, false);
    let want = 0.01 + 0.02 + 0.08 + 0.01; // every descendant of the bus, and downstream of those
    assert_lr(settle(&mut e), (want, want), "solo the bus");

    e.track_upsert(10, BUS, false, false, false);
    e.track_upsert(3, 0, false, true, false);
    assert_lr(settle(&mut e), (0.04, 0.04), "solo a track nothing else feeds");

    e.track_upsert(2, 0, true, false, false); // mute wins over a subtree solo
    e.track_upsert(10, BUS, false, true, false);
    e.track_upsert(3, 0, false, false, false);
    let want = 0.01 + 0.08 + 0.01;
    assert_lr(settle(&mut e), (want, want), "a muted child stays muted under a soloed bus");
}

#[test]
fn the_solo_safe_click_stays_audible_under_any_solo() {
    let mut e = engine();
    dc(&mut e, 1, 0.25);
    dc(&mut e, 2, 0.5);
    e.track_upsert(2, 0, false, false, true); // solo-safe
    dc(&mut e, 3, 0.125);
    e.track_upsert(3, 0, false, true, false);
    assert_lr(settle(&mut e), (0.625, 0.625), "soloed track + the safe one");
    e.track_upsert(2, 0, true, false, true);
    assert_lr(settle(&mut e), (0.125, 0.125), "its own mute still applies");
}

#[test]
fn send_passes_through_and_recv_adds_the_tap_with_gain() {
    let mut e = engine();
    dc(&mut e, 1, 0.5);
    dc(&mut e, 2, 0.0);
    e.device_upsert(11, 1, SEND, 1.0, false);
    e.param_set(11, 0, -6.0206); // the tap carries half
    e.device_upsert(21, 2, RECV, 1.0, false);
    e.device_input(21, Input::Send(11));
    assert_lr(settle(&mut e), (0.5 + 0.25, 0.5 + 0.25), "pass-through plus the return");
    e.param_set(21, 0, 6.0206); // the return doubles it
    assert_lr(settle(&mut e), (0.5 + 0.5, 0.5 + 0.5), "recv gain");
    e.param_set(21, 0, -60.0);
    assert_lr(settle(&mut e), (0.5, 0.5), "-60 dB is silence");
    e.param_set(21, 0, 0.0);
    e.device_upsert(11, 1, SEND, 1.0, true); // a bypassed send's tap is silent, the track still plays
    assert_lr(settle(&mut e), (0.5, 0.5), "bypassed send");
    e.device_upsert(11, 1, SEND, 1.0, false);
    e.device_input(21, Input::Missing); // a tap that does not exist
    assert_lr(settle(&mut e), (0.5, 0.5), "missing tap reads silence");
    e.device_input(21, Input::None);
    assert_lr(settle(&mut e), (0.5, 0.5), "no input");
}

#[test]
fn several_recvs_and_a_recv_inside_a_busy_chain_sum_in_place() {
    let mut e = engine();
    dc(&mut e, 1, 0.5);
    dc(&mut e, 2, 0.25);
    e.device_upsert(11, 1, SEND, 1.0, false);
    // track 2 hears track 1 twice, through two recvs
    e.device_upsert(21, 2, RECV, 1.0, false);
    e.device_upsert(22, 2, RECV, 2.0, false);
    e.device_input(21, Input::Send(11));
    e.device_input(22, Input::Track(1));
    assert_lr(settle(&mut e), (0.5 + 0.25 + 0.5 + 0.5, 0.5 + 0.25 + 0.5 + 0.5), "in + two taps");
}

#[test]
fn a_recv_of_a_tracks_implicit_tap_is_before_the_fader_and_the_mute() {
    let mut e = engine();
    dc(&mut e, 1, 0.5);
    dc(&mut e, 2, 0.0);
    fader(&mut e, 1, 0.0, 0.0); // track 1's fader is all the way down
    e.device_upsert(21, 2, RECV, 1.0, false);
    e.device_input(21, Input::Track(1));
    assert_lr(settle(&mut e), (0.5, 0.5), "the fader (the mix device) is after the tap");
    e.track_upsert(1, 0, true, false, false);
    assert_lr(settle(&mut e), (0.5, 0.5), "and so is the mute");
    e.track_upsert(1, 0, false, false, false);
    e.device_upsert(15, 1, SEND, 2.0, false); // a send before the mix device, still the same tap contents
    e.device_upsert(1001, 1, MIX, 1e6, false);
    assert_lr(settle(&mut e), (0.5, 0.5), "unchanged");
}

#[test]
fn the_master_has_an_implicit_tap_too() {
    let mut e = engine();
    dc(&mut e, 1, 0.25);
    dc(&mut e, 2, 0.0);
    e.device_upsert(21, 2, RECV, 1.0, false);
    e.device_input(21, Input::Master); // a cycle: track 2 hears the master, which includes track 2
    // master = 0.25 + (track 2 = last block's master); each block adds 0.25 again, so it grows linearly by block
    let (l, _) = render(&mut e, 4 * BLOCK);
    assert!(near(l[BLOCK - 1], 0.25) && near(l[2 * BLOCK - 1], 0.5) && near(l[3 * BLOCK - 1], 0.75), "{} {} {}", l[BLOCK - 1], l[2 * BLOCK - 1], l[3 * BLOCK - 1]);
    assert_eq!(e.schedule(), vec![1, 2, MASTER_TRACK]);
}

#[test]
fn a_compressor_keyed_by_another_track_ducks_it_and_the_key_may_be_a_ghost() {
    let build = |keyed: bool| {
        let mut e = engine();
        dc(&mut e, 1, 0.05); // the pad: -26 dB, under the threshold on its own
        dc(&mut e, 2, 1.0); // the kick, fader down: heard by nobody, but still keys
        fader(&mut e, 2, 0.0, 0.0);
        e.device_upsert(11, 1, COMP, 1.0, false);
        e.param_set(11, 0, -20.0);
        e.param_set(11, 1, 20.0);
        e.param_set(11, 2, 0.1);
        e.param_set(11, 3, 10.0); // quick release, so the tests settle
        if keyed {
            e.device_input(11, Input::Track(2));
        }
        e
    };
    let mut e = build(false);
    assert_lr(settle(&mut e), (0.05, 0.05), "unkeyed it leaves a quiet track alone");
    let mut e = build(true);
    let (l, _) = settle(&mut e);
    assert!(l < 0.01, "ducked by the kick's signal: {l}");
    let s = e.schedule();
    assert!(s.iter().position(|&h| h == 2) < s.iter().position(|&h| h == 1), "the key's writer runs first: {s:?}");
    // taking the key away restores it
    e.device_input(11, Input::None);
    let (l, _) = settle(&mut e);
    assert!(near(l, 0.05), "{l}");
}

#[test]
fn a_key_that_is_gone_reads_silence_but_no_key_keys_off_the_input() {
    let loud = |input: Input| {
        let mut e = engine();
        dc(&mut e, 1, 0.5); // -6 dB: over the -20 dB threshold on its own
        e.device_upsert(11, 1, COMP, 1.0, false);
        e.param_set(11, 0, -20.0);
        e.param_set(11, 1, 20.0);
        e.device_input(11, input);
        settle(&mut e).0
    };
    assert!(loud(Input::None) < 0.2, "unkeyed it compresses itself");
    assert!(near(loud(Input::Track(77)), 0.5), "a missing track is a silent key: nothing to compress");
    assert!(near(loud(Input::Missing), 0.5), "so is a tap the bridge says is gone");
    assert!(near(loud(Input::Send(99)), 0.5), "and a send that is not there");
}

/// Track 1 and 2 each hear the other's tap through a recv; track 1 carries an impulse at frame `AT`.
fn cycle(sleep: bool) -> Vec<f32> {
    const AT: usize = 200;
    let mut e = engine();
    e.set_sleep(sleep);
    let mut imp = vec![0.0f32; 4800];
    imp[AT] = 1.0;
    e.load_source(1, &[&imp]);
    e.track_upsert(1, 0, false, false, false);
    e.clip_audio_upsert(1, 1, 1, 0, 4800, 0, 1.0, 0.0, 0.0, 0, 0, 0);
    e.track_upsert(2, 0, false, false, false);
    e.device_upsert(11, 1, RECV, 1.0, false);
    e.param_set(11, 0, -6.0206); // feedback of one half, so the loop decays
    e.device_input(11, Input::Track(2));
    e.device_upsert(21, 2, RECV, 1.0, false);
    e.device_input(21, Input::Track(1));
    assert_eq!(e.schedule(), vec![1, 2, MASTER_TRACK], "the lower track runs first when only a cycle remains");
    render(&mut e, 1024).0
}

#[test]
fn a_two_node_cycle_is_deterministic_with_exactly_one_block_of_delay() {
    let l = cycle(true);
    // track 1 hears the impulse at 200; track 2 hears track 1 the same block: both at 200 -> 2.0.
    // Track 1 then hears track 2's tap one block later at half level (0.5), and track 2 hears that at once.
    for (k, want) in [(200usize, 2.0f32), (200 + BLOCK, 1.0), (200 + 2 * BLOCK, 0.5), (200 + 3 * BLOCK, 0.25)] {
        assert!(near(l[k], want), "frame {k}: got {}, want {want}", l[k]);
    }
    let others = l.iter().enumerate().filter(|&(i, v)| ![200, 200 + BLOCK, 200 + 2 * BLOCK, 200 + 3 * BLOCK, 200 + 4 * BLOCK, 200 + 5 * BLOCK, 200 + 6 * BLOCK].contains(&i) && v.abs() > 1e-6).count();
    assert_eq!(others, 0, "nothing between the repeats");
    assert_eq!(l, cycle(true), "the same every time");
    assert_eq!(l, cycle(false), "sleep changes nothing");
}

#[test]
fn deleting_a_parent_mid_flight_falls_back_to_the_master() {
    let mut e = engine();
    dc(&mut e, 1, 0.25);
    bus(&mut e, 10, MASTER_TRACK);
    e.track_set_parent(1, 10);
    fader(&mut e, 10, 0.5, -1.0);
    assert_lr(settle(&mut e), (0.125, 0.0), "in the bus");
    e.track_remove(10);
    assert_eq!(e.parent_of(1), Some(MASTER_TRACK));
    assert_lr(settle(&mut e), (0.25, 0.25), "on the master");
    // the bus comes back (a peer's undo): the child's stored parent still names it
    bus(&mut e, 10, MASTER_TRACK);
    assert_eq!(e.parent_of(1), Some(10));
}

#[test]
fn a_track_becoming_a_bus_or_the_other_way_re_resolves_its_children() {
    let mut e = engine();
    dc(&mut e, 1, 0.25);
    e.track_upsert(10, 0, false, false, false);
    e.track_set_parent(1, 10);
    assert_eq!(e.parent_of(1), Some(MASTER_TRACK), "not a bus yet");
    e.track_upsert(10, BUS, false, false, false);
    assert_eq!(e.parent_of(1), Some(10));
    e.track_upsert(10, 0, false, false, false);
    assert_eq!(e.parent_of(1), Some(MASTER_TRACK));
}

#[test]
fn buses_meter_like_tracks() {
    let mut e = engine();
    dc(&mut e, 1, 0.25);
    bus(&mut e, 10, MASTER_TRACK);
    e.track_set_parent(1, 10);
    fader(&mut e, 10, 0.5, -1.0);
    settle(&mut e);
    e.meters_read();
    render(&mut e, BLOCK);
    let n = e.meters_read();
    assert_eq!(n, 2);
    let m = e.meters().to_vec();
    let row = |h: u32| (0..n).map(|k| &m[2 + 3 * k..5 + 3 * k]).find(|r| r[0].to_bits() == h).unwrap().to_vec();
    assert!(near(row(1)[1], 0.25), "{:?}", row(1));
    assert!(near(row(10)[1], 0.125) && row(10)[2] < 1e-6, "the bus meters its own post-fader output: {:?}", row(10));
}

#[test]
fn silent_buses_sleep_and_a_live_tap_keeps_a_return_awake() {
    let mut e = engine();
    // a bus with a reverb and no children making sound; a return with a reverb reading a tap
    e.track_upsert(1, 0, false, false, false);
    bus(&mut e, 10, MASTER_TRACK);
    e.track_set_parent(1, 10);
    e.device_upsert(101, 10, 1, 1.0, false); // a filter on the bus
    e.device_upsert(11, 1, SEND, 1.0, false);
    e.track_upsert(2, 0, false, false, false);
    e.device_upsert(21, 2, RECV, 1.0, false);
    e.device_upsert(22, 2, 1, 2.0, false); // a filter after the recv
    e.device_input(21, Input::Send(11));
    render(&mut e, 4 * BLOCK);
    let before = e.sleep_skips();
    render(&mut e, 100 * BLOCK);
    assert!(e.sleep_skips() - before >= 100 * 3, "bus, track and return all sleep once silent: {}", e.sleep_skips() - before);

    // now sound arrives on track 1: the bus and the return wake up and the audio matches a no-sleep engine
    let run = |sleep: bool| {
        let mut e = Engine::new(SR);
        e.set_sleep(sleep);
        e.play(0);
        dc(&mut e, 1, 0.0);
        e.load_source(500, &[&(0..48_000).map(|i| if i > 20_000 { ((i as f32) * 0.05).sin() * 0.5 } else { 0.0 }).collect::<Vec<f32>>()]);
        e.clip_audio_upsert(501, 1, 500, 0, 48_000, 0, 1.0, 0.0, 0.0, 0, 0, 0);
        bus(&mut e, 10, MASTER_TRACK);
        e.track_set_parent(1, 10);
        e.device_upsert(101, 10, 1, 1.0, false);
        e.device_upsert(11, 1, SEND, 1.0, false);
        e.track_upsert(2, 0, false, false, false);
        e.device_upsert(21, 2, RECV, 1.0, false);
        e.device_upsert(22, 2, 1, 2.0, false);
        e.device_input(21, Input::Send(11));
        let out = render(&mut e, 40_000);
        (out, e.sleep_skips())
    };
    let ((a, ar), skipped) = run(true);
    let ((b, br), none) = run(false);
    assert_eq!((a.clone(), ar), (b, br), "sleeping changes nothing audible");
    assert!(skipped > 0 && none == 0);
    assert!(a[30_000..].iter().any(|v| v.abs() > 1e-3), "and the sound arrived");
}

#[test]
fn the_documents_track_order_not_the_handle_decides_ties_and_where_a_cycle_is_cut() {
    let build = |order1: f64, order2: f64| {
        let mut e = engine();
        dc(&mut e, 1, 0.25);
        dc(&mut e, 2, 0.25);
        e.track_order(1, order1);
        e.track_order(2, order2);
        e
    };
    assert_eq!(build(0.0, 0.0).schedule(), vec![1, 2, MASTER_TRACK], "equal orders: by handle");
    assert_eq!(build(5.0, 1.5).schedule(), vec![2, 1, MASTER_TRACK], "a peer whose handles came out the other way round still agrees");
    // a cycle between them: the one first in the document's order runs first, so the delay lands on the other edge
    let mut e = build(5.0, 1.5);
    e.device_upsert(11, 1, RECV, 1.0, false);
    e.device_input(11, Input::Track(2));
    e.device_upsert(21, 2, RECV, 1.0, false);
    e.device_input(21, Input::Track(1));
    assert_eq!(e.schedule(), vec![2, 1, MASTER_TRACK]);
    e.track_order(2, 9.0);
    assert_eq!(e.schedule(), vec![1, 2, MASTER_TRACK]);
}
