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
    use rustysynth::*;
    let mut r = BufReader::new(File::open(sf2).expect("sf2"));
    let font = Arc::new(SoundFont::new(&mut r).expect("parse sf2"));
    let mut s = SynthesizerSettings::new(SR as i32);
    s.enable_reverb_and_chorus = false;
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
