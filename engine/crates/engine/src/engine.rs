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
//!    at the next note-on and the next scheduled note-off of the track's instrument. At each
//!    segment start: release due voices, fire notes starting exactly there. Then run the
//!    device chain over the segment and add the result, scaled by the ramped gain/pan, into
//!    the master output.
//! 4. Mix in the M1 test voice if its gate is on; advance the transport.
//!
//! # Automation
//! A [`Lane`] drives one param (a device's, or a looper's) from keyframes in *timeline* time; while
//! it is enabled it replaces the param's static value. Points are normalised (0..1 along the
//! param's own scale), so the curve between two of them is exactly what the editor draws, even
//! for a log-scaled cutoff. Device lanes are evaluated at the start of every control segment, and
//! segments are split at breakpoints, so a corner is sample-exact and the value is applied with no
//! glide (`Device::set_param_auto`). Looper lanes are evaluated once per block: the level ramps
//! linearly to the lane's value at the block's end, the rest (speed, warble, saturation, filter)
//! take its value at the block's start and keep their own, short glides. Lanes follow the
//! timeline position, stopped or not.

use crate::clip::{clip_notes, AudioClip, Clip, MidiClip, NoteEntry};
use crate::device::{Device, DeviceKind};
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
    /// New tracks snap to their first target instead of ramping up from silence.
    fresh: bool,
    /// Linear ramps of the final per-channel coefficient `gain * pan_law * audible`.
    gain_l: Ramp,
    gain_r: Ramp,
    /// Preallocated planar stereo scratch: `BLOCK` left, then `BLOCK` right.
    scratch: Vec<f32>,
    /// Set when a clip wrote into `scratch` this block.
    has_audio: bool,
    /// Device handles in ascending `order` (derived).
    chain: Vec<u32>,
    /// MIDI clip handles on this track (derived).
    midi_clips: Vec<u32>,
    /// Audio clip handles on this track (derived); the tape a looper track reads from.
    audio_clips: Vec<u32>,
    /// Soundscape track: its clips are the *source* tape the loopers read (in source time),
    /// never played linearly.
    soundscape: bool,
    /// Enabled lanes driving this track's devices (derived).
    dev_lanes: Vec<u32>,
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
        let t = self.norm_at(pos)?.clamp(0.0, 1.0);
        Some(match self.scale {
            Scale::Log if self.min > 0.0 => self.min * (self.max / self.min).powf(t),
            Scale::Pow => self.min + (self.max - self.min) * t * t * t,
            _ => self.min + (self.max - self.min) * t,
        })
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

/// The track's clips summed at timeline sample `i`.
fn tape_at(handles: &[u32], clips: &HandleMap<Clip>, sources: &HandleMap<Source>, i: i64) -> (f32, f32) {
    let (mut l, mut r) = (0.0, 0.0);
    for h in handles {
        if let Some(Clip::Audio(a)) = clips.get(*h) {
            if let Some(src) = sources.get(a.source).filter(|s| s.is_ready()) {
                let (x, y) = a.sample_at(src, i);
                l += x;
                r += y;
            }
        }
    }
    (l, r)
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
    /// Device handles on the master bus in ascending `order` (derived).
    master_chain: Vec<u32>,
    /// Enabled lanes driving master-chain devices (derived).
    master_lanes: Vec<u32>,
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
            master_lanes: Vec::new(),
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
            if let DeviceKind::Synth(s) = &mut d.kind {
                s.release_all();
            }
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

    pub fn track_upsert(&mut self, h: u32, kind: u32, gain: f32, pan: f32, muted: bool, soloed: bool) {
        let gain = if gain.is_finite() { gain.max(0.0) } else { 1.0 };
        let pan = if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { 0.0 };
        if let Some(t) = self.tracks.get_mut(h) {
            (t.gain, t.pan, t.muted, t.soloed) = (gain, pan, muted, soloed);
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
                fresh: true,
                gain_l: Ramp::new(0.0),
                gain_r: Ramp::new(0.0),
                scratch: vec![0.0; 2 * BLOCK],
                has_audio: false,
                chain: Vec::new(),
                midi_clips: Vec::new(),
                audio_clips: Vec::new(),
                soundscape: kind == KIND_SOUNDSCAPE,
                dev_lanes: Vec::new(),
            },
        );
        self.rebuild_routing();
    }

    pub fn track_remove(&mut self, h: u32) {
        self.tracks.remove(h);
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
    ) {
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
            }),
        );
        self.rebuild_routing();
    }

    pub fn clip_midi_upsert(&mut self, h: u32, track: u32, start: i64, bpm: f64, ppq: u32, length_ticks: f64) {
        self.clips.insert(h, Clip::Midi(MidiClip { track, start, bpm, ppq, length_ticks }));
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
                self.devices.insert(h, Device::new(track, kind, order, bypass, self.sample_rate));
            }
        }
        self.rebuild_routing();
    }

    pub fn device_remove(&mut self, h: u32) {
        self.devices.remove(h);
        self.rebuild_routing();
    }

    pub fn param_set(&mut self, device: u32, param: u32, value: f32) {
        if let Some(d) = self.devices.get_mut(device) {
            d.set_param(param, value);
        }
    }

    /// Recompute each track's device chain (sorted by `order`, ties by handle) and MIDI clip
    /// list. Allocation is allowed here; this is never called from `process`.
    fn rebuild_routing(&mut self) {
        let Engine { tracks, devices, clips, loopers, pads, master_chain, master_lanes, lanes, .. } = self;
        master_chain.clear();
        master_lanes.clear();
        for t in tracks.values_mut() {
            t.dev_lanes.clear();
            t.chain.clear();
            t.midi_clips.clear();
            t.audio_clips.clear();
        }
        for (h, d) in devices.iter() {
            if d.track == MASTER_TRACK {
                master_chain.push(h);
            } else if let Some(t) = tracks.get_mut(d.track) {
                t.chain.push(h);
            }
        }
        for (h, c) in clips.iter() {
            match c {
                Clip::Midi(m) => {
                    if let Some(t) = tracks.get_mut(m.track) {
                        t.midi_clips.push(h);
                    }
                }
                Clip::Audio(a) => {
                    if let Some(t) = tracks.get_mut(a.track) {
                        t.audio_clips.push(h);
                    }
                }
            }
        }
        for l in loopers.values_mut() {
            l.gates.clear();
            l.auto = [NO_LANE; LOOPER_PARAMS];
        }
        for (h, l) in lanes.iter().filter(|(_, l)| l.enabled) {
            match l.kind {
                LANE_DEVICE => match devices.get(l.target) {
                    Some(d) if d.track == MASTER_TRACK => master_lanes.push(h),
                    Some(d) => {
                        if let Some(t) = tracks.get_mut(d.track) {
                            t.dev_lanes.push(h);
                        }
                    }
                    None => {}
                },
                LANE_LOOPER => {
                    if let Some(lp) = loopers.get_mut(l.target).filter(|_| (l.param as usize) < LOOPER_PARAMS) {
                        lp.auto[l.param as usize] = h;
                    }
                }
                _ => {}
            }
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
        let by_order = |a: &u32, b: &u32| {
            let (da, db) = (devices.get(*a).map_or(0.0, |d| d.order), devices.get(*b).map_or(0.0, |d| d.order));
            da.total_cmp(&db).then(a.cmp(b))
        };
        for t in tracks.values_mut() {
            t.chain.sort_unstable_by(by_order);
        }
        master_chain.sort_unstable_by(by_order);
    }

    // ---- M1 test voice --------------------------------------------------------------------

    pub fn set_param(&mut self, id: u32, value: f32) {
        self.voice.set_param(id, value);
    }

    // ---- rendering ------------------------------------------------------------------------

    /// Render `frames` (<= 128) into the output buffer. Never allocates.
    pub fn process(&mut self, frames: usize) {
        let n = frames.min(BLOCK);
        let p = self.main.position;
        let playing = self.main.playing;
        let sr = self.sr;
        let sr32 = self.sample_rate;
        let smooth = self.smooth_samples;
        let Engine { out, tracks, clips, sources, devices, loopers, previews, note_index, voice, master_chain, master_lanes, lanes, input, monitor, monitor_gain, monitor_track, .. } = self;
        out.fill(0.0);
        let (out_l, out_r) = out.split_at_mut(BLOCK);

        // 1. Mute/solo/gain/pan targets. Solo: if any track is soloed, the rest are silent.
        //    Mute always wins. Silence is a gain target of 0, so it ramps over 10 ms.
        let any_solo = tracks.values().any(|t| t.soloed);
        for t in tracks.values_mut() {
            let audible = !t.muted && (!any_solo || t.soloed);
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

        // 2. Audio clips into their tracks' scratch (summed where they overlap).
        if playing {
            for (_, c) in clips.iter() {
                let Clip::Audio(a) = c else { continue };
                if a.length <= 0 || a.start + a.length <= p || a.start >= p + n as i64 {
                    continue;
                }
                let (Some(t), Some(src)) = (tracks.get_mut(a.track), sources.get(a.source)) else { continue };
                if !src.is_ready() || t.soundscape {
                    continue; // looper tracks never play their clips linearly
                }
                let (l, r) = t.scratch.split_at_mut(BLOCK);
                a.render_add(src, p, &mut l[..n], &mut r[..n]);
                t.has_audio = true;
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
                let mut tape = |i| tape_at(audio_clips, clips, sources, i);
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
            let mut tape = |i| tape_at(audio_clips, clips, sources, i);
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
                    sl[j] += input[j] * g;
                    sr_buf[j] += input[BLOCK + j] * g;
                }
                t.has_audio = true;
            }
        } else {
            monitor_gain.advance(n);
        }

        // 3. Per track: control segments, device chain, gain/pan, master sum.
        for t in tracks.values_mut() {
            if t.chain.is_empty() && !t.has_audio {
                t.gain_l.advance(n);
                t.gain_r.advance(n);
                continue;
            }
            // MIDI events go to the first instrument in the chain.
            let instrument = t.chain.iter().copied().find(|h| devices.get(*h).is_some_and(|d| d.is_instrument()));
            let (sl, sr_buf) = t.scratch.split_at_mut(BLOCK);
            let mut i = 0;
            while i < n {
                let at = p + i as i64;
                let mut end = (i + SUB_BLOCK).min(n);

                if let Some(Device { bypass: false, kind: DeviceKind::Synth(synth), .. }) =
                    instrument.and_then(|h| devices.get_mut(h))
                {
                    synth.release_due(at);
                    let mut next = synth.next_release_after(at);
                    if playing {
                        for &ch in &t.midi_clips {
                            if let Some(Clip::Midi(mc)) = clips.get(ch) {
                                let notes = clip_notes(note_index, ch);
                                mc.fire_at(notes, at, sr, synth);
                                next = next.min(mc.next_note_on_after(notes, at, sr));
                            }
                        }
                    }
                    // `next > at`, so the segment always makes progress.
                    if next < p + end as i64 {
                        end = (next - p) as usize;
                    }
                }

                // Automated device params: the value at the segment start, which ends at the next breakpoint.
                for &lh in &t.dev_lanes {
                    let Some(lane) = lanes.get(lh) else { continue };
                    if let (Some(v), Some(d)) = (lane.value_at(at), devices.get_mut(lane.target)) {
                        d.set_param_auto(lane.param, v as f32);
                    }
                    end = end.min(lane.next_break(at).saturating_sub(p).clamp(i as i64 + 1, n as i64) as usize);
                }

                let (l, r) = (&mut sl[i..end], &mut sr_buf[i..end]);
                for dh in &t.chain {
                    if let Some(d) = devices.get_mut(*dh) {
                        d.process(l, r, sr32);
                    }
                }

                // Gain/pan: ramp per sample between the smoothed values at the segment edges.
                let len = end - i;
                let (l0, r0) = (t.gain_l.value() as f32, t.gain_r.value() as f32);
                let (l1, r1) = (t.gain_l.advance(len) as f32, t.gain_r.advance(len) as f32);
                let (dl, dr) = ((l1 - l0) / len as f32, (r1 - r0) / len as f32);
                let (mut gl, mut gr) = (l0, r0);
                for j in 0..len {
                    gl += dl;
                    gr += dr;
                    out_l[i + j] += l[j] * gl;
                    out_r[i + j] += r[j] * gr;
                }
                i = end;
            }
        }

        // 3b. The global fx chain, over everything the tracks summed.
        let mut i = 0;
        while i < n {
            let at = p + i as i64;
            let mut end = (i + SUB_BLOCK).min(n);
            for &lh in master_lanes.iter() {
                let Some(lane) = lanes.get(lh) else { continue };
                if let (Some(v), Some(d)) = (lane.value_at(at), devices.get_mut(lane.target)) {
                    d.set_param_auto(lane.param, v as f32);
                }
                end = end.min(lane.next_break(at).saturating_sub(p).clamp(i as i64 + 1, n as i64) as usize);
            }
            for dh in master_chain.iter() {
                if let Some(d) = devices.get_mut(*dh) {
                    d.process(&mut out_l[i..end], &mut out_r[i..end], sr32);
                }
            }
            i = end;
        }

        // 4. Test voice and transport.
        if voice.is_active() {
            voice.process(&mut out_l[..n], &mut out_r[..n]);
        }
        self.main.advance(n);
        for pv in previews.values_mut() {
            pv.transport.advance(n);
        }
    }
}
