//! The engine: entity storage, command handling and the block renderer.
//!
//! # Storage
//! Every entity kind lives in a [`HandleMap`] (a vector sorted by the bridge's `u32` handle):
//! deterministic iteration order, no hashing, no allocation on lookup. Notes are stored
//! twice: `note_keys` (handle -> clip, tick) for updates and removal, and `note_index`, one
//! vector of all notes sorted by `(clip, tick, handle)`, so a clip's notes are a contiguous,
//! time-sorted slice found by binary search (see `clip.rs`). Capacities from the contract are
//! reserved up front.
//!
//! # Order independence
//! Children refer to parents only by handle and are looked up at render time, so a clip
//! stored before its track or source simply renders nothing until they exist. The only
//! derived state is each track's device chain and MIDI-clip list, rebuilt (allocating is fine,
//! these are structural commands) by [`Engine::rebuild_routing`] whenever tracks, devices or
//! clips change.
//!
//! # Rendering one block (<= 128 frames)
//! 1. Update each track's gain/pan ramp targets (mute, solo, gain, pan).
//! 2. Clear the per-track scratch buffers; if playing, mix every overlapping audio clip into
//!    its track's scratch.
//! 3. Per track, walk the block in control segments of at most 32 frames, additionally split
//!    at the next note-on and the next scheduled note-off of the track's instruments. At each
//!    segment start: release due voices, fire notes starting exactly there (each goes to every
//!    instrument whose note range holds its pitch). Run the instruments (summed) per segment.
//!    Then run each effect in `order` over the whole block (split only at its own lanes'
//!    breakpoints, and into pieces of at most 32 frames if it has lanes), and add the result,
//!    scaled by the gain/pan ramp across the block, into the master output, keeping the track's
//!    post-fader peak for the meters.
//! 4. Mix in the M1 test voice if its gate is on; keep the master peak; advance the transport.
//!
//! With the transport cycle on (`set_loop`), a block that reaches the cycle's end is rendered in
//! pieces (steps 1-4 per piece): up to the end, then on from the start, so the wrap is on the exact
//! sample. At the wrap, clip notes are released and the position jumps like a seek.
//!
//! # Automation
//! A [`Lane`] drives one param (a device's, or a looper's) from keyframes in *timeline* time; while
//! it is enabled it replaces the param's static value. Points are normalised (0..1 along the
//! param's own scale), so the curve between two of them is exactly what the editor draws, even
//! for a log-scaled cutoff. Device lanes are evaluated at both ends of every control segment, and
//! segments are split at breakpoints, so a corner is sample-exact: the value jumps to the segment
//! start's and ramps to the end's (`Device::set_param_auto`), with no extra glide. Looper lanes are evaluated once per block: the level ramps
//! linearly to the lane's value at the block's end, the rest (speed, warble, saturation, filter)
//! take its value at the block's start and keep their own, short glides. Lanes follow the
//! timeline position, stopped or not.

use crate::clip::{clip_notes, AudioClip, Clip, MidiClip, NoteEntry};
use crate::device::Device;
use crate::handle_map::HandleMap;
use crate::source::Source;
use crate::transport::Transport;
use crate::test_voice::TestVoice;
use dsp::finnwave::SUB_BLOCK;
use dsp::pan::equal_power;
use dsp::fade::{clip_edge_gain, fade_in_gain};
use dsp::looper::MIN_LENGTH;
use dsp::{FadeShape, LoopParams, LoopVoice, Ramp, TapeColor};
use std::cmp::Ordering;

/// The Web Audio render quantum.
pub const BLOCK: usize = 128;

pub const MAX_TRACKS: usize = 256;
pub const MAX_CLIPS: usize = 4096;
pub const MAX_NOTES: usize = 65536;
pub const MAX_DEVICES: usize = 1024;
pub const MAX_LOOPERS: usize = 1024;
/// Track kind code for a soundscape track (0 audio, 1 midi).
pub const KIND_SOUNDSCAPE: u32 = 2;
/// The track handle that puts a device on the master bus (the "global fx" chain) instead of a track.
pub const MASTER_TRACK: u32 = u32::MAX;
pub const MAX_PADS: usize = 16384;
pub const MAX_LANES: usize = 1024;
pub const MAX_POINTS: usize = 65536;
/// What a lane drives (`engine_lane_upsert`'s `kind`): a device's param, or a looper's (`LOOPER_*`).
pub const LANE_DEVICE: u32 = 0;
pub const LANE_LOOPER: u32 = 1;
pub const LOOPER_GAIN: u32 = 0;
pub const LOOPER_SPEED: u32 = 1;
pub const LOOPER_SAT: u32 = 2;
pub const LOOPER_CUTOFF: u32 = 3;
pub const LOOPER_WARBLE: u32 = 4;
const LOOPER_PARAMS: usize = 5;
const NO_LANE: u32 = u32::MAX;
pub const MAX_PREVIEWS: usize = 512;
/// Pad gates fade in and out over this long (also the declick floor of `clip_edge_gain`).
const PAD_FADE_MS: f64 = 5.0;
const LOOP_SPEED: (f64, f64) = (0.1, 4.0);
const SMOOTH_MS: f64 = 10.0;

struct Track {
    gain: f32,
    pan: f32,
    muted: bool,
    soloed: bool,
    /// Ignores other tracks' solo (the metronome's click track); its own mute still applies.
    solo_safe: bool,
    /// New tracks snap to their first target instead of ramping up from silence.
    fresh: bool,
    /// Linear ramps of the final per-channel coefficient `gain * pan_law * audible`.
    gain_l: Ramp,
    gain_r: Ramp,
    /// Preallocated planar stereo scratch: `BLOCK` left, then `BLOCK` right.
    scratch: Vec<f32>,
    /// Set when a clip wrote into `scratch` this block.
    has_audio: bool,
    /// The track's devices in ascending `order` (derived).
    chain: Vec<Slot>,
    /// MIDI clips on this track as `(index into clips, handle)` (derived).
    midi_clips: Vec<(u32, u32)>,
    /// Audio clip indices on this track in handle order (derived); the tape a looper track reads from.
    audio_clips: Vec<u32>,
    /// Playable audio clips sorted by `(start, handle)`, with the running maximum of their ends
    /// in `play_max_end`, so "which clips overlap this block" is two binary searches (derived).
    play: Vec<ClipSpan>,
    play_max_end: Vec<i64>,
    /// Soundscape track: its clips are the *source* tape the loopers read (in source time),
    /// never played linearly.
    soundscape: bool,
    /// Post-fader peak per channel since the last [`Engine::meters_read`], as the bits of `|x|` (for
    /// non-negative floats the bit patterns order like the values, and an integer max vectorizes).
    peak: [u32; 2],
}

/// A device in a chain, by dense index into the device map (derived by `rebuild_routing`, which
/// runs after every structural change, so the index is valid whenever `process` runs).
struct Slot {
    dev: u32,
    instrument: bool,
    /// Enabled lanes driving this device (indices into the lane map), in lane-handle order.
    lanes: Vec<u32>,
}

/// An audio clip's extent on the timeline, and where it is in the clip map.
#[derive(Clone, Copy)]
struct ClipSpan {
    start: i64,
    end: i64,
    idx: u32,
}

/// One of a soundscape track's loop slots: reads the track's source audio inside the region
/// `[start, start+length)`, and only sounds while a pad (gate) is on.
struct Looper {
    track: u32,
    params: LoopParams,
    voice: LoopVoice,
    /// A second voice for the Loops preview, so it never disturbs the pad-driven one.
    pvoice: LoopVoice,
    /// This track's pads as `(start, end)` sorted by start (derived), and the running maximum
    /// of the ends, so "which pads still matter at time t" is a binary search.
    gates: Vec<(i64, i64)>,
    max_end: Vec<i64>,
    /// Mix level target (0 when muted) and the value the last block ended on; the block ramps
    /// between them so a fader move or mute never clicks.
    gain: f32,
    gain_now: f32,
    /// Read head on the tape (source samples) as of the last block, or -1 when not sounding.
    head: f64,
    /// Saturation and low-pass applied to the looper's output, before its level.
    color: TapeColor,
    /// The un-automated level, the mute flag, and the tape settings the bridge last sent (an
    /// automated saturation keeps the filter's static value, and the other way round).
    base_gain: f32,
    muted: bool,
    drive: f32,
    cutoff: f32,
    /// The enabled lane driving each param (`LOOPER_*`), or `NO_LANE` (derived).
    auto: [u32; LOOPER_PARAMS],
}

impl Looper {
    /// The mix level at sample `i` of an `n`-frame block: a linear ramp from the previous
    /// block's level to the target.
    fn mix_at(&self, i: usize, n: usize) -> f32 {
        self.gain_now + (self.gain - self.gain_now) * ((i + 1) as f32 / n as f32)
    }

    /// The pad active at `t` (the latest-starting one covering it; a later pad retriggers) and
    /// the first sample after `t` where that answer can change, capped at `limit`.
    fn gate_at(&self, t: i64, limit: i64) -> (Option<(i64, i64)>, i64) {
        let from = self.max_end.partition_point(|&e| e <= t);
        let (mut active, mut next) = (None, limit);
        for &(s, e) in &self.gates[from..] {
            if s > t {
                next = next.min(s);
                break;
            }
            if e > t {
                active = Some((s, e));
            }
        }
        if let Some((_, e)) = active {
            next = next.min(e);
        }
        (active, next)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scale {
    Lin,
    Log,
    Pow,
}

#[derive(Clone, Copy)]
struct LanePoint {
    pos: i64,
    value: f32,
    /// The segment after this point is a step (holds `value`) instead of a line to the next point.
    hold: bool,
}

/// A lane in LFO mode: `center ± depth` (normalised) swung by a wave that is a pure function of the
/// timeline position, so seeking, looping and a bounce all read the same value in the same place.
#[derive(Clone, Copy)]
struct LaneLfo {
    shape: u32,
    /// `rate_hz / sample_rate`.
    cycles_per_sample: f64,
    depth: f64,
    /// The param's static value as the host sees it (normalised), kept up to date as the knob moves.
    center: f64,
}

/// One automated param. `points` is derived from the point entities (sorted by position).
struct Lane {
    kind: u32,
    target: u32,
    param: u32,
    enabled: bool,
    min: f64,
    max: f64,
    scale: Scale,
    /// Set while the lane is in LFO mode: the points are kept but not read.
    lfo: Option<LaneLfo>,
    points: Vec<LanePoint>,
}

impl Lane {
    /// The value a segment *ending* at `pos` (exclusive) reaches: the limit from the left. It
    /// differs from `norm_at(pos)` only at a breakpoint, where a `hold` step has not happened yet
    /// (and a duplicated position has not jumped). A wave has no corners: same as `norm_at`.
    fn norm_end(&self, pos: i64) -> Option<f64> {
        if self.lfo.is_some() {
            return self.norm_at(pos);
        }
        let i = self.points.partition_point(|p| p.pos < pos);
        let a = self.points.get(i.saturating_sub(1))?;
        let Some(b) = self.points.get(i).filter(|_| i > 0 && !a.hold) else { return Some(a.value as f64) };
        let f = (pos - a.pos) as f64 / (b.pos - a.pos) as f64;
        Some(a.value as f64 + (b.value as f64 - a.value as f64) * f)
    }

    /// The normalised value at `pos`: before the first point and after the last it holds that
    /// point's value; between two, the left one's curve decides. `None` without points.
    fn norm_at(&self, pos: i64) -> Option<f64> {
        if let Some(l) = &self.lfo {
            let w = dsp::lfo::wave(pos as f64 * l.cycles_per_sample, l.shape) as f64;
            return Some((l.center + l.depth * w).clamp(0.0, 1.0));
        }
        let i = self.points.partition_point(|p| p.pos <= pos);
        let a = self.points.get(i.saturating_sub(1))?;
        let Some(b) = self.points.get(i).filter(|_| i > 0 && !a.hold) else { return Some(a.value as f64) };
        let f = (pos - a.pos) as f64 / (b.pos - a.pos) as f64;
        Some(a.value as f64 + (b.value as f64 - a.value as f64) * f)
    }

    /// The param's own value at `pos` (the normalised one mapped through the range and scale).
    fn value_at(&self, pos: i64) -> Option<f64> {
        Some(self.map(self.norm_at(pos)?))
    }

    /// The param's own value a segment ending at `pos` reaches (see `norm_end`).
    fn value_end(&self, pos: i64) -> Option<f64> {
        Some(self.map(self.norm_end(pos)?))
    }

    fn map(&self, norm: f64) -> f64 {
        let t = norm.clamp(0.0, 1.0);
        match self.scale {
            Scale::Log if self.min > 0.0 => self.min * (self.max / self.min).powf(t),
            Scale::Pow => self.min + (self.max - self.min) * t * t * t,
            _ => self.min + (self.max - self.min) * t,
        }
    }

    /// The first breakpoint after `pos` (`i64::MAX` if none): a control segment must not run past it.
    fn next_break(&self, pos: i64) -> i64 {
        if self.lfo.is_some() {
            return i64::MAX; // a wave has no corners: it is read at each segment start
        }
        self.points.get(self.points.partition_point(|p| p.pos <= pos)).map_or(i64::MAX, |p| p.pos)
    }
}

/// A keyframe, stored on its own like a note so commands can arrive in any order.
struct Point {
    lane: u32,
    p: LanePoint,
}

fn lane_value(lanes: &HandleMap<Lane>, h: u32, pos: i64) -> Option<f64> {
    if h == NO_LANE {
        return None;
    }
    lanes.get(h)?.value_at(pos)
}

/// What a preview plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewMode {
    /// The soundscape's source tape, played straight through from the preview position.
    Source,
    /// Its loopers, all sounding continuously (no pads); the preview position is the loop clock.
    Loops,
}

/// A private transport on one soundscape track, independent of the timeline (and of other
/// previews): audition the source, or the loops, without touching the main playhead.
struct Preview {
    track: u32,
    mode: PreviewMode,
    transport: Transport,
    /// Where playback (re)started, for the fade-in that hides the hard start.
    started: i64,
}

/// A free-time gate block: switches *all* of a soundscape track's loopers on over
/// `[start, start+length)` (timeline samples).
struct Pad {
    track: u32,
    start: i64,
    length: i64,
}

/// Resolve a track's audio clips to `(clip index, source index)` pairs for the block, skipping
/// the ones whose source is missing or not ready. Done once per block so the per-sample tape
/// reads below do no lookups.
fn fill_tape(refs: &mut Vec<(u32, u32)>, idxs: &[u32], clips: &HandleMap<Clip>, sources: &HandleMap<Source>) {
    refs.clear();
    for &ci in idxs {
        if let Clip::Audio(a) = clips.get_index(ci as usize) {
            if let Some(si) = sources.index_of(a.source).filter(|&si| sources.get_index(si).is_ready()) {
                refs.push((ci, si as u32));
            }
        }
    }
}

/// The track's clips summed at timeline sample `i` (`refs` from [`fill_tape`]).
fn tape_at(refs: &[(u32, u32)], clips: &HandleMap<Clip>, sources: &HandleMap<Source>, i: i64) -> (f32, f32) {
    let (mut l, mut r) = (0.0, 0.0);
    for &(ci, si) in refs {
        if let Clip::Audio(a) = clips.get_index(ci as usize) {
            let (x, y) = a.sample_at(sources.get_index(si as usize), i);
            l += x;
            r += y;
        }
    }
    (l, r)
}

/// Set a device param from `lane` for the segment `[at, at + len)`: its value at the start, ramping
/// to the value the lane reaches at the end (nothing moves while stopped).
fn apply_lane(d: &mut Device, lane: &Lane, at: i64, len: usize, playing: bool) {
    let Some(v0) = lane.value_at(at) else { return };
    let v1 = if playing { lane.value_end(at + len as i64).unwrap_or(v0) } else { v0 };
    d.set_param_auto(lane.param, v0 as f32, v1 as f32, len);
}

/// Where a segment starting at buffer index `i` (timeline `p + i`) must end for `slot`'s lanes:
/// the next breakpoint of any of them, or `end` if sooner.
fn lane_limit(slot: &Slot, lanes: &HandleMap<Lane>, p: i64, i: usize, n: usize, mut end: usize) -> usize {
    for &li in &slot.lanes {
        end = end.min(lanes.get_index(li as usize).next_break(p + i as i64).saturating_sub(p).clamp(i as i64 + 1, n as i64) as usize);
    }
    end
}

/// Run an effect (or a master-bus device) over the whole buffer `l`/`r`, which starts at timeline
/// sample `p`. Without lanes that is one call; with lanes, pieces of at most `SUB_BLOCK` ending
/// at the lanes' breakpoints, each with the lanes' values ramped across it.
#[allow(clippy::too_many_arguments)]
fn run_device(slot: &Slot, devices: &mut HandleMap<Device>, lanes: &HandleMap<Lane>, p: i64, playing: bool, l: &mut [f32], r: &mut [f32], sr32: f32) {
    let d = devices.get_index_mut(slot.dev as usize);
    if d.bypass {
        return;
    }
    let n = l.len();
    if slot.lanes.is_empty() && !d.is_ramping() {
        d.process(l, r, sr32);
        return;
    }
    // Lanes or a knob glide: control segments of at most 32 frames, since devices read their
    // ramps at the start of each run.
    let mut i = 0;
    while i < n {
        let end = lane_limit(slot, lanes, p, i, n, (i + SUB_BLOCK).min(n));
        for &li in &slot.lanes {
            apply_lane(d, lanes.get_index(li as usize), p + i as i64, end - i, playing);
        }
        d.process(&mut l[i..end], &mut r[i..end], sr32);
        i = end;
    }
}

pub struct Engine {
    /// Planar stereo: left in `out[0..BLOCK]`, right in `out[BLOCK..2*BLOCK]`.
    out: [f32; 2 * BLOCK],
    sample_rate: f32,
    sr: f64,
    smooth_samples: f64,
    /// The timeline transport.
    main: Transport,
    sources: HandleMap<Source>,
    tracks: HandleMap<Track>,
    clips: HandleMap<Clip>,
    devices: HandleMap<Device>,
    loopers: HandleMap<Looper>,
    /// The master bus's devices in ascending `order` (derived).
    master_chain: Vec<Slot>,
    /// Whether silent tracks skip their idle instruments and sleeping effects (on unless a test turns it off).
    sleep: bool,
    /// Track-blocks skipped by sleep (for tests).
    sleep_skips: u64,
    /// Scratch for [`fill_tape`], sized by `rebuild_routing`.
    tape_refs: Vec<(u32, u32)>,
    lanes: HandleMap<Lane>,
    points: HandleMap<Point>,
    pads: HandleMap<Pad>,
    previews: HandleMap<Preview>,
    note_keys: HandleMap<(u32, f64)>,
    note_index: Vec<NoteEntry>,
    voice: TestVoice,
    /// Live input, planar stereo (`BLOCK` left, then `BLOCK` right), written by the host before each `process`.
    input: [f32; 2 * BLOCK],
    /// The track whose chain the input is played through (input monitoring), if any.
    monitor: Option<u32>,
    /// Level of the monitored input: ramps to 1 when monitoring is on, to 0 when off or when it changes tracks.
    monitor_gain: Ramp,
    /// The track the input is (still) being mixed into while `monitor_gain` fades out.
    monitor_track: Option<u32>,
    /// The transport cycle `[start, end)` while it is on (and `end > start`); see [`Engine::set_loop`].
    cycle: Option<(i64, i64)>,
    /// Master output peak per channel since the last [`Engine::meters_read`] (bits of `|x|`, like `Track::peak`).
    master_peak: [u32; 2],
    /// What [`Engine::meters_read`] fills: master L, R, then `(handle bits, L, R)` per track. Sized by
    /// `rebuild_routing`, so reading never allocates.
    meters: Vec<f32>,
}

fn note_order(e: &NoteEntry, clip: u32, tick: f64, handle: u32) -> Ordering {
    e.clip.cmp(&clip).then(e.tick.total_cmp(&tick)).then(e.handle.cmp(&handle))
}

impl Engine {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            out: [0.0; 2 * BLOCK],
            sample_rate,
            sr: sample_rate as f64,
            smooth_samples: sample_rate as f64 * SMOOTH_MS * 1e-3,
            main: Transport::default(),
            sources: HandleMap::with_capacity(256),
            tracks: HandleMap::with_capacity(MAX_TRACKS),
            clips: HandleMap::with_capacity(MAX_CLIPS),
            devices: HandleMap::with_capacity(MAX_DEVICES),
            loopers: HandleMap::with_capacity(MAX_LOOPERS),
            master_chain: Vec::with_capacity(MAX_DEVICES),
            sleep: true,
            sleep_skips: 0,
            tape_refs: Vec::new(),
            lanes: HandleMap::with_capacity(MAX_LANES),
            points: HandleMap::with_capacity(MAX_POINTS),
            pads: HandleMap::with_capacity(MAX_PADS),
            previews: HandleMap::with_capacity(MAX_PREVIEWS),
            note_keys: HandleMap::with_capacity(MAX_NOTES),
            note_index: Vec::with_capacity(MAX_NOTES),
            voice: TestVoice::new(sample_rate),
            input: [0.0; 2 * BLOCK],
            monitor: None,
            monitor_gain: Ramp::new(0.0),
            monitor_track: None,
            cycle: None,
            master_peak: [0; 2],
            meters: vec![0.0; 2],
        }
    }

    // ---- input monitoring -----------------------------------------------------------------

    pub fn input_ptr(&mut self) -> *mut f32 {
        self.input.as_mut_ptr()
    }

    /// Play the live input through track `h`'s device chain, gain and pan (or stop with `None`).
    /// Moving to another track fades the old one out and the new one in.
    pub fn monitor(&mut self, h: Option<u32>) {
        self.monitor = h;
    }

    // ---- live notes -----------------------------------------------------------------------

    /// A key pressed (`on`) or let go on track `h`, played by the track's sounding instruments whose note range holds
    /// `pitch`, like a MIDI clip note but held until the matching off. Applied between blocks, whether or not the
    /// transport runs; a transport stop or seek releases it with everything else.
    pub fn note_live(&mut self, h: u32, pitch: u32, velocity: f32, on: bool) {
        let at = self.main.position;
        let Some(t) = self.tracks.get(h) else { return };
        for s in &t.chain {
            let d = self.devices.get_index_mut(s.dev as usize);
            if d.takes_note(pitch) {
                if on {
                    d.note_on(pitch, velocity, i64::MAX, at);
                } else {
                    d.note_off(pitch);
                }
            }
        }
    }

    // ---- output ---------------------------------------------------------------------------

    pub fn out_ptr(&mut self) -> *mut f32 {
        self.out.as_mut_ptr()
    }

    /// `(left, right)` of the last rendered block (128 frames each).
    pub fn output(&self) -> (&[f32], &[f32]) {
        self.out.split_at(BLOCK)
    }

    // ---- transport ------------------------------------------------------------------------

    fn release_all_voices(&mut self) {
        for d in self.devices.values_mut() {
            d.release_all();
        }
    }

    pub fn play(&mut self, from: i64) {
        self.release_all_voices();
        self.main.play(from);
    }

    pub fn stop(&mut self) {
        self.release_all_voices();
        self.main.stop();
    }

    pub fn seek(&mut self, pos: i64) {
        self.release_all_voices();
        self.main.seek(pos);
    }

    pub fn position(&self) -> i64 {
        self.main.position
    }

    /// The transport cycle: while playing with it on, reaching `end` continues from `start` within the same block, on
    /// exactly the sample (see [`Self::process`]). Off, or `end <= start`, disables it. A playhead already at or past
    /// `end` plays on; only reaching `end` from before it wraps.
    pub fn set_loop(&mut self, start: i64, end: i64, on: bool) {
        self.cycle = (on && end > start).then_some((start, end));
    }

    /// The cycle `(start, end)` while it is on.
    pub fn loop_region(&self) -> Option<(i64, i64)> {
        self.cycle
    }

    /// The wrap from the cycle's end back to its start: like a seek for everything stateless (clips, automation, pads,
    /// MIDI notes, which fire from `start` on), except that only clip notes are released (their scheduled releases are
    /// in the old timeline), not held live keys or drum tails; effect tails ring on.
    fn wrap_to(&mut self, start: i64) {
        for d in self.devices.values_mut() {
            d.release_scheduled();
        }
        self.main.seek(start);
    }

    // ---- meters ---------------------------------------------------------------------------

    /// Fill the meter buffer with the post-fader peaks (linear, `|x|`) since the last read and reset them: master L, R,
    /// then per track (in handle order) the handle (as the bits of a `u32`), L, R. Returns the number of tracks. Never
    /// allocates; the buffer is at [`Self::meters_ptr`] and only moves on structural calls.
    pub fn meters_read(&mut self) -> usize {
        let Engine { meters, tracks, master_peak, .. } = self;
        meters[0] = f32::from_bits(master_peak[0]);
        meters[1] = f32::from_bits(master_peak[1]);
        *master_peak = [0; 2];
        let mut k = 0;
        for (h, t) in tracks.iter_mut() {
            let at = 2 + 3 * k;
            if at + 3 > meters.len() {
                break; // (rebuild_routing keeps it sized; never true)
            }
            meters[at] = f32::from_bits(h);
            meters[at + 1] = f32::from_bits(t.peak[0]);
            meters[at + 2] = f32::from_bits(t.peak[1]);
            t.peak = [0; 2];
            k += 1;
        }
        k
    }

    pub fn meters_ptr(&self) -> *const f32 {
        self.meters.as_ptr()
    }

    /// The meter buffer as [`Self::meters_read`] last filled it.
    pub fn meters(&self) -> &[f32] {
        &self.meters
    }

    pub fn is_playing(&self) -> bool {
        self.main.playing
    }

    // ---- sources --------------------------------------------------------------------------

    /// Allocate (or replace) a source and return the pointer the host fills. Not playable
    /// until [`Self::source_ready`].
    pub fn source_alloc(&mut self, h: u32, channels: u32, frames: f64) -> *mut f32 {
        let channels = (channels as usize).clamp(1, 64);
        let frames = if frames.is_finite() { frames.max(0.0) as usize } else { 0 };
        self.sources.insert(h, Source::new(channels, frames));
        self.sources.get_mut(h).map_or(std::ptr::null_mut(), |s| s.as_mut_ptr())
    }

    pub fn source_ready(&mut self, h: u32) {
        if let Some(s) = self.sources.get_mut(h) {
            s.set_ready();
        }
    }

    pub fn source_free(&mut self, h: u32) {
        self.sources.remove(h);
    }

    // ---- live sources (a take being recorded; engine.md section 9.2) ---------------------

    /// Create (or replace) a live source: playable at once, silent past what has been written, with
    /// room for `reserve_frames` (rounded up to whole chunks). Only the first two channels are kept.
    pub fn source_live_alloc(&mut self, h: u32, channels: u32, reserve_frames: f64) {
        let mut s = Source::live((channels as usize).clamp(1, 2));
        s.live_reserve(if reserve_frames.is_finite() { reserve_frames.max(0.0) as usize } else { 0 });
        self.sources.insert(h, s);
    }

    /// Make room for at least `frames` frames in total. Allocates, so it is a structural call:
    /// keep ahead of the recording with it. Unknown handles and decoded sources are ignored.
    pub fn source_live_reserve(&mut self, h: u32, frames: f64) {
        if let Some(s) = self.sources.get_mut(h) {
            s.live_reserve(if frames.is_finite() { frames.max(0.0) as usize } else { 0 });
        }
    }

    /// Append frames to a live source: one slice per channel. Returns the frames taken (fewer than
    /// offered only if the reserve ran out; the rest is dropped). Never allocates.
    pub fn source_live_append(&mut self, h: u32, channels: &[&[f32]]) -> usize {
        self.sources.get_mut(h).map_or(0, |s| s.live_append(channels))
    }

    /// Append the first `frames` (at most `BLOCK`) of the input buffer, which the host filled like
    /// it does for monitoring. A source with two channels takes both sides of the buffer.
    pub fn source_live_append_input(&mut self, h: u32, frames: usize) -> usize {
        let n = frames.min(BLOCK);
        let (l, r) = self.input.split_at(BLOCK);
        match self.sources.get_mut(h) {
            Some(s) => s.live_append(&[&l[..n], &r[..n]]),
            None => 0,
        }
    }

    /// The frames written to a live source so far (0 for anything else).
    pub fn source_live_written(&self, h: u32) -> usize {
        self.sources.get(h).filter(|s| s.is_live()).map_or(0, |s| s.frames())
    }

    /// End a live source: no more appends; the audio written stays readable.
    pub fn source_live_finalize(&mut self, h: u32) {
        if let Some(s) = self.sources.get_mut(h) {
            s.live_finalize();
        }
    }

    /// Test/host convenience: allocate, copy planar `channels` in, mark ready.
    pub fn load_source(&mut self, h: u32, channels: &[&[f32]]) {
        let frames = channels.first().map_or(0, |c| c.len());
        self.source_alloc(h, channels.len() as u32, frames as f64);
        if let Some(s) = self.sources.get_mut(h) {
            for (i, c) in channels.iter().enumerate() {
                s.data_mut()[i * frames..(i + 1) * frames].copy_from_slice(c);
            }
            s.set_ready();
        }
    }

    // ---- tracks ---------------------------------------------------------------------------

    pub fn track_upsert(&mut self, h: u32, kind: u32, gain: f32, pan: f32, muted: bool, soloed: bool, solo_safe: bool) {
        let gain = if gain.is_finite() { gain.max(0.0) } else { 1.0 };
        let pan = if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { 0.0 };
        if let Some(t) = self.tracks.get_mut(h) {
            (t.gain, t.pan, t.muted, t.soloed, t.solo_safe) = (gain, pan, muted, soloed, solo_safe);
            t.soundscape = kind == KIND_SOUNDSCAPE;
            return;
        }
        self.tracks.insert(
            h,
            Track {
                gain,
                pan,
                muted,
                soloed,
                solo_safe,
                fresh: true,
                gain_l: Ramp::new(0.0),
                gain_r: Ramp::new(0.0),
                scratch: vec![0.0; 2 * BLOCK],
                has_audio: false,
                chain: Vec::new(),
                midi_clips: Vec::new(),
                audio_clips: Vec::new(),
                play: Vec::new(),
                play_max_end: Vec::new(),
                soundscape: kind == KIND_SOUNDSCAPE,
                peak: [0; 2],
            },
        );
        self.rebuild_routing();
    }

    pub fn track_remove(&mut self, h: u32) {
        self.tracks.remove(h);
        self.rebuild_routing();
    }

    // ---- clips and notes ------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn clip_audio_upsert(
        &mut self,
        h: u32,
        track: u32,
        source: u32,
        start: i64,
        length: i64,
        source_offset: i64,
        gain: f32,
        fade_in: f64,
        fade_out: f64,
        fade_shape: u32,
        loop_length: i64,
        loop_phase: i64,
    ) {
        let loop_length = loop_length.max(0);
        let loop_phase = if loop_length > 0 { loop_phase.rem_euclid(loop_length) } else { 0 };
        self.clips.insert(
            h,
            Clip::Audio(AudioClip {
                track,
                source,
                start,
                length,
                source_offset,
                gain,
                fade_in,
                fade_out,
                shape: FadeShape::from_u32(fade_shape),
                loop_length,
                loop_phase,
                seam_max: (self.sr * 0.010) as i64,
            }),
        );
        self.rebuild_routing();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn clip_midi_upsert(&mut self, h: u32, track: u32, start: i64, bpm: f64, ppq: u32, length_ticks: f64, loop_ticks: f64) {
        self.clips.insert(h, Clip::Midi(MidiClip { track, start, bpm, ppq, length_ticks, loop_ticks }));
        self.rebuild_routing();
    }

    pub fn clip_remove(&mut self, h: u32) {
        self.clips.remove(h);
        self.rebuild_routing();
    }

    pub fn note_upsert(&mut self, h: u32, clip: u32, tick: f64, dur_ticks: f64, pitch: u32, velocity: f32) {
        if !tick.is_finite() || !dur_ticks.is_finite() {
            return;
        }
        self.note_remove(h);
        let tick = tick + 0.0; // normalises -0.0 so total_cmp ordering matches numeric ordering
        let entry = NoteEntry { clip, handle: h, tick, dur_ticks, pitch, velocity };
        let at = self.note_index.partition_point(|e| note_order(e, clip, tick, h) == Ordering::Less);
        self.note_index.insert(at, entry);
        self.note_keys.insert(h, (clip, tick));
    }

    pub fn note_remove(&mut self, h: u32) {
        if let Some((clip, tick)) = self.note_keys.remove(h) {
            let at = self.note_index.partition_point(|e| note_order(e, clip, tick, h) == Ordering::Less);
            if self.note_index.get(at).is_some_and(|e| e.handle == h) {
                self.note_index.remove(at);
            }
        }
    }

    // ---- loopers --------------------------------------------------------------------------

    /// Create or update a loop slot. `start`/`length` are the region in *source* time (the
    /// samples of the track's source clips); `length < 64` means "no region" (silent).
    /// Updating keeps the voice, so an unchanged upsert doesn't disturb playback.
    pub fn looper_upsert(&mut self, h: u32, track: u32, speed: f64, start: i64, length: i64) {
        let speed = if speed.is_finite() { speed.clamp(LOOP_SPEED.0, LOOP_SPEED.1) } else { 1.0 };
        let warble = self.loopers.get(h).map_or(0.0, |l| l.params.warble);
        let params = LoopParams { speed, start, length, warble, sample_rate: self.sr };
        match self.loopers.get_mut(h) {
            Some(l) => (l.track, l.params) = (track, params),
            None => {
                let (gates, max_end) = (Vec::new(), Vec::new());
                self.loopers.insert(h, Looper { track, params, voice: LoopVoice::new(), pvoice: LoopVoice::new(), gates, max_end, gain: 1.0, gain_now: 1.0, head: -1.0, color: TapeColor::new(),
                    base_gain: 1.0, muted: false, drive: 0.0, cutoff: dsp::tape::CUTOFF_MAX, auto: [NO_LANE; LOOPER_PARAMS] });
                self.rebuild_routing(); // pads may have arrived before their looper
            }
        }
    }

    /// A looper's tape character: `drive` (saturation, 0..1), `cutoff_hz` (low-pass, 200..20000;
    /// the top is open) and `warble` (wow/flutter depth, 0..1). All glide; the first call after
    /// the looper is created snaps.
    pub fn looper_tape(&mut self, h: u32, drive: f32, cutoff_hz: f32, warble: f32) {
        let sr = self.sr;
        let Some(l) = self.loopers.get_mut(h) else { return };
        l.params.warble = if warble.is_finite() { warble.clamp(0.0, 1.0) as f64 } else { 0.0 };
        (l.drive, l.cutoff) = (drive, cutoff_hz);
        l.color.set(drive, cutoff_hz, sr, l.head < 0.0 && !self.main.playing);
    }

    pub fn looper_remove(&mut self, h: u32) {
        self.loopers.remove(h);
    }

    /// A looper's level (linear, clamped to 0..2) and mute. Applied with a short ramp; the
    /// first call after the looper is created snaps instead, so a loaded muted looper is silent
    /// from its first sample.
    pub fn looper_mix(&mut self, h: u32, gain: f32, muted: bool) {
        let Some(l) = self.loopers.get_mut(h) else { return };
        let g = if gain.is_finite() { gain.clamp(0.0, 2.0) } else { 1.0 };
        (l.base_gain, l.muted) = (g, muted);
        l.gain = if muted { 0.0 } else { g };
        if l.head < 0.0 && !self.main.playing {
            l.gain_now = l.gain;
        }
    }

    /// Where the looper's read head is on the source tape (samples), or -1 while it isn't
    /// sounding (no pad on, no loops preview playing, no region). For drawing a playhead.
    pub fn looper_head(&self, h: u32) -> f64 {
        self.loopers.get(h).map_or(-1.0, |l| l.head)
    }

    /// A pad: all of `track`'s loopers are on over `[start, start+length)` of the timeline.
    pub fn pad_upsert(&mut self, h: u32, track: u32, start: i64, length: i64) {
        self.pads.insert(h, Pad { track, start, length: length.max(0) });
        self.rebuild_routing();
    }

    pub fn pad_remove(&mut self, h: u32) {
        self.pads.remove(h);
        self.rebuild_routing();
    }

    // ---- automation -----------------------------------------------------------------------

    /// Create or update a lane: `kind` is `LANE_DEVICE` (`target` a device handle, `param` its param
    /// id) or `LANE_LOOPER` (`param` a `LOOPER_*` code). `min`, `max` and `scale` (0 linear, 1 log,
    /// 2 cubic) map the points' normalised values to the param's own. A disabled lane is kept but
    /// does nothing. Its points are separate entities (`point_upsert`) and may arrive before it.
    #[allow(clippy::too_many_arguments)]
    pub fn lane_upsert(&mut self, h: u32, kind: u32, target: u32, param: u32, enabled: bool, min: f64, max: f64, scale: u32) {
        if !min.is_finite() || !max.is_finite() {
            return;
        }
        let scale = match scale {
            1 => Scale::Log,
            2 => Scale::Pow,
            _ => Scale::Lin,
        };
        match self.lanes.get_mut(h) {
            Some(l) => (l.kind, l.target, l.param, l.enabled, l.min, l.max, l.scale) = (kind, target, param, enabled, min, max, scale),
            None => {
                self.lanes.insert(h, Lane { kind, target, param, enabled, min, max, scale, lfo: None, points: Vec::new() });
                self.rebuild_lane_points(h);
            }
        }
        self.rebuild_routing();
    }

    /// Put lane `h` in LFO mode: its value is `center ± depth` (all normalised, 0..1) swung by `shape`
    /// (`dsp::lfo`) at `rate_hz`, instead of read from its points. `center` is the param's static
    /// value, which the host re-sends as the knob moves. `lfo: false` returns it to keyframes.
    /// Does nothing for an unknown lane.
    #[allow(clippy::too_many_arguments)]
    pub fn lane_lfo(&mut self, h: u32, lfo: bool, shape: u32, rate_hz: f64, depth: f64, center: f64) {
        let sr = self.sr;
        let Some(l) = self.lanes.get_mut(h) else { return };
        l.lfo = (lfo && rate_hz.is_finite() && depth.is_finite() && center.is_finite()).then(|| LaneLfo {
            shape: shape.min(dsp::lfo::SHAPES - 1),
            cycles_per_sample: rate_hz.clamp(0.0, 1000.0) / sr,
            depth: depth.clamp(0.0, 1.0),
            center: center.clamp(0.0, 1.0),
        });
    }

    pub fn lane_remove(&mut self, h: u32) {
        self.lanes.remove(h);
        self.rebuild_routing();
    }

    /// A keyframe of `lane` at timeline sample `pos` with normalised `value` (0..1); `hold` makes
    /// the segment after it a step.
    pub fn point_upsert(&mut self, h: u32, lane: u32, pos: i64, value: f32, hold: bool) {
        if !value.is_finite() {
            return;
        }
        let old = self.points.insert(h, Point { lane, p: LanePoint { pos, value: value.clamp(0.0, 1.0), hold } });
        if let Some(o) = old.filter(|o| o.lane != lane) {
            self.rebuild_lane_points(o.lane);
        }
        self.rebuild_lane_points(lane);
    }

    pub fn point_remove(&mut self, h: u32) {
        if let Some(p) = self.points.remove(h) {
            self.rebuild_lane_points(p.lane);
        }
    }

    /// Refill a lane's sorted point list (equal positions keep handle order). Allocation is fine here.
    fn rebuild_lane_points(&mut self, lane: u32) {
        let Engine { lanes, points, .. } = self;
        let Some(l) = lanes.get_mut(lane) else { return };
        l.points.clear();
        l.points.extend(points.values().filter(|p| p.lane == lane).map(|p| p.p));
        l.points.sort_by_key(|p| p.pos);
    }

    // ---- previews -------------------------------------------------------------------------

    /// Create a preview transport on a soundscape track (`mode` 0 source, 1 loops), or retarget
    /// an existing one without disturbing its position.
    pub fn preview_upsert(&mut self, h: u32, track: u32, mode: u32) {
        let mode = if mode == 1 { PreviewMode::Loops } else { PreviewMode::Source };
        match self.previews.get_mut(h) {
            Some(p) => (p.track, p.mode) = (track, mode),
            None => {
                self.previews.insert(h, Preview { track, mode, transport: Transport::default(), started: 0 });
            }
        }
    }

    pub fn preview_remove(&mut self, h: u32) {
        self.previews.remove(h);
    }

    pub fn preview_play(&mut self, h: u32, from: i64) {
        if let Some(p) = self.previews.get_mut(h) {
            p.transport.play(from);
            p.started = from;
        }
    }

    pub fn preview_stop(&mut self, h: u32) {
        if let Some(p) = self.previews.get_mut(h) {
            p.transport.stop();
        }
    }

    pub fn preview_seek(&mut self, h: u32, pos: i64) {
        if let Some(p) = self.previews.get_mut(h) {
            p.transport.seek(pos);
            p.started = pos;
        }
    }

    pub fn preview_position(&self, h: u32) -> i64 {
        self.previews.get(h).map_or(0, |p| p.transport.position)
    }

    pub fn preview_is_playing(&self, h: u32) -> bool {
        self.previews.get(h).is_some_and(|p| p.transport.playing)
    }

    // ---- devices --------------------------------------------------------------------------

    pub fn device_upsert(&mut self, h: u32, track: u32, kind: u32, order: f64, bypass: bool) {
        let order = if order.is_finite() { order } else { 0.0 };
        match self.devices.get_mut(h) {
            // Same kind: update placement and bypass, keep params and state.
            Some(d) if d.kind_id == kind => {
                if bypass && !d.bypass {
                    d.reset_state();
                }
                (d.track, d.order, d.bypass) = (track, order, bypass);
            }
            // New handle, or the kind changed: start from defaults.
            _ => {
                let keys = self.devices.get(h).map(|d| (d.key_lo, d.key_hi));
                let mut d = Device::new(track, kind, order, bypass, self.sample_rate);
                if let Some((lo, hi)) = keys {
                    (d.key_lo, d.key_hi) = (lo, hi); // a kind change resets the sound, not the note range
                }
                self.devices.insert(h, d);
            }
        }
        self.rebuild_routing();
    }

    pub fn device_remove(&mut self, h: u32) {
        self.devices.remove(h);
        self.rebuild_routing();
    }

    /// An instrument's note range, MIDI pitches `lo..=hi` (clamped to 0..127; `hi` below `lo` is
    /// raised to `lo`). Unknown devices are ignored. It is not a param: not smoothed or automated.
    pub fn device_keys(&mut self, h: u32, lo: u32, hi: u32) {
        if let Some(d) = self.devices.get_mut(h) {
            d.key_lo = lo.min(127);
            d.key_hi = hi.min(127).max(d.key_lo);
        }
    }

    pub fn param_set(&mut self, device: u32, param: u32, value: f32) {
        if let Some(d) = self.devices.get_mut(device) {
            d.set_param(param, value);
        }
    }

    /// Recompute the derived routing: each track's device chain (sorted by `order`, ties by
    /// handle) with its lanes, its MIDI clips and its audio clips (as a tape in handle order, and
    /// as a start-sorted list for playback), plus the looper lanes and pad gates. Chains and clip
    /// lists hold *dense indices* into the entity maps, which shift on every insert or remove of
    /// a device, clip, lane or track, so every such command must end here. Allocation is
    /// allowed here; this is never called from `process`.
    fn rebuild_routing(&mut self) {
        let Engine { tracks, devices, clips, loopers, pads, master_chain, lanes, tape_refs, meters, .. } = self;
        meters.resize(2 + 3 * tracks.len(), 0.0);
        master_chain.clear();
        for t in tracks.values_mut() {
            t.chain.clear();
            t.midi_clips.clear();
            t.audio_clips.clear();
            t.play.clear();
            t.play_max_end.clear();
        }
        for (i, (_, d)) in devices.iter().enumerate() {
            let slot = Slot { dev: i as u32, instrument: d.is_instrument(), lanes: Vec::new() };
            if d.track == MASTER_TRACK {
                master_chain.push(slot);
            } else if let Some(t) = tracks.get_mut(d.track) {
                t.chain.push(slot);
            }
        }
        for (i, (h, c)) in clips.iter().enumerate() {
            match c {
                Clip::Midi(m) => {
                    if let Some(t) = tracks.get_mut(m.track) {
                        t.midi_clips.push((i as u32, h));
                    }
                }
                Clip::Audio(a) => {
                    if let Some(t) = tracks.get_mut(a.track) {
                        t.audio_clips.push(i as u32);
                        if a.length > 0 {
                            t.play.push(ClipSpan { start: a.start, end: a.start.saturating_add(a.length), idx: i as u32 });
                        }
                    }
                }
            }
        }
        tape_refs.clear();
        tape_refs.reserve(clips.len());
        for t in tracks.values_mut() {
            // `idx` order is handle order, so a start tie keeps the handle order.
            t.play.sort_unstable_by_key(|c| (c.start, c.idx));
            let mut m = i64::MIN;
            for c in &t.play {
                m = m.max(c.end);
                t.play_max_end.push(m);
            }
        }
        for l in loopers.values_mut() {
            l.gates.clear();
            l.auto = [NO_LANE; LOOPER_PARAMS];
        }
        for p in pads.values().filter(|p| p.length > 0) {
            for l in loopers.values_mut().filter(|l| l.track == p.track) {
                l.gates.push((p.start, p.start + p.length));
            }
        }
        for l in loopers.values_mut() {
            l.gates.sort_unstable();
            l.max_end.clear();
            let mut m = i64::MIN;
            for &(_, e) in &l.gates {
                m = m.max(e);
                l.max_end.push(m);
            }
        }
        let by_order = |a: &Slot, b: &Slot| {
            let (da, db) = (devices.get_index(a.dev as usize).order, devices.get_index(b.dev as usize).order);
            da.total_cmp(&db).then(devices.handle_at(a.dev as usize).cmp(&devices.handle_at(b.dev as usize)))
        };
        for t in tracks.values_mut() {
            t.chain.sort_unstable_by(by_order);
        }
        master_chain.sort_unstable_by(by_order);
        for (li, (h, l)) in lanes.iter().enumerate().filter(|(_, (_, l))| l.enabled) {
            match l.kind {
                LANE_DEVICE => {
                    let Some(di) = devices.index_of(l.target) else { continue };
                    let d = devices.get_index(di);
                    let chain = if d.track == MASTER_TRACK {
                        Some(&mut *master_chain)
                    } else {
                        tracks.get_mut(d.track).map(|t| &mut t.chain)
                    };
                    if let Some(slot) = chain.and_then(|c| c.iter_mut().find(|s| s.dev as usize == di)) {
                        slot.lanes.push(li as u32);
                    }
                }
                LANE_LOOPER => {
                    if let Some(lp) = loopers.get_mut(l.target).filter(|_| (l.param as usize) < LOOPER_PARAMS) {
                        lp.auto[l.param as usize] = h;
                    }
                }
                _ => {}
            }
        }
    }

    // ---- M1 test voice --------------------------------------------------------------------

    pub fn set_param(&mut self, id: u32, value: f32) {
        self.voice.set_param(id, value);
    }

    // ---- rendering ------------------------------------------------------------------------

    /// Turn the sleep optimisation (skipping silent tracks' idle devices) on or off. Rendered
    /// audio is the same either way; this exists for tests.
    pub fn set_sleep(&mut self, on: bool) {
        self.sleep = on;
    }

    /// How many track-blocks sleep has skipped so far.
    pub fn sleep_skips(&self) -> u64 {
        self.sleep_skips
    }

    /// Render `frames` (<= 128) into the output buffer. Never allocates. With the cycle on, a block that reaches its end
    /// is rendered in pieces: up to `end`, then on from `start` (as often as the block crosses it).
    pub fn process(&mut self, frames: usize) {
        let n = frames.min(BLOCK);
        self.out.fill(0.0);
        let mut off = 0;
        while off < n {
            let mut m = n - off;
            let p = self.main.position;
            let wrap = match self.cycle {
                Some((start, end)) if self.main.playing && p < end && p + m as i64 >= end => {
                    m = (end - p) as usize;
                    Some(start)
                }
                _ => None,
            };
            self.render(off, m);
            off += m;
            if let Some(start) = wrap {
                self.wrap_to(start);
            }
        }
    }

    /// Render `n` frames from the current position into `out[off..off + n]` (both channels), adding the meters' peaks.
    fn render(&mut self, off: usize, n: usize) {
        let p = self.main.position;
        let playing = self.main.playing;
        let sr = self.sr;
        let sr32 = self.sample_rate;
        let smooth = self.smooth_samples;
        let Engine { out, tracks, clips, sources, devices, loopers, previews, note_index, voice, master_chain, lanes, input, monitor, monitor_gain, monitor_track, tape_refs, sleep, sleep_skips, master_peak, .. } = self;
        let (out_l, out_r) = out.split_at_mut(BLOCK);
        let (out_l, out_r) = (&mut out_l[off..off + n], &mut out_r[off..off + n]);

        // 1. Mute/solo/gain/pan targets. Solo: if any track is soloed, the rest are silent.
        //    Mute always wins. Silence is a gain target of 0, so it ramps over 10 ms.
        let any_solo = tracks.values().any(|t| t.soloed);
        for t in tracks.values_mut() {
            let audible = !t.muted && (!any_solo || t.soloed || t.solo_safe);
            let g = if audible { t.gain } else { 0.0 };
            let (pl, pr) = equal_power(t.pan);
            let (tl, tr) = ((g * pl) as f64, (g * pr) as f64);
            if t.fresh {
                t.fresh = false;
                t.gain_l.set_target(tl, 1.0);
                t.gain_l.snap();
                t.gain_r.set_target(tr, 1.0);
                t.gain_r.snap();
            } else {
                if t.gain_l.target() != tl {
                    t.gain_l.set_target(tl, smooth);
                }
                if t.gain_r.target() != tr {
                    t.gain_r.set_target(tr, smooth);
                }
            }
            t.scratch.fill(0.0);
            t.has_audio = false;
        }

        // 2. Audio clips into their tracks' scratch (summed where they overlap). Each track's clips
        //    are sorted by start, so the ones touching this block are found by binary search, and
        //    overlapping ones sum in `(start, handle)` order.
        if playing {
            let end = p + n as i64;
            for t in tracks.values_mut() {
                let Track { play, play_max_end, scratch, has_audio, soundscape, .. } = t;
                if *soundscape || play.is_empty() {
                    continue; // looper tracks never play their clips linearly
                }
                let lo = play_max_end.partition_point(|&e| e <= p);
                let hi = play.partition_point(|c| c.start < end).max(lo);
                for c in &play[lo..hi] {
                    if c.end <= p {
                        continue;
                    }
                    let Clip::Audio(a) = clips.get_index(c.idx as usize) else { continue };
                    let Some(src) = sources.get(a.source).filter(|s| s.is_ready()) else { continue };
                    let (l, r) = scratch.split_at_mut(BLOCK);
                    a.render_add(src, p, &mut l[..n], &mut r[..n]);
                    *has_audio = true;
                }
            }
        }

        // 1b. Looper lanes replace the static values: the level ramps to its value at the end of
        //     the block, the rest take the value at the start (and keep their own glides).
        let ahead = if playing { p + n as i64 } else { p };
        for (_, lp) in loopers.iter_mut() {
            if lp.auto == [NO_LANE; LOOPER_PARAMS] {
                continue;
            }
            if let Some(v) = lane_value(lanes, lp.auto[LOOPER_GAIN as usize], ahead) {
                lp.gain = if lp.muted { 0.0 } else { (v as f32).clamp(0.0, 2.0) };
            }
            if let Some(v) = lane_value(lanes, lp.auto[LOOPER_SPEED as usize], p) {
                lp.params.speed = v.clamp(LOOP_SPEED.0, LOOP_SPEED.1);
            }
            if let Some(v) = lane_value(lanes, lp.auto[LOOPER_WARBLE as usize], p) {
                lp.params.warble = v.clamp(0.0, 1.0);
            }
            let drive = lane_value(lanes, lp.auto[LOOPER_SAT as usize], p);
            let cutoff = lane_value(lanes, lp.auto[LOOPER_CUTOFF as usize], p);
            if drive.is_some() || cutoff.is_some() {
                lp.color.set(drive.map_or(lp.drive, |v| v as f32), cutoff.map_or(lp.cutoff, |v| v as f32), sr, false);
            }
        }

        for (_, lp) in loopers.iter_mut() {
            lp.head = -1.0;
        }

        // 2b. Loopers read their track's source clips as a tape, but only while one of their
        //     pads is on. A pad opening (or a seek) triggers the loops from their region start; a
        //     speed change is smoothed live (see dsp::looper).
        if playing {
            let wend = p + n as i64;
            let fade = sr * PAD_FADE_MS * 1e-3;
            for (_, lp) in loopers.iter_mut() {
                let Some(Track { scratch, audio_clips, has_audio, soundscape: true, .. }) = tracks.get_mut(lp.track) else { continue };
                if lp.params.length < MIN_LENGTH || lp.gates.is_empty() {
                    continue;
                }
                let (sl, sr_buf) = scratch.split_at_mut(BLOCK);
                fill_tape(tape_refs, audio_clips, clips, sources);
                let mut tape = |i| tape_at(tape_refs, clips, sources, i);
                let mut t = p;
                while t < wend {
                    let (gate, seg_end) = lp.gate_at(t, wend);
                    let Some((gs, ge)) = gate else {
                        t = seg_end;
                        continue;
                    };
                    let m = (seg_end - t) as usize;
                    let (mut tl, mut tr) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
                    // the pad's start identifies the trigger: a new pad restarts the loops
                    lp.voice.render_add(&lp.params, gs, t, &mut tape, &mut tl[..m], &mut tr[..m]);
                    lp.color.process(&mut tl[..m], &mut tr[..m], sr);
                    for j in 0..m {
                        let k = t - gs + j as i64;
                        let at = (t - p) as usize + j;
                        let g = clip_edge_gain(k, ge - gs, fade, fade, FadeShape::EqualPower) * lp.mix_at(at, n);
                        sl[at] += tl[j] * g;
                        sr_buf[at] += tr[j] * g;
                    }
                    lp.head = lp.voice.head().unwrap_or(-1.0);
                    *has_audio = true;
                    t = seg_end;
                }
            }
        }

        // 2c. Previews: a soundscape's source tape or its loops, on a private transport. They add
        //     into the track's scratch like anything else, so the track's chain, gain, pan, mute
        //     and solo all apply.
        for (_, pv) in previews.iter_mut() {
            if !pv.transport.playing {
                continue;
            }
            let Some(Track { scratch, audio_clips, has_audio, soundscape: true, .. }) = tracks.get_mut(pv.track) else { continue };
            let (sl, sr_buf) = scratch.split_at_mut(BLOCK);
            let fade = sr * PAD_FADE_MS * 1e-3;
            let pos = pv.transport.position;
            let gain = |j: usize| fade_in_gain(FadeShape::EqualPower, ((pos - pv.started) + j as i64) as f64 / fade);
            fill_tape(tape_refs, audio_clips, clips, sources);
            let mut tape = |i| tape_at(tape_refs, clips, sources, i);
            match pv.mode {
                PreviewMode::Source => {
                    for j in 0..n {
                        let (a, b) = tape(pos + j as i64);
                        let g = gain(j);
                        sl[j] += a * g;
                        sr_buf[j] += b * g;
                    }
                    *has_audio = true;
                }
                PreviewMode::Loops => {
                    for (_, lp) in loopers.iter_mut() {
                        if lp.track != pv.track || lp.params.length < MIN_LENGTH {
                            continue;
                        }
                        let (mut tl, mut tr) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
                        // each play or seek of the preview is a new trigger
                        lp.pvoice.render_add(&lp.params, pv.started, pos, &mut tape, &mut tl[..n], &mut tr[..n]);
                        lp.color.process(&mut tl[..n], &mut tr[..n], sr);
                        for j in 0..n {
                            let g = gain(j) * lp.mix_at(j, n);
                            sl[j] += tl[j] * g;
                            sr_buf[j] += tr[j] * g;
                        }
                        lp.head = lp.pvoice.head().unwrap_or(-1.0);
                        *has_audio = true;
                    }
                }
            }
        }
        for (_, lp) in loopers.iter_mut() {
            lp.gain_now = lp.gain; // every block ramps from where the last one ended
        }

        // 2d. Input monitoring: the live input joins the monitored track's scratch, so its chain,
        //     gain, pan, mute and solo all apply. A change of track (or of on/off) fades over 10 ms.
        if *monitor_track != *monitor && monitor_gain.value() == 0.0 {
            *monitor_track = *monitor;
        }
        let want = if monitor_track.is_some() && *monitor_track == *monitor { 1.0 } else { 0.0 };
        if monitor_gain.target() != want {
            monitor_gain.set_target(want, smooth);
        }
        if let Some(t) = monitor_track.and_then(|h| tracks.get_mut(h)) {
            let (g0, g1) = (monitor_gain.value() as f32, monitor_gain.advance(n) as f32);
            if g0 != 0.0 || g1 != 0.0 {
                let d = (g1 - g0) / n as f32;
                let (sl, sr_buf) = t.scratch.split_at_mut(BLOCK);
                for j in 0..n {
                    let g = g0 + d * (j + 1) as f32;
                    sl[j] += input[off + j] * g;
                    sr_buf[j] += input[BLOCK + off + j] * g;
                }
                t.has_audio = true;
            }
        } else {
            monitor_gain.advance(n);
        }

        // 3. Per track: instruments in control segments, then the effects over the whole block,
        //    then gain/pan into the master sum.
        for t in tracks.values_mut() {
            if t.chain.is_empty() && !t.has_audio {
                t.gain_l.advance(n);
                t.gain_r.advance(n);
                continue;
            }
            let (sl, sr_buf) = t.scratch.split_at_mut(BLOCK);
            let (sl, sr_buf) = (&mut sl[..n], &mut sr_buf[..n]);

            // Instruments run in segments of at most 32 frames. MIDI notes go to every sounding
            // instrument whose note range holds the pitch: release due voices, fire the notes
            // starting exactly at the segment start, and split the segment at the next note-on /
            // scheduled release and at the instruments' own lane breakpoints.
            if t.chain.iter().any(|s| s.instrument) {
                let mut i = 0;
                while i < n {
                    let at = p + i as i64;
                    let mut end = (i + SUB_BLOCK).min(n);
                    let mut next = i64::MAX;
                    for s in t.chain.iter().filter(|s| s.instrument) {
                        let d = devices.get_index_mut(s.dev as usize);
                        if !d.bypass {
                            d.release_due(at);
                            next = next.min(d.next_release_after(at));
                        }
                    }
                    if playing {
                        for &(ci, ch) in &t.midi_clips {
                            if let Clip::Midi(mc) = clips.get_index(ci as usize) {
                                let notes = clip_notes(note_index, ch);
                                mc.fire_at(notes, at, sr, &mut |pitch, vel, off, start| {
                                    for s in &t.chain {
                                        let d = devices.get_index_mut(s.dev as usize);
                                        if d.takes_note(pitch) {
                                            d.note_on(pitch, vel, off, start);
                                        }
                                    }
                                });
                                next = next.min(mc.next_note_on_after(notes, at, sr));
                            }
                        }
                    }
                    // `next > at`, so the segment always makes progress.
                    if next < p + end as i64 {
                        end = (next - p) as usize;
                    }
                    for s in t.chain.iter().filter(|s| s.instrument) {
                        if !devices.get_index(s.dev as usize).bypass {
                            end = lane_limit(s, lanes, p, i, n, end);
                        }
                    }
                    for s in t.chain.iter().filter(|s| s.instrument) {
                        let d = devices.get_index_mut(s.dev as usize);
                        if !d.bypass {
                            for &li in &s.lanes {
                                apply_lane(d, lanes.get_index(li as usize), at, end - i, playing);
                            }
                            if *sleep && d.is_idle_instrument() {
                                continue;
                            }
                            d.process(&mut sl[i..end], &mut sr_buf[i..end], sr32);
                        }
                    }
                    i = end;
                }
            }

            // Asleep: every effect is provably silent on zero input and the buffer is all zero, so
            // the chain would output zeros and (up to -120 dB tails) change nothing. Skip it and
            // the gain loop; the gain ramps still advance.
            if *sleep
                && t.chain.iter().filter(|s| !s.instrument).all(|s| s.lanes.is_empty() && devices.get_index(s.dev as usize).is_asleep())
                && sl.iter().chain(sr_buf.iter()).all(|&x| x == 0.0)
            {
                for s in t.chain.iter().filter(|s| !s.instrument) {
                    devices.get_index_mut(s.dev as usize).skip(n, sr32);
                }
                t.gain_l.advance(n);
                t.gain_r.advance(n);
                *sleep_skips += 1;
                continue;
            }

            // Effects in `order`, each over the whole block (split only at its own lanes' breakpoints).
            for s in t.chain.iter().filter(|s| !s.instrument) {
                run_device(s, devices, lanes, p, playing, sl, sr_buf, sr32);
            }

            // Gain/pan: a linear ramp across the block between the smoothed values at its edges,
            // in closed form (`g0 + dg * (j + 1)`), so the loops are independent per sample.
            let (l0, r0) = (t.gain_l.value() as f32, t.gain_r.value() as f32);
            let (l1, r1) = (t.gain_l.advance(n) as f32, t.gain_r.advance(n) as f32);
            let (dl, dr) = ((l1 - l0) / n as f32, (r1 - r0) / n as f32);
            // The meter's peak rides along: an integer max of the `|v|` bits, which vectorizes (a float max reduction
            // would not without fast-math).
            let (mut pl, mut pr) = (t.peak[0], t.peak[1]);
            for (j, (o, x)) in out_l.iter_mut().zip(sl.iter()).enumerate() {
                let v = *x * (l0 + dl * (j as u32 + 1) as f32);
                *o += v;
                pl = pl.max(v.to_bits() & 0x7fff_ffff);
            }
            for (j, (o, x)) in out_r.iter_mut().zip(sr_buf.iter()).enumerate() {
                let v = *x * (r0 + dr * (j as u32 + 1) as f32);
                *o += v;
                pr = pr.max(v.to_bits() & 0x7fff_ffff);
            }
            t.peak = [pl, pr];
        }

        // 3b. The global fx chain, over everything the tracks summed.
        for s in master_chain.iter() {
            run_device(s, devices, lanes, p, playing, out_l, out_r, sr32);
        }

        // 4. Test voice, the master meter and the transport.
        if voice.is_active() {
            voice.process(out_l, out_r);
        }
        let peak = |x: &[f32], m: u32| x.iter().fold(m, |m, v| m.max(v.to_bits() & 0x7fff_ffff));
        *master_peak = [peak(out_l, master_peak[0]), peak(out_r, master_peak[1])];
        self.main.advance(n);
        for pv in previews.values_mut() {
            pv.transport.advance(n);
        }
    }
}
