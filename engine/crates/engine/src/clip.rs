//! Audio and MIDI clips, and how they turn into samples and note events.

use crate::source::Source;
use dsp::fade::clip_edge_gain;
use dsp::{FadeShape, Synth};

pub enum Clip {
    Audio(AudioClip),
    Midi(MidiClip),
}

/// Plays source frames `[source_offset, source_offset + length)` at timeline
/// `[start, start + length)`. All positions are integer samples.
pub struct AudioClip {
    pub track: u32,
    pub source: u32,
    pub start: i64,
    pub length: i64,
    pub source_offset: i64,
    pub gain: f32,
    /// User fades in samples; the 64-sample declick floor is applied when rendering.
    pub fade_in: f64,
    pub fade_out: f64,
    pub shape: FadeShape,
}

impl AudioClip {
    /// Add this clip's contribution to the block starting at timeline sample `block_start`
    /// into `l` and `r` (both `block_len` long). Frames outside the source are silent.
    ///
    /// Per sample the output is `source[offset + k] * (edge_gain(k) * clip_gain)`. Outside the
    /// fades `edge_gain` is exactly 1.0, so with clip gain 1.0 samples are copied bit-exactly.
    pub fn render_add(&self, src: &Source, block_start: i64, l: &mut [f32], r: &mut [f32]) {
        let block_end = block_start + l.len() as i64;
        let t0 = block_start.max(self.start);
        let t1 = block_end.min(self.start + self.length);
        for t in t0..t1 {
            let (a, b) = self.sample_at(src, t);
            let i = (t - block_start) as usize;
            l[i] += a;
            r[i] += b;
        }
    }

    /// This clip's stereo output at timeline sample `t` (silence outside the clip or source).
    /// The looper tracks use it to read a track's audio at arbitrary positions.
    pub fn sample_at(&self, src: &Source, t: i64) -> (f32, f32) {
        let k = t - self.start;
        if k < 0 || k >= self.length {
            return (0.0, 0.0);
        }
        let frame = self.source_offset + k;
        if frame < 0 || frame >= src.frames() as i64 {
            return (0.0, 0.0);
        }
        let g = clip_edge_gain(k, self.length, self.fade_in, self.fade_out, self.shape) * self.gain;
        (src.left()[frame as usize] * g, src.right()[frame as usize] * g)
    }
}

/// A MIDI clip with its own clock: notes live in ticks, `bpm` and `ppq` map them to samples.
pub struct MidiClip {
    pub track: u32,
    pub start: i64,
    pub bpm: f64,
    pub ppq: u32,
    pub length_ticks: f64,
}

/// One note, kept in the engine-wide index sorted by `(clip, tick, handle)`. Sorting by tick
/// means a clip's notes are also sorted by start sample (the tick-to-sample map is monotone),
/// so the notes starting inside a time window are found by binary search.
#[derive(Clone, Copy, Debug)]
pub struct NoteEntry {
    pub clip: u32,
    pub handle: u32,
    pub tick: f64,
    pub dur_ticks: f64,
    pub pitch: u32,
    pub velocity: f32,
}

/// The contiguous run of `index` belonging to `clip`.
pub fn clip_notes(index: &[NoteEntry], clip: u32) -> &[NoteEntry] {
    let lo = index.partition_point(|e| e.clip < clip);
    let hi = index.partition_point(|e| e.clip <= clip);
    &index[lo..hi]
}

impl MidiClip {
    fn playable(&self) -> bool {
        self.bpm > 0.0 && self.bpm.is_finite() && self.ppq > 0
    }

    /// `start + round(tick * 60 * sr / (bpm * ppq))`, in f64, rounded once per event
    /// (engine.md section 2). The same expression is used for every event so results are
    /// deterministic on every client.
    pub fn tick_to_sample(&self, tick: f64, sample_rate: f64) -> i64 {
        self.start + (tick * 60.0 * sample_rate / (self.bpm * self.ppq as f64)).round() as i64
    }

    pub fn end_sample(&self, sample_rate: f64) -> i64 {
        self.tick_to_sample(self.length_ticks, sample_rate)
    }

    /// Notes at or after the clip end (or before its start) never play.
    fn note_plays(&self, e: &NoteEntry, on: i64, end: i64) -> bool {
        e.tick >= 0.0 && e.tick < self.length_ticks && on < end
    }

    /// Start every note whose first sample is exactly `at`. Notes whose start lies before
    /// `at` are *not* started: that is the "starting mid-note doesn't retrigger" rule.
    ///
    /// The note's release time is `min(start + round((tick + dur) * k), clip end)`, and at
    /// least one sample after the start, so a note longer than the clip is cut at the clip end.
    pub fn fire_at(&self, notes: &[NoteEntry], at: i64, sample_rate: f64, synth: &mut Synth) {
        if !self.playable() {
            return;
        }
        let end = self.end_sample(sample_rate);
        let first = notes.partition_point(|e| self.tick_to_sample(e.tick, sample_rate) < at);
        for e in &notes[first..] {
            let on = self.tick_to_sample(e.tick, sample_rate);
            if on != at {
                break;
            }
            if self.note_plays(e, on, end) {
                let off = self.tick_to_sample(e.tick + e.dur_ticks.max(0.0), sample_rate).min(end).max(on + 1);
                synth.note_on(e.pitch, e.velocity, off);
            }
        }
    }

    /// The first note start strictly after `at`, or `i64::MAX`. The engine splits its control
    /// blocks there.
    pub fn next_note_on_after(&self, notes: &[NoteEntry], at: i64, sample_rate: f64) -> i64 {
        if !self.playable() {
            return i64::MAX;
        }
        let end = self.end_sample(sample_rate);
        let first = notes.partition_point(|e| self.tick_to_sample(e.tick, sample_rate) <= at);
        for e in &notes[first..] {
            let on = self.tick_to_sample(e.tick, sample_rate);
            if self.note_plays(e, on, end) {
                return on;
            }
            if e.tick >= self.length_ticks {
                break; // sorted by tick: nothing later can play
            }
        }
        i64::MAX
    }
}
