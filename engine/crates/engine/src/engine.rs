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

use crate::clip::{clip_notes, AudioClip, Clip, MidiClip, NoteEntry};
use crate::device::{Device, DeviceKind};
use crate::handle_map::HandleMap;
use crate::source::Source;
use crate::test_voice::TestVoice;
use dsp::finnwave::SUB_BLOCK;
use dsp::pan::equal_power;
use dsp::{FadeShape, Ramp};
use std::cmp::Ordering;

/// The Web Audio render quantum.
pub const BLOCK: usize = 128;

pub const MAX_TRACKS: usize = 256;
pub const MAX_CLIPS: usize = 4096;
pub const MAX_NOTES: usize = 65536;
pub const MAX_DEVICES: usize = 1024;
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
}

pub struct Engine {
    /// Planar stereo: left in `out[0..BLOCK]`, right in `out[BLOCK..2*BLOCK]`.
    out: [f32; 2 * BLOCK],
    sample_rate: f32,
    sr: f64,
    smooth_samples: f64,
    playing: bool,
    position: i64,
    sources: HandleMap<Source>,
    tracks: HandleMap<Track>,
    clips: HandleMap<Clip>,
    devices: HandleMap<Device>,
    note_keys: HandleMap<(u32, f64)>,
    note_index: Vec<NoteEntry>,
    voice: TestVoice,
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
            playing: false,
            position: 0,
            sources: HandleMap::with_capacity(256),
            tracks: HandleMap::with_capacity(MAX_TRACKS),
            clips: HandleMap::with_capacity(MAX_CLIPS),
            devices: HandleMap::with_capacity(MAX_DEVICES),
            note_keys: HandleMap::with_capacity(MAX_NOTES),
            note_index: Vec::with_capacity(MAX_NOTES),
            voice: TestVoice::new(sample_rate),
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
            if let DeviceKind::Synth(s) = &mut d.kind {
                s.release_all();
            }
        }
    }

    pub fn play(&mut self, from: i64) {
        self.release_all_voices();
        self.position = from;
        self.playing = true;
    }

    pub fn stop(&mut self) {
        self.release_all_voices();
        self.playing = false;
    }

    pub fn seek(&mut self, pos: i64) {
        self.release_all_voices();
        self.position = pos;
    }

    pub fn position(&self) -> i64 {
        self.position
    }

    pub fn is_playing(&self) -> bool {
        self.playing
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

    pub fn track_upsert(&mut self, h: u32, _kind: u32, gain: f32, pan: f32, muted: bool, soloed: bool) {
        let gain = if gain.is_finite() { gain.max(0.0) } else { 1.0 };
        let pan = if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { 0.0 };
        if let Some(t) = self.tracks.get_mut(h) {
            (t.gain, t.pan, t.muted, t.soloed) = (gain, pan, muted, soloed);
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
        let Engine { tracks, devices, clips, .. } = self;
        for t in tracks.values_mut() {
            t.chain.clear();
            t.midi_clips.clear();
        }
        for (h, d) in devices.iter() {
            if let Some(t) = tracks.get_mut(d.track) {
                t.chain.push(h);
            }
        }
        for (h, c) in clips.iter() {
            if let Clip::Midi(m) = c {
                if let Some(t) = tracks.get_mut(m.track) {
                    t.midi_clips.push(h);
                }
            }
        }
        for t in tracks.values_mut() {
            t.chain.sort_unstable_by(|a, b| {
                let (da, db) = (devices.get(*a).map_or(0.0, |d| d.order), devices.get(*b).map_or(0.0, |d| d.order));
                da.total_cmp(&db).then(a.cmp(b))
            });
        }
    }

    // ---- M1 test voice --------------------------------------------------------------------

    pub fn set_param(&mut self, id: u32, value: f32) {
        self.voice.set_param(id, value);
    }

    // ---- rendering ------------------------------------------------------------------------

    /// Render `frames` (<= 128) into the output buffer. Never allocates.
    pub fn process(&mut self, frames: usize) {
        let n = frames.min(BLOCK);
        let p = self.position;
        let playing = self.playing;
        let sr = self.sr;
        let sr32 = self.sample_rate;
        let smooth = self.smooth_samples;
        let Engine { out, tracks, clips, sources, devices, note_index, voice, .. } = self;
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
                if !src.is_ready() {
                    continue;
                }
                let (l, r) = t.scratch.split_at_mut(BLOCK);
                a.render_add(src, p, &mut l[..n], &mut r[..n]);
                t.has_audio = true;
            }
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

        // 4. Test voice and transport.
        if voice.is_active() {
            voice.process(&mut out_l[..n], &mut out_r[..n]);
        }
        if playing {
            self.position += n as i64;
        }
    }
}
