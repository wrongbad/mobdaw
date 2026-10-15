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
pub const PARAMS: [(&str, f32, f32); 11] = [
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
];

/// `x` is normalised 0..1 per PARAMS (attack/release log-scaled); `open` is a discrete choice.
pub fn real(x: &[f64]) -> Vec<f32> {
    PARAMS.iter().zip(x).enumerate().map(|(i, ((_, lo, hi), &v))| {
        let v = v.clamp(0.0, 1.0) as f32;
        if i >= 9 { (lo.ln() + v * (hi.ln() - lo.ln())).exp() } else { lo + v * (hi - lo) }
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
        let row = (0..bands).map(|b| {
            let (a, z) = (edges[b], edges[b + 1].max(edges[b] + 1));
            let e: f32 = buf[a..z.min(n / 2)].iter().map(|c| c.norm_sqr()).sum::<f32>() / (z - a) as f32;
            (e + 1e-8).ln()
        }).collect();
        out.push(row);
        s += hop;
    }
    out
}

pub struct Target {
    pub specs: Vec<Vec<Vec<f32>>>,
    pub env: Vec<f32>,
}

fn envelope(x: &[f32]) -> Vec<f32> {
    x.chunks(SR / 50).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32 + 1e-9).ln() * 0.5 * 8.686 / 20.0 ).collect()
}

pub fn target(x: &[f32]) -> Target {
    Target { specs: [512, 2048].iter().map(|&n| spec(x, n, 40)).collect(), env: envelope(x) }
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
    tot + 2.0 * e
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

// ---- Joint chain: bore -> lowpass filter -> 4-band EQ (gains solved per candidate) -> reverb ----

use engine::device::{Device, KIND_EQ, KIND_FILTER, KIND_REVERB};

/// Searched dims beyond the bore knobs (normalised 0..1, log-mapped): vibrato rate, filter cutoff and
/// damping, the two EQ bell centres. EQ gains are not searched; [`solve_eq`] fits them per candidate.
pub const CHAIN: [(&str, f32, f32); 5] = [
    ("vibrato_hz", 2.0, 8.0),
    ("filter_cutoff_hz", 300.0, 20000.0),
    ("filter_damping", 0.35, 1.2),
    ("eq_bell1_hz", 200.0, 1500.0),
    ("eq_bell2_hz", 1000.0, 8000.0),
];
pub const DIMS: usize = PARAMS.len() + CHAIN.len();
pub const EQ_HZ: [f32; 4] = [100.0, 500.0, 2000.0, 8000.0];
pub const EQ_DAMPING: f32 = 0.7071;
/// Ridge weight on EQ gains (per dB^2, in the same units as the band log-power residual), and a cap.
pub const EQ_RIDGE: f64 = 0.02;
pub const EQ_MAX_DB: f64 = 12.0;
pub const BANDS: usize = 40;

#[derive(Clone, Debug)]
pub struct Chain {
    pub bore: Vec<f32>,
    pub open: bool,
    pub vibrato_hz: f32,
    pub cutoff: f32,
    pub fdamp: f32,
    pub eq_hz: [f32; 4],
    pub eq_db: [f32; 4],
    /// mix, size, damping, predelay ms
    pub reverb: Option<[f32; 4]>,
}

pub fn chain_from(x: &[f64], open: bool) -> Chain {
    let c: Vec<f32> = CHAIN.iter().zip(&x[PARAMS.len()..]).map(|((_, lo, hi), &v)| {
        let v = v.clamp(0.0, 1.0) as f32;
        (lo.ln() + v * (hi.ln() - lo.ln())).exp()
    }).collect();
    Chain { bore: real(&x[..PARAMS.len()]), open, vibrato_hz: c[0], cutoff: c[1], fdamp: c[2], eq_hz: [EQ_HZ[0], c[3], c[4], EQ_HZ[3]], eq_db: [0.0; 4], reverb: None }
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

fn eq_device(hz: &[f32; 4], db: &[f32; 4]) -> Device {
    let mut p = vec![];
    for i in 0..4 {
        p.extend([(i as u32 * 3, hz[i]), (i as u32 * 3 + 1, db[i]), (i as u32 * 3 + 2, EQ_DAMPING)]);
    }
    dev(KIND_EQ, &p)
}

/// The bore voice alone (no normalisation), with the chain's vibrato rate.
pub fn render_voice(c: &Chain, p: Probe) -> Option<Vec<f32>> {
    let rp = &c.bore;
    let mut b = BoreSynth::new(SR as f32);
    for (id, v) in [(P_CHARACTER, rp[0]), (P_STIFFNESS, rp[1]), (P_APERTURE, rp[2]), (P_POSITION, rp[3]), (P_BORE, c.open as u8 as f32),
        (P_DAMPING, rp[4]), (P_DECAY, rp[5]), (P_BREATH, rp[6]), (P_NOISE, rp[7]), (P_VIBRATO_DEPTH, rp[8]), (P_ATTACK_MS, rp[9]), (P_RELEASE_MS, rp[10]),
        (P_VIBRATO_RATE, c.vibrato_hz)] {
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

/// Voice -> filter -> EQ (-> reverb), loudness-normalised.
pub fn render_chain(c: &Chain, p: Probe) -> Option<Vec<f32>> {
    let mut y = render_voice(c, p)?;
    post(c, &mut y);
    normalise(&mut y);
    y.iter().all(|v| v.is_finite()).then_some(y)
}

fn post(c: &Chain, y: &mut [f32]) {
    run(&mut dev(KIND_FILTER, &[(0, 0.0), (1, c.cutoff), (2, c.fdamp)]), y);
    run(&mut eq_device(&c.eq_hz, &c.eq_db), y);
    if let Some([mix, size, damp, pre]) = c.reverb {
        run(&mut dev(KIND_REVERB, &[(0, mix), (1, size), (2, damp), (3, pre)]), y);
    }
}

/// Long-term band log power (time-average of the 2048-point band spectrogram, frames weighted equally).
fn ltas(x: &[f32]) -> Vec<f64> {
    let s = spec(x, 2048, BANDS);
    let mut m = vec![0.0; BANDS];
    for row in &s { for (a, v) in m.iter_mut().zip(row) { *a += *v as f64 / s.len() as f64; } }
    m
}

/// ln-power response per dB of each EQ band at the given centres, on the loss's band grid.
fn eq_basis(hz: &[f32; 4]) -> Vec<[f64; 4]> {
    let n = 2048;
    let mut cols = vec![[0.0; 4]; BANDS];
    for i in 0..4 {
        let mut db = [0.0; 4];
        db[i] = 6.0;
        let mut x = vec![0f32; n * 4];
        x[0] = 1.0;
        run(&mut eq_device(hz, &db), &mut x);
        let mut buf: Vec<Complex<f32>> = x[..n].iter().map(|&v| Complex::new(v, 0.0)).collect();
        FftPlanner::<f32>::new().plan_fft_forward(n).process(&mut buf);
        for b in 0..BANDS {
            let (a, z) = band_edges(n, b);
            let e: f32 = buf[a..z].iter().map(|c| c.norm_sqr()).sum::<f32>() / (z - a) as f32;
            cols[b][i] = (e as f64).ln() / 6.0;
        }
    }
    cols
}

fn band_edges(n: usize, b: usize) -> (usize, usize) {
    let e = |b: usize| ((40.0 * (16000.0f32 / 40.0).powf(b as f32 / BANDS as f32) / SR as f32 * n as f32) as usize).clamp(1, n / 2);
    let (a, z) = (e(b), e(b + 1).max(e(b) + 1));
    (a, z.min(n / 2))
}

/// Closed-form EQ: ridge least squares of the mean (target - candidate) long-term log spectrum onto the four
/// band responses, centred so overall level (normalised away anyway) doesn't count. Shared across probe notes.
pub fn solve_eq(hz: &[f32; 4], targets: &[Vec<f64>], cands: &[Vec<f32>]) -> [f32; 4] {
    let mut r = vec![0.0; BANDS];
    for (t, y) in targets.iter().zip(cands) {
        for (a, (u, v)) in r.iter_mut().zip(t.iter().zip(ltas(y))) { *a += (u - v) / cands.len() as f64; }
    }
    let basis = eq_basis(hz);
    let mean = |f: &dyn Fn(usize) -> f64| (0..BANDS).map(f).sum::<f64>() / BANDS as f64;
    let rm = mean(&|b| r[b]);
    let bm: Vec<f64> = (0..4).map(|i| mean(&|b| basis[b][i])).collect();
    let mut ata = [[0.0f64; 4]; 4];
    let mut atb = [0.0f64; 4];
    for b in 0..BANDS {
        for i in 0..4 {
            atb[i] += (basis[b][i] - bm[i]) * (r[b] - rm);
            for j in 0..4 { ata[i][j] += (basis[b][i] - bm[i]) * (basis[b][j] - bm[j]); }
        }
    }
    for i in 0..4 { ata[i][i] += EQ_RIDGE * BANDS as f64; }
    let g = solve4(ata, atb);
    g.map(|v| v.clamp(-EQ_MAX_DB, EQ_MAX_DB) as f32)
}

fn solve4(mut a: [[f64; 4]; 4], mut b: [f64; 4]) -> [f64; 4] {
    for c in 0..4 {
        let p = (c..4).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs())).unwrap();
        a.swap(c, p);
        b.swap(c, p);
        for r in 0..4 {
            if r != c && a[c][c].abs() > 1e-12 {
                let f = a[r][c] / a[c][c];
                for k in 0..4 { a[r][k] -= f * a[c][k]; }
                b[r] -= f * b[c];
            }
        }
    }
    std::array::from_fn(|i| if a[i][i].abs() > 1e-12 { b[i] / a[i][i] } else { 0.0 })
}

pub fn target_ltas(x: &[f32]) -> Vec<f64> {
    ltas(x)
}

/// Pre-EQ signal (voice -> filter), normalised, for the EQ solve.
pub fn pre_eq(c: &Chain, p: Probe) -> Option<Vec<f32>> {
    let mut y = render_voice(c, p)?;
    run(&mut dev(KIND_FILTER, &[(0, 0.0), (1, c.cutoff), (2, c.fdamp)]), &mut y);
    normalise(&mut y);
    Some(y)
}

/// From a [`pre_eq`] signal: apply the chain's EQ (and reverb if set) and renormalise.
pub fn finish(c: &Chain, y: &mut [f32]) {
    run(&mut eq_device(&c.eq_hz, &c.eq_db), y);
    if let Some(rv) = c.reverb {
        apply_reverb(rv, y);
    }
    normalise(y);
}

pub fn apply_reverb([mix, size, damp, pre]: [f32; 4], y: &mut [f32]) {
    run(&mut dev(KIND_REVERB, &[(0, mix), (1, size), (2, damp), (3, pre)]), y);
}
