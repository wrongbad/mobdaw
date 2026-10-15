//! Patch matching core (docs/matching.md): soundfont targets, bore rendering, spectral loss.
use dsp::boresynth::*;
use rustfft::{num_complex::Complex, FftPlanner};
use std::{fs::File, io::BufReader, path::Path, sync::Arc};

pub const SR: usize = 44100;

/// One probe note: MIDI key, velocity, held seconds, total seconds.
#[derive(Clone, Copy, Debug)]
pub struct Probe {
    pub key: u32,
    pub vel: u32,
    pub hold: f32,
    pub dur: f32,
}

/// Render a GM program from a soundfont: dry (no reverb/chorus), mono, peak-normalised.
pub fn render_sf2(sf2: &Path, program: i32, p: Probe) -> Vec<f32> {
    render_sf2_fx(sf2, program, p, false)
}

/// As [`render_sf2`], optionally with the soundfont's own reverb/chorus sends (GM defaults).
pub fn render_sf2_fx(sf2: &Path, program: i32, p: Probe, wet: bool) -> Vec<f32> {
    use rustysynth::*;
    let mut r = BufReader::new(File::open(sf2).expect("sf2"));
    let font = Arc::new(SoundFont::new(&mut r).expect("parse sf2"));
    let mut s = SynthesizerSettings::new(SR as i32);
    s.enable_reverb_and_chorus = wet;
    let mut syn = Synthesizer::new(&font, &s).unwrap();
    syn.process_midi_message(0, 0xC0, program, 0);
    syn.note_on(0, p.key as i32, p.vel as i32);
    let n = (p.dur * SR as f32) as usize;
    let hold = (p.hold * SR as f32) as usize;
    let (mut l, mut rr) = (vec![0f32; n], vec![0f32; n]);
    syn.render(&mut l[..hold], &mut rr[..hold]);
    syn.note_off(0, p.key as i32);
    syn.render(&mut l[hold..], &mut rr[hold..]);
    let mut m: Vec<f32> = l.iter().zip(&rr).map(|(a, b)| 0.5 * (a + b)).collect();
    normalise(&mut m);
    m
}

pub fn normalise(x: &mut [f32]) {
    let rms = (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt().max(1e-9);
    // loudness-normalise over the active part
    let g = 0.1 / rms;
    x.iter_mut().for_each(|v| *v *= g);
}

/// Bore parameters in calibrated knob space; indices match `PARAMS`.
pub const PARAMS: [(&str, f32, f32); 14] = [
    ("character", 0.0, 1.0),
    ("stiffness", 0.0, 1.0),
    ("aperture", 0.0, 1.0),
    ("position", 0.0, 1.0),
    ("damping", 0.0, 1.0),
    ("decay", 0.0, 1.0),
    ("breath", 0.0, 1.0),
    ("noise", 0.0, 1.0),
    ("vibrato_depth", 0.0, 0.6),
    ("attack_ms", 2.0, 600.0),
    ("release_ms", 20.0, 1500.0),
    ("pitch_vibrato", 0.0, 1.0),
    ("vibrato_delay_ms", 0.0, 1500.0),
    ("bell", 0.0, 1.0),
];

/// `x` is normalised 0..1 per PARAMS (attack/release log-scaled); `open` is a discrete choice.
pub fn real(x: &[f64]) -> Vec<f32> {
    PARAMS.iter().zip(x).enumerate().map(|(i, ((_, lo, hi), &v))| {
        let v = v.clamp(0.0, 1.0) as f32;
        if i == 9 || i == 10 { (lo.ln() + v * (hi.ln() - lo.ln())).exp() } else { lo + v * (hi - lo) }
    }).collect()
}

pub fn render_bore(rp: &[f32], open: bool, p: Probe) -> Option<Vec<f32>> {
    let mut b = BoreSynth::new(SR as f32);
    for (id, v) in [(P_CHARACTER, rp[0]), (P_STIFFNESS, rp[1]), (P_APERTURE, rp[2]), (P_POSITION, rp[3]), (P_BORE, open as u8 as f32),
        (P_DAMPING, rp[4]), (P_DECAY, rp[5]), (P_BREATH, rp[6]), (P_NOISE, rp[7]), (P_VIBRATO_DEPTH, rp[8]), (P_ATTACK_MS, rp[9]), (P_RELEASE_MS, rp[10])] {
        b.set_param_smooth(id, v, 0.0);
    }
    if !b.accepts(p.key) {
        return None;
    }
    let n = (p.dur * SR as f32) as usize;
    let hold = (p.hold * SR as f32) as usize;
    b.note_on(p.key, p.vel as f32 / 127.0, i64::MAX);
    let mut out = vec![0f32; n];
    b.render_add(&mut out[..hold]);
    b.release_all();
    b.render_add(&mut out[hold..]);
    if out.iter().any(|v| !v.is_finite()) {
        return None;
    }
    normalise(&mut out);
    Some(out)
}

/// Per-frame dynamic range of the loss spectra (dB below the frame's loudest band).
pub const FLOOR_DB: f32 = 60.0;

pub struct Spec {
    pub mel: Vec<Vec<f32>>, // frames x bands, log magnitude
}

/// Log-spaced band spectrogram at one FFT size.
pub fn spec(x: &[f32], n: usize, bands: usize) -> Vec<Vec<f32>> {
    let fft = FftPlanner::<f32>::new().plan_fft_forward(n);
    let hop = n / 4;
    let win: Vec<f32> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()).collect();
    let edges: Vec<usize> = (0..=bands).map(|b| {
        let f = 40.0 * (16000.0f32 / 40.0).powf(b as f32 / bands as f32);
        ((f / SR as f32 * n as f32) as usize).clamp(1, n / 2)
    }).collect();
    let mut out = vec![];
    let mut s = 0;
    while s + n <= x.len() {
        let mut buf: Vec<Complex<f32>> = (0..n).map(|i| Complex::new(x[s + i] * win[i], 0.0)).collect();
        fft.process(&mut buf);
        let mut row: Vec<f32> = (0..bands).map(|b| {
            let (a, z) = (edges[b], edges[b + 1].max(edges[b] + 1));
            let e: f32 = buf[a..z.min(n / 2)].iter().map(|c| c.norm_sqr()).sum::<f32>() / (z - a) as f32;
            (e + 1e-8).ln()
        }).collect();
        // Floor each frame FLOOR_DB below its loudest band: valleys between harmonics far under the peak are inaudible,
        // but in a raw log spectrum they dominate, and the search fills them with noise to match a recording's floor.
        let top = row.iter().cloned().fold(f32::MIN, f32::max);
        for v in &mut row {
            *v = v.max(top - FLOOR_DB * std::f32::consts::LN_10 / 10.0);
        }
        out.push(row);
        s += hop;
    }
    out
}

pub struct Target {
    pub specs: Vec<Vec<Vec<f32>>>,
    pub env: Vec<f32>,
    /// Vibrato (depth cents, rate Hz) of the held part, when the pitch term is on.
    pub vib: Option<(f32, f32)>,
    /// The attack segment (first [`ATTACK_S`]): 256-point band spectrogram and 5 ms dB envelope.
    pub att_spec: Vec<Vec<f32>>,
    pub att_env: Vec<f32>,
}

/// Attack segment length and its weight in [`loss`]: the onset is a small part of a 1.8 s clip, so without its own
/// term the search happily trades a wrong attack (a too-fast bow) for a slightly better sustain.
pub const ATTACK_S: f32 = 0.3;
pub const W_ATTACK: f32 = 1.0;

fn attack_part(x: &[f32]) -> &[f32] {
    &x[..((ATTACK_S * SR as f32) as usize).min(x.len())]
}

/// dB envelope in 5 ms chunks, in the same units as [`envelope`].
fn fine_envelope(x: &[f32]) -> Vec<f32> {
    x.chunks(SR / 200).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32 + 1e-9).ln() * 0.5 * 8.686 / 20.0).collect()
}

/// 10%..90% rise time (s) to the sustained level (median 5 ms RMS from 0.4 to 1.0 s); robust to vibrato and to an
/// onset overshoot, unlike rising to the peak.
pub fn attack_time(x: &[f32]) -> f32 {
    let c = SR / 200;
    let e: Vec<f32> = x[..(SR as f32 * 1.0) as usize].chunks(c).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let mut sus: Vec<f32> = e[80..].to_vec();
    sus.sort_by(f32::total_cmp);
    let lvl = sus[sus.len() / 2];
    let t = |f: f32| e.iter().position(|&v| v >= f * lvl).unwrap_or(e.len()) as f32 * 0.005;
    t(0.9) - t(0.1)
}

fn envelope(x: &[f32]) -> Vec<f32> {
    x.chunks(SR / 50).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32 + 1e-9).ln() * 0.5 * 8.686 / 20.0 ).collect()
}

pub fn target(x: &[f32]) -> Target {
    let a = attack_part(x);
    Target { specs: [512, 2048].iter().map(|&n| spec(x, n, 40)).collect(), env: envelope(x), vib: None, att_spec: spec(a, 256, 24), att_env: fine_envelope(a) }
}

/// As [`target`], plus the vibrato of the held part for the pitch term of [`loss`].
pub fn target_pitched(x: &[f32], p: Probe) -> Target {
    Target { vib: Some(vibrato(x, p)), ..target(x) }
}

/// Multi-resolution log-spectral L1 + dB envelope; lower is better.
pub fn loss(t: &Target, y: &[f32]) -> f32 {
    let mut tot = 0.0;
    for (ts, n) in t.specs.iter().zip([512, 2048]) {
        let ys = spec(y, n, 40);
        let (mut s, mut c) = (0.0, 0);
        for (a, b) in ts.iter().zip(&ys) {
            for (u, v) in a.iter().zip(b) {
                s += (u - v).abs();
                c += 1;
            }
        }
        tot += s / c.max(1) as f32;
    }
    let ye = envelope(y);
    let e: f32 = t.env.iter().zip(&ye).map(|(a, b)| (a - b).abs()).sum::<f32>() / t.env.len().max(1) as f32;
    tot + 2.0 * e + W_ATTACK * attack_loss(t, y)
}

/// The parts of [`loss_pitched`]: (spectral + envelope, attack, vibrato).
pub fn loss_parts(t: &Target, y: &[f32], p: Probe) -> (f32, f32, f32) {
    let a = W_ATTACK * attack_loss(t, y);
    let base = loss(t, y) - a;
    (base, a, loss_pitched(t, y, p) - base - a)
}

/// Attack segment: fine-time log band spectrum L1 plus 2x the 5 ms dB envelope L1.
pub fn attack_loss(t: &Target, y: &[f32]) -> f32 {
    let a = attack_part(y);
    let ys = spec(a, 256, 24);
    let (mut s, mut c) = (0.0, 0);
    for (u, v) in t.att_spec.iter().zip(&ys) {
        for (p, q) in u.iter().zip(v) {
            s += (p - q).abs();
            c += 1;
        }
    }
    let ye = fine_envelope(a);
    let e: f32 = t.att_env.iter().zip(&ye).map(|(p, q)| (p - q).abs()).sum::<f32>() / t.att_env.len().max(1) as f32;
    s / c.max(1) as f32 + 2.0 * e
}

/// Weights of the pitch term: per cent of vibrato depth error, per Hz of rate error (rate only counts when both have a
/// vibrato to speak of).
pub const W_DEPTH: f32 = 0.08;
pub const W_RATE: f32 = 0.25;

/// [`loss`] plus, if the target has vibrato stats, the vibrato depth/rate mismatch.
pub fn loss_pitched(t: &Target, y: &[f32], p: Probe) -> f32 {
    let base = loss(t, y);
    let Some((td, tr)) = t.vib else { return base };
    let (yd, yr) = vibrato(y, p);
    // a near-flat contour's "rate" is jitter: only compare rates when both have a vibrato to speak of
    let rate_w = (td.min(yd) / 8.0).min(1.0);
    base + W_DEPTH * (td - yd).abs() + W_RATE * rate_w * (tr - yr).abs()
}

/// f0 contour (cents vs the probe's note) of the held part, 0.25 s to the release, by autocorrelation within ±8% of
/// the note's period, parabolically interpolated. 2048-sample frames, 256 hop.
pub fn pitch_track(x: &[f32], p: Probe) -> Vec<f32> {
    let f = 440.0 * ((p.key as f32 - 69.0) / 12.0).exp2();
    let per = SR as f32 / f;
    let (n, hop) = (2048usize, 256usize);
    let (lo, hi) = (((per * 0.92) as usize).max(2), ((per * 1.08) as usize + 1).min(n / 2));
    let (a, z) = ((0.25 * SR as f32) as usize, ((p.hold * SR as f32) as usize).min(x.len()));
    let ac = |fr: &[f32], l: usize| fr[..n - l].iter().zip(&fr[l..n]).map(|(a, b)| a * b).sum::<f32>();
    let mut out = vec![];
    let mut s0 = a;
    while s0 + n <= z {
        let fr = &x[s0..s0 + n];
        let l = (lo..=hi).max_by(|&a, &b| ac(fr, a).total_cmp(&ac(fr, b))).unwrap();
        let (y0, y1, y2) = (ac(fr, l - 1), ac(fr, l), ac(fr, (l + 1).min(n - 1)));
        let d = y0 - 2.0 * y1 + y2;
        let lag = l as f32 + if d.abs() > 1e-12 { (0.5 * (y0 - y2) / d).clamp(-1.0, 1.0) } else { 0.0 };
        out.push(1200.0 * (per / lag).log2());
        s0 += hop;
    }
    out
}

/// (depth, rate): RMS cents of the detrended contour (×√2, so a sine's peak), and the rate from its zero crossings.
pub fn vibrato(x: &[f32], p: Probe) -> (f32, f32) {
    let c = pitch_track(x, p);
    if c.len() < 8 {
        return (0.0, 0.0);
    }
    // remove a linear trend (slow drift / intonation) before measuring the wobble
    let n = c.len() as f32;
    let mx = (n - 1.0) / 2.0;
    let my = c.iter().sum::<f32>() / n;
    let sxy: f32 = c.iter().enumerate().map(|(i, v)| (i as f32 - mx) * (v - my)).sum();
    let sxx: f32 = (0..c.len()).map(|i| (i as f32 - mx).powi(2)).sum();
    let k = sxy / sxx;
    let d: Vec<f32> = c.iter().enumerate().map(|(i, v)| v - my - k * (i as f32 - mx)).collect();
    let depth = (d.iter().map(|v| v * v).sum::<f32>() / n).sqrt() * std::f32::consts::SQRT_2;
    let crossings = d.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count() as f32;
    let secs = n * 256.0 / SR as f32;
    (depth, 0.5 * crossings / secs)
}

pub fn write_wav(path: &Path, x: &[f32]) {
    use std::io::Write;
    let mut f = File::create(path).unwrap();
    let data: Vec<u8> = x.iter().flat_map(|v| ((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
    f.write_all(b"RIFF").unwrap();
    f.write_all(&(36 + data.len() as u32).to_le_bytes()).unwrap();
    f.write_all(b"WAVEfmt ").unwrap();
    for v in [16u32] { f.write_all(&v.to_le_bytes()).unwrap(); }
    f.write_all(&1u16.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap();
    f.write_all(&(SR as u32).to_le_bytes()).unwrap();
    f.write_all(&(SR as u32 * 2).to_le_bytes()).unwrap();
    f.write_all(&2u16.to_le_bytes()).unwrap();
    f.write_all(&16u16.to_le_bytes()).unwrap();
    f.write_all(b"data").unwrap();
    f.write_all(&(data.len() as u32).to_le_bytes()).unwrap();
    f.write_all(&data).unwrap();
}

// ---- Joint chain: bore -> body -> lowpass filter -> 4-band EQ -> reverb ----
// Body and EQ gains are solved in closed form per candidate; everything else is searched.

use engine::device::{Device, KIND_BODY, KIND_EQ, KIND_FILTER, KIND_REVERB};

/// Searched dims beyond the bore knobs (normalised 0..1, log-mapped).
pub const CHAIN: [(&str, f32, f32); 5] = [
    ("vibrato_hz", 2.0, 8.0),
    ("filter_cutoff_hz", 300.0, 20000.0),
    ("filter_damping", 0.35, 1.2),
    ("eq_bell1_hz", 200.0, 1500.0),
    ("eq_bell2_hz", 1000.0, 8000.0),
];
pub const EQ_HZ: [f32; 4] = [100.0, 500.0, 2000.0, 8000.0];
pub const EQ_DAMPING: f32 = 0.7071;
/// Ridge as a fraction of each band's own column energy (so a narrow peak, which touches few solve bands, is shrunk
/// as much as a broad one rather than swamped), and caps. An absolute ridge shrank body peaks ~4x.
pub const EQ_RIDGE: f64 = 0.3;
pub const EQ_MAX_DB: f64 = 12.0;
pub const BODY_RIDGE: f64 = 0.1;
pub const BODY_MAX_DB: f64 = 18.0;
pub const BODY_BANDS: usize = 8;
/// Each body peak searches ±40% (log) around its starting frequency; the shared damping 0.04..0.3 (Q 12..1.7).
pub const BODY_SPAN: f32 = 1.4;
pub const BODY_DAMP: (f32, f32) = (0.04, 0.3);
/// The gain solve's spectrum: finer than the loss's 40 bands, so narrow body peaks resolve.
pub const SOLVE_N: usize = 4096;
pub const SOLVE_BANDS: usize = 96;

/// Per-program search setup.
#[derive(Clone, Debug)]
pub struct Setup {
    /// Range for `character` (strings stay in the bow region).
    pub character: (f32, f32),
    /// Starting body peak frequencies, or no body stage.
    pub body: Option<[f32; BODY_BANDS]>,
}

impl Setup {
    pub fn dims(&self) -> usize {
        PARAMS.len() + CHAIN.len() + if self.body.is_some() { BODY_BANDS + 1 } else { 0 }
    }
}

#[derive(Clone, Debug)]
pub struct Body {
    pub hz: [f32; BODY_BANDS],
    pub damping: f32,
    pub db: [f32; BODY_BANDS],
}

#[derive(Clone, Debug)]
pub struct Chain {
    pub bore: Vec<f32>,
    pub open: bool,
    pub vibrato_hz: f32,
    pub cutoff: f32,
    pub fdamp: f32,
    pub body: Option<Body>,
    pub eq_hz: [f32; 4],
    pub eq_db: [f32; 4],
    /// mix, size, damping, predelay ms
    pub reverb: Option<[f32; 4]>,
}

fn logmap(v: f64, lo: f32, hi: f32) -> f32 {
    (lo.ln() + v.clamp(0.0, 1.0) as f32 * (hi.ln() - lo.ln())).exp()
}

pub fn chain_from(x: &[f64], open: bool, su: &Setup) -> Chain {
    let np = PARAMS.len();
    let mut bore = real(&x[..np]);
    bore[0] = su.character.0 + x[0].clamp(0.0, 1.0) as f32 * (su.character.1 - su.character.0);
    let c: Vec<f32> = CHAIN.iter().zip(&x[np..]).map(|((_, lo, hi), &v)| logmap(v, *lo, *hi)).collect();
    let body = su.body.map(|init| {
        let b = &x[np + CHAIN.len()..];
        Body {
            hz: std::array::from_fn(|i| logmap(b[i], init[i] / BODY_SPAN, init[i] * BODY_SPAN)),
            damping: logmap(b[BODY_BANDS], BODY_DAMP.0, BODY_DAMP.1),
            db: [0.0; BODY_BANDS],
        }
    });
    Chain { bore, open, vibrato_hz: c[0], cutoff: c[1], fdamp: c[2], body, eq_hz: [EQ_HZ[0], c[3], c[4], EQ_HZ[3]], eq_db: [0.0; 4], reverb: None }
}

fn dev(kind: u32, params: &[(u32, f32)]) -> Device {
    let mut d = Device::new(0, kind, 0.0, false, SR as f32);
    for &(p, v) in params {
        d.set_param_auto(p, v, v, 0);
    }
    d
}

fn run(d: &mut Device, x: &mut [f32]) {
    let mut r = x.to_vec();
    for (a, b) in x.chunks_mut(128).zip(r.chunks_mut(128)) {
        d.process(a, b, SR as f32);
    }
    // the chain is mono in, mono-summed out
    for (a, b) in x.iter_mut().zip(&r) {
        *a = 0.5 * (*a + b);
    }
}

fn bands_device(kind: u32, hz: &[f32], db: &[f32], damping: f32) -> Device {
    let mut p = vec![];
    for i in 0..hz.len() {
        p.extend([(i as u32 * 3, hz[i]), (i as u32 * 3 + 1, db[i]), (i as u32 * 3 + 2, damping)]);
    }
    dev(kind, &p)
}

fn eq_device(c: &Chain) -> Device {
    bands_device(KIND_EQ, &c.eq_hz, &c.eq_db, EQ_DAMPING)
}

fn body_device(b: &Body) -> Device {
    bands_device(KIND_BODY, &b.hz, &b.db, b.damping)
}

/// The bore voice alone (no normalisation).
pub fn render_voice(c: &Chain, p: Probe) -> Option<Vec<f32>> {
    let rp = &c.bore;
    let mut b = BoreSynth::new(SR as f32);
    for (id, v) in [(P_CHARACTER, rp[0]), (P_STIFFNESS, rp[1]), (P_APERTURE, rp[2]), (P_POSITION, rp[3]), (P_BORE, c.open as u8 as f32),
        (P_DAMPING, rp[4]), (P_DECAY, rp[5]), (P_BREATH, rp[6]), (P_NOISE, rp[7]), (P_VIBRATO_DEPTH, rp[8]), (P_ATTACK_MS, rp[9]), (P_RELEASE_MS, rp[10]),
        (P_VIBRATO_PITCH, rp[11]), (P_VIBRATO_DELAY_MS, rp[12]), (P_BELL, rp[13]), (P_VIBRATO_RATE, c.vibrato_hz)] {
        b.set_param_smooth(id, v, 0.0);
    }
    if !b.accepts(p.key) {
        return None;
    }
    let n = (p.dur * SR as f32) as usize;
    let hold = (p.hold * SR as f32) as usize;
    b.note_on(p.key, p.vel as f32 / 127.0, i64::MAX);
    let mut out = vec![0f32; n];
    b.render_add(&mut out[..hold]);
    b.release_all();
    b.render_add(&mut out[hold..]);
    out.iter().all(|v| v.is_finite()).then_some(out)
}

/// Voice -> filter, normalised: the input to the gain solve. Body and EQ are linear and time-invariant, so applying them
/// after the filter (in [`finish`]) is the same as the device order bore -> body -> filter -> EQ.
pub fn pre_eq(c: &Chain, p: Probe) -> Option<Vec<f32>> {
    let mut y = render_voice(c, p)?;
    run(&mut dev(KIND_FILTER, &[(0, 0.0), (1, c.cutoff), (2, c.fdamp)]), &mut y);
    normalise(&mut y);
    Some(y)
}

/// From a [`pre_eq`] signal: body, EQ (and reverb if set), renormalised.
pub fn finish(c: &Chain, y: &mut [f32]) {
    if let Some(b) = &c.body {
        run(&mut body_device(b), y);
    }
    run(&mut eq_device(c), y);
    if let Some(rv) = c.reverb {
        apply_reverb(rv, y);
    }
    normalise(y);
}

pub fn render_chain(c: &Chain, p: Probe) -> Option<Vec<f32>> {
    let mut y = pre_eq(c, p)?;
    finish(c, &mut y);
    y.iter().all(|v| v.is_finite()).then_some(y)
}

pub fn apply_reverb([mix, size, damp, pre]: [f32; 4], y: &mut [f32]) {
    run(&mut dev(KIND_REVERB, &[(0, mix), (1, size), (2, damp), (3, pre)]), y);
}

fn solve_edges(b: usize) -> (usize, usize) {
    let e = |b: usize| ((40.0 * (16000.0f32 / 40.0).powf(b as f32 / SOLVE_BANDS as f32) / SR as f32 * SOLVE_N as f32) as usize).clamp(1, SOLVE_N / 2);
    let (a, z) = (e(b), e(b + 1).max(e(b) + 1));
    (a, z.min(SOLVE_N / 2))
}

/// Long-term band log power on the solve grid (time-average of the band spectrogram).
pub fn target_ltas(x: &[f32]) -> Vec<f64> {
    let s = spec(x, SOLVE_N, SOLVE_BANDS);
    let mut m = vec![0.0; SOLVE_BANDS];
    for row in &s { for (a, v) in m.iter_mut().zip(row) { *a += *v as f64 / s.len() as f64; } }
    m
}

/// ln-power response per dB of each band of a device, one column per band, on the solve grid.
fn basis(make: &dyn Fn(usize) -> Device, n_bands: usize) -> Vec<Vec<f64>> {
    let mut cols = vec![vec![0.0; n_bands]; SOLVE_BANDS];
    let fft = FftPlanner::<f32>::new().plan_fft_forward(SOLVE_N);
    for i in 0..n_bands {
        let mut x = vec![0f32; SOLVE_N];
        x[0] = 1.0;
        run(&mut make(i), &mut x);
        let mut buf: Vec<Complex<f32>> = x.iter().map(|&v| Complex::new(v, 0.0)).collect();
        fft.process(&mut buf);
        for b in 0..SOLVE_BANDS {
            let (a, z) = solve_edges(b);
            let e: f32 = buf[a..z].iter().map(|c| c.norm_sqr()).sum::<f32>() / (z - a) as f32;
            cols[b][i] = (e as f64).ln() / 6.0;
        }
    }
    cols
}

/// Closed-form body + EQ gains: ridge least squares of the mean (target - candidate) long-term log spectrum onto every
/// band's response (log responses of cascaded filters add), centred so overall level doesn't count. Shared across
/// probe notes, so the gains can only model fixed-frequency shaping. Fills `c.body.db` and `c.eq_db`.
pub fn solve_gains(c: &mut Chain, targets: &[Vec<f64>], cands: &[Vec<f32>]) {
    let mut r = vec![0.0; SOLVE_BANDS];
    for (t, y) in targets.iter().zip(cands) {
        for (a, (u, v)) in r.iter_mut().zip(t.iter().zip(target_ltas(y))) { *a += (u - v) / cands.len() as f64; }
    }
    let eq_cols = basis(&|i| { let mut db = [0.0; 4]; db[i] = 6.0; bands_device(KIND_EQ, &c.eq_hz, &db, EQ_DAMPING) }, 4);
    let mut cols = eq_cols;
    let mut ridge = vec![EQ_RIDGE; 4];
    let mut cap = vec![EQ_MAX_DB; 4];
    if let Some(b) = &c.body {
        let bc = basis(&|i| { let mut db = [0.0; BODY_BANDS]; db[i] = 6.0; bands_device(KIND_BODY, &b.hz, &db, b.damping) }, BODY_BANDS);
        for (row, extra) in cols.iter_mut().zip(bc) { row.extend(extra); }
        ridge.extend([BODY_RIDGE; BODY_BANDS]);
        cap.extend([BODY_MAX_DB; BODY_BANDS]);
    }
    let k = ridge.len();
    let mean = |f: &dyn Fn(usize) -> f64| (0..SOLVE_BANDS).map(f).sum::<f64>() / SOLVE_BANDS as f64;
    let rm = mean(&|b| r[b]);
    let cm: Vec<f64> = (0..k).map(|i| mean(&|b| cols[b][i])).collect();
    let mut ata = vec![vec![0.0f64; k]; k];
    let mut atb = vec![0.0f64; k];
    for b in 0..SOLVE_BANDS {
        for i in 0..k {
            atb[i] += (cols[b][i] - cm[i]) * (r[b] - rm);
            for j in 0..k { ata[i][j] += (cols[b][i] - cm[i]) * (cols[b][j] - cm[j]); }
        }
    }
    for i in 0..k { ata[i][i] *= 1.0 + ridge[i]; }
    let g = solve(ata, atb);
    for i in 0..4 { c.eq_db[i] = g[i].clamp(-cap[i], cap[i]) as f32; }
    if let Some(b) = &mut c.body {
        for i in 0..BODY_BANDS { b.db[i] = g[4 + i].clamp(-cap[4 + i], cap[4 + i]) as f32; }
    }
}

/// Gauss-Jordan with partial pivoting.
fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Vec<f64> {
    let n = b.len();
    for c in 0..n {
        let p = (c..n).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs())).unwrap();
        a.swap(c, p);
        b.swap(c, p);
        if a[c][c].abs() < 1e-12 { continue; }
        for r in 0..n {
            if r != c {
                let f = a[r][c] / a[c][c];
                for k in 0..n { a[r][k] -= f * a[c][k]; }
                b[r] -= f * b[c];
            }
        }
    }
    (0..n).map(|i| if a[i][i].abs() > 1e-12 { b[i] / a[i][i] } else { 0.0 }).collect()
}

// ---- Programs and best.json ----

/// Violin body peaks (air mode, body modes, bridge hill); the cello's sit roughly 0.4x lower.
pub const VIOLIN_BODY: [f32; 8] = [275.0, 400.0, 460.0, 540.0, 700.0, 1000.0, 2500.0, 3200.0];
/// Winds: no instrument data behind these, just peaks spread over the range where bell / tone-hole radiation shapes the
/// tone (the clarinet target peaks near 1.4 kHz); each searches ±40%.
pub const WIND_BODY: [f32; 8] = [300.0, 500.0, 800.0, 1100.0, 1500.0, 2000.0, 2800.0, 4000.0];
pub const PENALTY: f32 = 60.0;

pub struct Prog { pub gm: i32, pub name: &'static str, pub keys: [u32; 3], pub strings: bool }
pub const PROGRAMS: [Prog; 5] = [
    Prog { gm: 71, name: "clarinet", keys: [55, 62, 69], strings: false },
    Prog { gm: 65, name: "alto-sax", keys: [57, 64, 71], strings: false },
    Prog { gm: 73, name: "flute", keys: [67, 74, 81], strings: false },
    Prog { gm: 42, name: "cello", keys: [41, 52, 62], strings: true },
    Prog { gm: 40, name: "violin", keys: [60, 69, 79], strings: true },
];

pub fn setup(p: &Prog) -> Setup {
    if !p.strings {
        return Setup { character: (0.0, 1.0), body: Some(WIND_BODY) };
    }
    let k = if p.name == "cello" { 0.4 } else { 1.0 };
    Setup { character: (0.75, 1.0), body: Some(VIOLIN_BODY.map(|f| f * k)) }
}

/// The dry probe notes for a program.
pub fn probes(p: &Prog) -> Vec<Probe> {
    p.keys.iter().map(|&k| Probe { key: k, vel: 90, hold: 1.2, dur: 1.8 }).collect()
}

fn num_after(s: &str, key: &str) -> Option<f32> {
    let i = s.find(&format!("\"{key}\":"))? + key.len() + 3;
    let t = s[i..].trim_start();
    let end = t.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e')).unwrap_or(t.len());
    t[..end].parse().ok()
}

fn bands_in(s: &str, key: &str) -> Vec<[f32; 3]> {
    let Some(i) = s.find(&format!("\"{key}\": [")) else { return vec![] };
    let body = &s[i..i + s[i..].find(']').unwrap()];
    body.split('{').skip(1).map(|b| [num_after(b, "freq_hz").unwrap(), num_after(b, "gain_db").unwrap(), num_after(b, "damping").unwrap()]).collect()
}

/// A dry chain (no reverb) from a `match_chain` best.json (older files without pitch vibrato or body are fine).
pub fn chain_from_json(s: &str) -> Chain {
    let b = &s[s.find("\"bore\": {").unwrap() + 9..];
    let b = &b[..b.find('}').unwrap()];
    let bore = PARAMS.iter().map(|(n, _, _)| num_after(b, n).unwrap_or(0.0)).collect();
    let body = bands_in(s, "body");
    let eq = bands_in(s, "eq");
    let f = &s[s.find("\"filter\":").unwrap()..];
    Chain {
        bore,
        open: num_after(b, "bore").unwrap() > 0.5,
        vibrato_hz: num_after(b, "vibrato_hz").unwrap_or(5.0),
        cutoff: num_after(f, "cutoff_hz").unwrap(),
        fdamp: num_after(f, "damping").unwrap(),
        body: (!body.is_empty()).then(|| Body {
            hz: std::array::from_fn(|i| body[i][0]),
            damping: body[0][2],
            db: std::array::from_fn(|i| body[i][1]),
        }),
        eq_hz: std::array::from_fn(|i| eq[i][0]),
        eq_db: std::array::from_fn(|i| eq[i][1]),
        reverb: None,
    }
}
