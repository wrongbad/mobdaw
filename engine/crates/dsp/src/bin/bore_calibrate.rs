//! Offline calibration sweep for the bore synth (docs/bore.md, "Calibration").
//!
//! ```text
//! cargo run --release -p dsp --bin bore_calibrate -- sweep docs/bore/sweep.csv [--apply-tune] [--err CENTS]
//! cargo run --release -p dsp --bin bore_calibrate -- fit docs/bore/sweep.csv docs/bore [--emit]
//! cargo run --release -p dsp --bin bore_calibrate -- verify               # speak check of the fitted table
//! cargo run --release -p dsp --bin bore_calibrate -- explore [pos damping [char open|closed]]
//! ```
//! `sweep` renders the DSP core over the grid (no engine, no wasm), `fit` regresses the sounding
//! region onto closed-form curves and (with `--emit`) rewrites the generated table in
//! `src/bore_cal.rs`. See docs/bore.md.

use dsp::bore::{Bore, NoteSetup, Raw, SUB_BLOCK};
use dsp::bore_cal;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub const SR: f32 = 48000.0;

#[derive(Clone, Copy, Debug, Default)]
pub struct Meas {
    pub rms: f32,
    pub peak: f32,
    pub onset_ms: f32,
    pub err_cents: f32,
    pub drift_cents: f32,
    pub spread_db: f32,
    pub aperiodicity: f32,
    pub finite: bool,
    pub speaks: bool,
}

/// Limits that define "speaks".
pub const MAX_ONSET_MS: f32 = 250.0;
pub static MAX_ERR_CENTS_CELL: Mutex<f32> = Mutex::new(60.0);
pub const MAX_ERR_CENTS: f32 = 60.0;
pub const MAX_DRIFT_CENTS: f32 = 25.0;
pub const MAX_SPREAD_DB: f32 = 3.0;
pub const MAX_APERIODICITY: f32 = 0.2;
pub const MIN_RMS: f32 = 0.003;
pub const MAX_PEAK: f32 = 50.0;

pub fn render(raw: &Raw, setup: &NoteSetup, seconds: f32) -> Vec<f32> {
    let n = (seconds * SR) as usize;
    let mut v = Bore::new(SR);
    v.start(setup);
    let mut out = vec![0.0f32; n];
    for chunk in out.chunks_mut(SUB_BLOCK) {
        v.render_add(raw, chunk, None);
    }
    out
}

/// YIN on `x[start..start+w+maxlag]`: (period in samples, aperiodicity).
fn yin(x: &[f32], start: usize, w: usize, p_exp: f64) -> Option<(f64, f32)> {
    let lo = ((0.45 * p_exp) as usize).max(2);
    let hi = (2.2 * p_exp) as usize + 1;
    if start + w + hi + 1 > x.len() {
        return None;
    }
    let mut d = vec![0.0f64; hi + 1];
    for tau in lo..=hi {
        let mut s = 0.0f64;
        for i in 0..w {
            let e = (x[start + i] - x[start + i + tau]) as f64;
            s += e * e;
        }
        d[tau] = s;
    }
    // cumulative mean normalised difference, over [lo, hi] only (the cumulative sum starts at lo)
    let mut cm = vec![1.0f64; hi + 1];
    let mut run = 0.0;
    for tau in lo..=hi {
        run += d[tau];
        cm[tau] = d[tau] * (tau - lo + 1) as f64 / run.max(1e-30);
    }
    // first local minimum under 0.15, else the global minimum
    let mut best = None;
    for tau in lo + 1..hi {
        if cm[tau] < 0.15 && cm[tau] <= cm[tau - 1] && cm[tau] <= cm[tau + 1] {
            best = Some(tau);
            break;
        }
    }
    let tau = best.unwrap_or_else(|| (lo..=hi).min_by(|&a, &b| cm[a].partial_cmp(&cm[b]).unwrap()).unwrap());
    if tau <= lo || tau >= hi {
        return Some((tau as f64, cm[tau] as f32));
    }
    let (a, b, c) = (cm[tau - 1], cm[tau], cm[tau + 1]);
    let den = a - 2.0 * b + c;
    let off = if den.abs() > 1e-12 { 0.5 * (a - c) / den } else { 0.0 };
    Some((tau as f64 + off, cm[tau] as f32))
}

pub fn measure(raw: &Raw, setup: &NoteSetup) -> Meas {
    let secs = 0.7;
    let x = render(raw, setup, secs);
    let mut m = Meas { finite: x.iter().all(|v| v.is_finite()), ..Default::default() };
    if !m.finite {
        return m;
    }
    m.peak = x.iter().fold(0.0, |p, v| p.max(v.abs()));
    let hop = (SR * 0.01) as usize;
    let env: Vec<f32> = x.chunks(hop).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()).collect();
    // steady RMS over 0.4..0.7 s
    let s0 = (0.4 * SR) as usize;
    let steady = {
        let s = &x[s0..];
        (s.iter().map(|v| v * v).sum::<f32>() / s.len() as f32).sqrt()
    };
    m.rms = steady;
    if steady < MIN_RMS {
        return m;
    }
    m.onset_ms = env.iter().position(|&e| e >= 0.5 * steady).map_or(1000.0, |i| i as f32 * 10.0);
    // rms spread over four 75 ms hops
    let hops: Vec<f32> = (0..4).map(|i| {
        let a = s0 + i * (0.075 * SR) as usize;
        let c = &x[a..a + (0.075 * SR) as usize];
        (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()
    }).collect();
    let (hi, lo) = (hops.iter().cloned().fold(0.0, f32::max), hops.iter().cloned().fold(f32::MAX, f32::min));
    m.spread_db = 20.0 * (hi / lo.max(1e-9)).log10();

    let f_note = setup.freq_hz as f64;
    let p_exp = SR as f64 / f_note;
    let w = 3072usize;
    let hi_lag = (2.2 * p_exp) as usize + 1;
    let a_start = x.len() - (w + hi_lag + 1);
    let b_start = a_start.saturating_sub(w);
    let cents = |tau: f64| 1200.0 * (p_exp / tau).log2();
    match (yin(&x, a_start, w, p_exp), yin(&x, b_start, w, p_exp)) {
        (Some((ta, apa)), Some((tb, _))) => {
            m.err_cents = cents(ta) as f32;
            m.drift_cents = (cents(ta) - cents(tb)).abs() as f32;
            m.aperiodicity = apa;
        }
        _ => {
            m.aperiodicity = 1.0;
        }
    }
    m.speaks = m.rms >= MIN_RMS
        && m.peak <= MAX_PEAK
        && m.onset_ms <= MAX_ONSET_MS
        && m.err_cents.abs() <= *MAX_ERR_CENTS_CELL.lock().unwrap()
        && m.drift_cents <= MAX_DRIFT_CENTS
        && m.spread_db <= MAX_SPREAD_DB
        && m.aperiodicity <= MAX_APERIODICITY;
    m
}

fn midi_hz(n: f32) -> f32 {
    440.0 * ((n - 69.0) / 12.0).exp2()
}

fn reason(m: &Meas) -> char {
    if m.speaks {
        '#'
    } else if !m.finite {
        'N'
    } else if m.rms < MIN_RMS {
        '.'
    } else if m.err_cents.abs() > *MAX_ERR_CENTS_CELL.lock().unwrap() {
        if m.err_cents > 0.0 { 'h' } else { 'l' }
    } else if m.aperiodicity > MAX_APERIODICITY {
        'a'
    } else if m.onset_ms > MAX_ONSET_MS {
        's'
    } else if m.drift_cents > MAX_DRIFT_CENTS {
        'd'
    } else if m.spread_db > MAX_SPREAD_DB {
        'p'
    } else {
        'x'
    }
}

fn explore(position: f32, damping: f32, only: Option<(f32, bool)>) {
    let envf = |k: &str, d: f32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let (stiffness, decay) = (envf("STIFF", 0.5), envf("DECAY", 0.6));
    let notes: Vec<f32> = std::env::var("NOTES").map(|v| v.split(',').map(|n| n.parse().unwrap()).collect()).unwrap_or(vec![36.0, 48.0, 60.0, 72.0, 84.0]);
    let anchors = [("reed", 0.0f32), ("reed/jet", 0.25), ("jet", 0.5), ("jet/bow", 0.75), ("bow", 1.0)];
    let rhos: Vec<f32> = (0..16).map(|i| 0.25 * 1.2f32.powi(i)).collect();
    let aps: Vec<f32> = (0..8).map(|i| 0.15 * (i + 1) as f32).collect();
    for (name, ch) in anchors {
        for open in [true, false] {
            for &note in &notes {
                if let Some((c, o)) = only { if c != ch || o != open { continue; } }
                println!("== {name} {} note {note} pos {position}  (rows: aperture {:.2}..{:.2}, cols: drive/aperture {:.2}..{:.2})", if open { "open" } else { "closed" }, aps[0], aps[7], rhos[0], rhos[15]);
                for &ap in &aps {
                    let mut line = String::new();
                    for &rho in &rhos {
                        let raw = Raw { character: ch, aperture: ap, drive: rho * ap, damping, stiffness, reflection: bore_cal::reflection(decay), ..Raw::default() };
                        let setup = NoteSetup { freq_hz: midi_hz(note), open, position, attack_ms: 10.0, ..NoteSetup::default() };
                        line.push(reason(&measure(&raw, &setup)));
                    }
                    println!("{line}");
                }
            }
        }
    }
}

fn survey(damping: f32) {
    let anchors = [("reed", 0.0f32), ("reed/jet", 0.25), ("jet", 0.5), ("jet/bow", 0.75), ("bow", 1.0)];
    let rhos: Vec<f32> = (0..16).map(|i| 0.25 * 1.2f32.powi(i)).collect();
    let aps: Vec<f32> = (0..8).map(|i| 0.15 * (i + 1) as f32).collect();
    let positions = [0.05f32, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    for (name, ch) in anchors {
        for open in [true, false] {
            for note in [48.0f32, 72.0] {
                let mut line = format!("{name:9} {:6} n{note:3}: ", if open { "open" } else { "closed" });
                for &position in &positions {
                    let mut n = 0;
                    for &ap in &aps {
                        for &rho in &rhos {
                            let raw = Raw { character: ch, aperture: ap, drive: rho * ap, damping, ..Raw::default() };
                            let setup = NoteSetup { freq_hz: midi_hz(note), open, position, attack_ms: 10.0, ..NoteSetup::default() };
                            if measure(&raw, &setup).speaks { n += 1; }
                        }
                    }
                    line.push_str(&format!("{n:4}"));
                }
                println!("{line}");
            }
        }
    }
    println!("positions: {positions:?}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("explore") => explore(args.get(2).map_or(0.3, |s| s.parse().unwrap()), args.get(3).map_or(0.3, |s| s.parse().unwrap()), args.get(4).map(|s| (s.parse().unwrap(), args[5] == "open"))),
        Some("sweep") => sweep(&args),
        Some("fit") => fit(&args),
        Some("verify") => verify(),
        Some("survey") => survey(args.get(2).map_or(0.3, |s| s.parse().unwrap())),
        Some("probe") => { let a: Vec<f32> = args[2..].iter().map(|s| s.parse().unwrap()).collect(); probe(a[0], a[1] > 0.5, a[2], a[3], a[4]) }
        _ => eprintln!("usage: bore_calibrate sweep <out.csv> | fit <csv> <outdir> | verify | explore | survey"),
    }
}

#[allow(dead_code)]
fn probe(ch: f32, open: bool, note: f32, ap: f32, dr: f32) {
    let raw = Raw { character: ch, aperture: ap, drive: dr, ..Raw::default() };
    let setup = NoteSetup { freq_hz: midi_hz(note), open, position: 0.3, attack_ms: 10.0, ..NoteSetup::default() };
    println!("{:?}", measure(&raw, &setup));
}

// ---------------------------------------------------------------------------------------------
// The sweep

/// Lowest note the fit covers for an open bore.
const OPEN_NOTE_MIN: i32 = 33;
const ANCHORS: [f32; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];
const FOLDS: [f32; 4] = [0.08, 0.2, 0.35, 0.5];
const NOTE_LO: i32 = 24;
const NOTE_HI: i32 = 96;
static NOTE_STEP_CELL: AtomicUsize = AtomicUsize::new(3);
/// `--pin s,d,r`: hold stiffness, damping and decay fixed for every cell instead of cycling them.
static PIN: Mutex<Option<(f32, f32, f32)>> = Mutex::new(None);
const APS: [f32; 8] = [0.15, 0.30, 0.45, 0.60, 0.75, 0.90, 1.05, 1.20];
const N_DRIVE: usize = 26;
const DRIVE_BASE: f32 = 0.01;
const DRIVE_RATIO: f32 = 1.3;
const STIFFS: [f32; 3] = [0.25, 0.5, 0.75];
const DAMPS: [f32; 3] = [0.1, 0.35, 0.6];
const DECAYS: [f32; 3] = [0.4, 0.7, 1.0];

fn drive_at(j: usize) -> f32 {
    DRIVE_BASE * DRIVE_RATIO.powi(j as i32)
}

fn hash3(a: usize, b: usize, c: usize, salt: u64) -> usize {
    let mut x = (a as u64) * 0x9E37_79B9_7F4A_7C15 ^ (b as u64 + 1) * 0xC2B2_AE3D_27D4_EB4F ^ (c as u64 + 7) * 0x1656_67B1_9E37_79F9 ^ salt;
    x ^= x >> 29;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 32;
    (x % 3) as usize
}

#[derive(Clone, Debug, Default)]
struct CellRec {
    ai: usize,
    open: bool,
    di: usize,
    note: i32,
    stiff: f32,
    damp: f32,
    decay: f32,
    live: bool,
    rows: usize,
    clipped: usize,
    ap_lo: f32,
    ap_hi: f32,
    /// Means over the cell's usable rows / region cells (`la = ln(ap / AP_REF)`).
    m_la: f32,
    m_lo: f32,
    s_lo: f32,
    m_hi: f32,
    s_hi: f32,
    m_lr: f32,
    m_ld: f32,
    r_a: f32,
    r_d: f32,
    tune: f32,
}

struct Job {
    ai: usize,
    open: bool,
    di: usize,
    note: i32,
}

fn jobs() -> Vec<Job> {
    let mut v = Vec::new();
    for ai in 0..ANCHORS.len() {
        for open in [true, false] {
            for di in 0..FOLDS.len() {
                let mut n = NOTE_LO;
                while n <= NOTE_HI {
                    v.push(Job { ai, open, di, note: n });
                    n += NOTE_STEP_CELL.load(Ordering::Relaxed) as i32;
                }
            }
        }
    }
    v
}

fn setup_for(note: f32, open: bool, fold: f32, tune: f32) -> NoteSetup {
    NoteSetup { freq_hz: midi_hz(note), open, position: bore_cal::junction_position(fold, open), tune_cents: tune, attack_ms: 10.0, ..NoteSetup::default() }
}

fn sweep_cell(job: &Job, apply_tune: bool) -> CellRec {
    let (ai, open, di, note) = (job.ai, job.open, job.di, job.note);
    let stiff = STIFFS[hash3(ai * 2 + open as usize, di, note as usize, 1)];
    let damp = DAMPS[hash3(ai * 2 + open as usize, di, note as usize, 2)];
    let decay = DECAYS[hash3(ai * 2 + open as usize, di, note as usize, 3)];
    let (stiff, damp, decay) = PIN.lock().unwrap().unwrap_or((stiff, damp, decay));
    let mut rec = CellRec { ai, open, di, note, stiff, damp, decay, ..Default::default() };
    let fold = FOLDS[di];
    let tune = if apply_tune { bore_cal::eval(note as f32, ANCHORS[ai], fold, open, stiff, damp, decay).tune_cents } else { 0.0 };
    let setup = setup_for(note as f32, open, fold, tune);
    let mut sp = [[false; N_DRIVE]; 8];
    let mut rms = [[0.0f32; N_DRIVE]; 8];
    let mut err = [[0.0f32; N_DRIVE]; 8];
    if bore_cal_too_low(&setup) {
        return rec;
    }
    for (i, &ap) in APS.iter().enumerate() {
        for j in 0..N_DRIVE {
            let raw = Raw { character: ANCHORS[ai], stiffness: stiff, aperture: ap, drive: drive_at(j), damping: damp, reflection: bore_cal::reflection(decay), ..Raw::default() };
            let m = measure(&raw, &setup);
            sp[i][j] = m.speaks;
            rms[i][j] = m.rms;
            err[i][j] = m.err_cents;
        }
    }
    // longest run per row; chain rows by overlap from the row with the longest run
    let runs = |i: usize| -> Vec<(usize, usize)> {
        let mut v = Vec::new();
        let mut j = 0;
        while j < N_DRIVE {
            if sp[i][j] {
                let a = j;
                while j < N_DRIVE && sp[i][j] {
                    j += 1;
                }
                v.push((a, j - 1));
            } else {
                j += 1;
            }
        }
        v
    };
    let all: Vec<Vec<(usize, usize)>> = (0..8).map(runs).collect();
    let mut best = None;
    for (i, r) in all.iter().enumerate() {
        for &(a, b) in r {
            if best.map_or(true, |(_, _, bl)| b - a + 1 > bl) {
                best = Some((i, (a, b), b - a + 1));
            }
        }
    }
    let Some((i0, run0, _)) = best else { return rec };
    let mut chain: Vec<(usize, (usize, usize))> = vec![(i0, run0)];
    let overlap = |p: (usize, usize), q: (usize, usize)| (p.1.min(q.1) as i32 - p.0.max(q.0) as i32 + 1).max(0);
    let mut prev = run0;
    for i in i0 + 1..8 {
        match all[i].iter().max_by_key(|&&r| overlap(prev, r)) {
            Some(&r) if overlap(prev, r) > 0 => {
                chain.push((i, r));
                prev = r;
            }
            _ => break,
        }
    }
    prev = run0;
    for i in (0..i0).rev() {
        match all[i].iter().max_by_key(|&&r| overlap(prev, r)) {
            Some(&r) if overlap(prev, r) > 0 => {
                chain.push((i, r));
                prev = r;
            }
            _ => break,
        }
    }
    chain.sort_by_key(|c| c.0);
    // trim the ends to usable rows (a run of at least 3 cells)
    while chain.first().is_some_and(|c| c.1 .1 - c.1 .0 + 1 < 3) {
        chain.remove(0);
    }
    while chain.last().is_some_and(|c| c.1 .1 - c.1 .0 + 1 < 3) {
        chain.pop();
    }
    if chain.len() < 3 {
        return rec;
    }
    let half = DRIVE_RATIO.sqrt();
    let (mut xs, mut ylo, mut yhi) = (vec![], vec![], vec![]);
    // region cells: (la, ln drive, ln rms)
    let mut pts: Vec<(f64, f64, f64)> = vec![];
    let mut tunes = vec![];
    for &(i, (a, b)) in &chain {
        let la = (APS[i] / bore_cal::AP_REF).ln() as f64;
        xs.push(la);
        if a == 0 {
            rec.clipped += 1;
        }
        ylo.push((drive_at(a) / half).ln() as f64);
        yhi.push((drive_at(b) * half).ln() as f64);
        for j in a..=b {
            pts.push((la, drive_at(j).ln() as f64, (rms[i][j] as f64).ln()));
            tunes.push(tune + err[i][j]);
        }
    }
    let line = |y: &[f64]| -> (f64, f64) {
        let n = xs.len() as f64;
        let (sx, sy) = (xs.iter().sum::<f64>(), y.iter().sum::<f64>());
        let sxx: f64 = xs.iter().map(|x| x * x).sum();
        let sxy: f64 = xs.iter().zip(y).map(|(x, y)| x * y).sum();
        let den = n * sxx - sx * sx;
        let slope = if den.abs() > 1e-9 { (n * sxy - sx * sy) / den } else { 0.0 };
        ((sy - slope * sx) / n, slope)
    };
    let nr = xs.len() as f64;
    let m_la = xs.iter().sum::<f64>() / nr;
    let (_, s_lo) = line(&ylo);
    let (_, s_hi) = line(&yhi);
    rec.m_la = m_la as f32;
    rec.m_lo = (ylo.iter().sum::<f64>() / nr) as f32;
    rec.m_hi = (yhi.iter().sum::<f64>() / nr) as f32;
    rec.s_lo = s_lo as f32;
    rec.s_hi = s_hi as f32;
    // ln rms ~ m + r_a (la - mean la) + r_d (ld - mean ld) over the region cells
    {
        let n = pts.len() as f64;
        let (ma, md, mr) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n, pts.iter().map(|p| p.2).sum::<f64>() / n);
        let (mut saa, mut sdd, mut sad, mut sar, mut sdr) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for p in &pts {
            let (a, d, r) = (p.0 - ma, p.1 - md, p.2 - mr);
            saa += a * a;
            sdd += d * d;
            sad += a * d;
            sar += a * r;
            sdr += d * r;
        }
        let det = saa * sdd - sad * sad;
        let (ra, rd) = if det.abs() > 1e-9 { ((sar * sdd - sdr * sad) / det, (sdr * saa - sar * sad) / det) } else { (0.0, 0.0) };
        rec.m_ld = md as f32;
        rec.m_lr = mr as f32;
        rec.r_a = ra as f32;
        rec.r_d = rd as f32;
    }
    tunes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    rec.live = true;
    rec.rows = chain.len();
    rec.ap_lo = APS[chain[0].0];
    rec.ap_hi = APS[chain[chain.len() - 1].0];
    rec.tune = tunes[tunes.len() / 2];
    rec
}

fn bore_cal_too_low(setup: &NoteSetup) -> bool {
    !Bore::fits(SR, setup.freq_hz, setup.open, setup.position)
}

fn csv_header() -> &'static str {
    "anchor,open,fold,note,stiff,damp,decay,live,rows,clipped,ap_lo,ap_hi,m_la,m_lo,s_lo,m_hi,s_hi,m_lr,m_ld,r_a,r_d,tune"
}

fn csv_line(r: &CellRec) -> String {
    format!(
        "{},{},{},{},{},{},{},{},{},{},{},{},{:.5},{:.5},{:.5},{:.5},{:.5},{:.5},{:.5},{:.5},{:.5},{:.3}",
        r.ai, r.open as u8, r.di, r.note, r.stiff, r.damp, r.decay, r.live as u8, r.rows, r.clipped, r.ap_lo, r.ap_hi, r.m_la, r.m_lo, r.s_lo, r.m_hi, r.s_hi, r.m_lr, r.m_ld, r.r_a, r.r_d, r.tune
    )
}

fn sweep(args: &[String]) {
    let path = args.get(2).expect("sweep <out.csv>");
    let apply_tune = args.iter().any(|a| a == "--apply-tune");
    if let Some(i) = args.iter().position(|a| a == "--pin") {
        let v: Vec<f32> = args[i + 1].split(',').map(|x| x.parse().unwrap()).collect();
        *PIN.lock().unwrap() = Some((v[0], v[1], v[2]));
    }
    if let Some(i) = args.iter().position(|a| a == "--note-step") {
        NOTE_STEP_CELL.store(args[i + 1].parse().unwrap(), Ordering::Relaxed);
    }
    if let Some(i) = args.iter().position(|a| a == "--err") {
        *MAX_ERR_CENTS_CELL.lock().unwrap() = args[i + 1].parse().unwrap();
    }
    let js = jobs();
    let next = AtomicUsize::new(0);
    let out = Mutex::new(Vec::<CellRec>::new());
    let t0 = std::time::Instant::now();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                if k >= js.len() {
                    break;
                }
                let r = sweep_cell(&js[k], apply_tune);
                out.lock().unwrap().push(r);
            });
        }
    });
    let mut v = out.into_inner().unwrap();
    v.sort_by_key(|r| (r.ai, !r.open, r.di, r.note));
    let mut text = String::from(csv_header());
    text.push('\n');
    for r in &v {
        text.push_str(&csv_line(r));
        text.push('\n');
    }
    std::fs::write(path, text).unwrap();
    let live = v.iter().filter(|r| r.live).count();
    println!("{} cells ({} live) in {:.1}s -> {path}", v.len(), live, t0.elapsed().as_secs_f32());
}

// ---------------------------------------------------------------------------------------------
// The fit

const Q_NAMES: [&str; 10] = ["ap_lo", "ap_hi", "ln drive lo (at ap 0.6)", "lo slope (d ln drive / d ln ap)", "ln drive hi (at ap 0.6)", "hi slope", "ln rms at ap 0.6, drive 1", "rms slope in ln ap", "rms slope in ln drive", "tune (cents)"];
const Q_IDS: [usize; 10] = [bore_cal::AP_LO, bore_cal::AP_HI, bore_cal::LO, bore_cal::LO_SLOPE, bore_cal::HI, bore_cal::HI_SLOPE, bore_cal::R0, bore_cal::R_A, bore_cal::R_D, bore_cal::TUNE];
/// Quantities fitted as one constant per anchor (the median over cells).
const CONST_Q: [usize; 4] = [bore_cal::LO_SLOPE, bore_cal::HI_SLOPE, bore_cal::R_A, bore_cal::R_D];
const F_NAMES: [&str; bore_cal::N_FEAT] = ["1", "note", "fold", "open", "stiffness", "damping", "ln loss(decay)", "note^2", "2^note_oct-1 (freq)", "fold^2"];
const ANCHOR_NAMES: [&str; 5] = ["reed", "reed/jet", "jet", "jet/bow", "bow"];
const BASE_FEATS: [usize; 7] = [0, 1, 2, 3, 4, 5, 6];
const CURVE_FEATS: [usize; 3] = [7, 8, 9];
/// A curve feature is kept only if it cuts the rms residual by at least this fraction.
const CURVE_GAIN: f64 = 0.20;

fn read_csv(path: &str) -> Vec<CellRec> {
    let text = std::fs::read_to_string(path).unwrap();
    text.lines().skip(1).map(|l| {
        let f: Vec<&str> = l.split(',').collect();
        CellRec {
            ai: f[0].parse().unwrap(),
            open: f[1] == "1",
            di: f[2].parse().unwrap(),
            note: f[3].parse().unwrap(),
            stiff: f[4].parse().unwrap(),
            damp: f[5].parse().unwrap(),
            decay: f[6].parse().unwrap(),
            live: f[7] == "1",
            rows: f[8].parse().unwrap(),
            clipped: f[9].parse().unwrap(),
            ap_lo: f[10].parse().unwrap(),
            ap_hi: f[11].parse().unwrap(),
            m_la: f[12].parse().unwrap(),
            m_lo: f[13].parse().unwrap(),
            s_lo: f[14].parse().unwrap(),
            m_hi: f[15].parse().unwrap(),
            s_hi: f[16].parse().unwrap(),
            m_lr: f[17].parse().unwrap(),
            m_ld: f[18].parse().unwrap(),
            r_a: f[19].parse().unwrap(),
            r_d: f[20].parse().unwrap(),
            tune: f[21].parse().unwrap(),
        }
    }).collect()
}

/// Per-anchor slope constants (medians of the per-cell slopes).
#[derive(Clone, Copy, Default)]
struct Pool {
    s_lo: f64,
    s_hi: f64,
    r_a: f64,
    r_d: f64,
}

fn median(v: &mut Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() { 0.0 } else { v[v.len() / 2] }
}

fn pool_of(recs: &[CellRec], ai: usize) -> Pool {
    let live: Vec<&CellRec> = recs.iter().filter(|r| r.ai == ai && r.live).collect();
    let m = |f: &dyn Fn(&CellRec) -> f32| median(&mut live.iter().map(|r| f(r) as f64).collect());
    Pool { s_lo: m(&|r| r.s_lo), s_hi: m(&|r| r.s_hi), r_a: m(&|r| r.r_a), r_d: m(&|r| r.r_d) }
}

fn q_value(r: &CellRec, q: usize, p: &Pool) -> f64 {
    let (la, ld, lr) = (r.m_la as f64, r.m_ld as f64, r.m_lr as f64);
    match q {
        bore_cal::AP_LO => r.ap_lo as f64,
        bore_cal::AP_HI => r.ap_hi as f64,
        bore_cal::LO => r.m_lo as f64 - p.s_lo * la,
        bore_cal::LO_SLOPE => r.s_lo as f64,
        bore_cal::HI => r.m_hi as f64 - p.s_hi * la,
        bore_cal::HI_SLOPE => r.s_hi as f64,
        bore_cal::R0 => lr - p.r_a * la - p.r_d * ld,
        bore_cal::R_A => r.r_a as f64,
        bore_cal::R_D => r.r_d as f64,
        _ => r.tune as f64,
    }
}

fn feats(r: &CellRec) -> [f32; bore_cal::N_FEAT] {
    bore_cal::features(r.note as f32, FOLDS[r.di], r.open, r.stiff, r.damp, r.decay)
}

/// Least squares on the chosen columns (normal equations, tiny ridge). Returns weights over all
/// features (zero off the chosen set).
fn lstsq(x: &[Vec<f64>], y: &[f64], cols: &[usize]) -> Vec<f64> {
    lstsq_n(x, y, cols, bore_cal::N_FEAT)
}

fn lstsq_n(x: &[Vec<f64>], y: &[f64], cols: &[usize], nf: usize) -> Vec<f64> {
    // Iteratively reweighted least squares (weights 1/max(|residual|, 0.05)): close to an L1 fit, so the
    // odd "wolf note" cell that flips to another mode does not drag the typical cell's fit.
    let mut wt = vec![1.0f64; x.len()];
    let mut w = lstsq_w(x, y, cols, nf, &wt);
    for _ in 0..8 {
        for (i, (row, &yy)) in x.iter().zip(y).enumerate() {
            let p: f64 = row.iter().zip(&w).map(|(a, b)| a * b).sum();
            wt[i] = 1.0 / (yy - p).abs().max(0.05);
        }
        w = lstsq_w(x, y, cols, nf, &wt);
    }
    w
}

fn lstsq_w(x: &[Vec<f64>], y: &[f64], cols: &[usize], nf: usize, wt: &[f64]) -> Vec<f64> {
    let k = cols.len();
    let mut a = vec![vec![0.0f64; k + 1]; k];
    for ((row, &yy), &wi) in x.iter().zip(y).zip(wt) {
        for i in 0..k {
            for j in 0..k {
                a[i][j] += wi * row[cols[i]] * row[cols[j]];
            }
            a[i][k] += wi * row[cols[i]] * yy;
        }
    }
    for i in 0..k {
        a[i][i] += 1e-9;
    }
    for i in 0..k {
        let p = (i..k).max_by(|&p, &q| a[p][i].abs().partial_cmp(&a[q][i].abs()).unwrap()).unwrap();
        a.swap(i, p);
        let d = a[i][i];
        if d.abs() < 1e-12 {
            continue;
        }
        for j in i..=k {
            a[i][j] /= d;
        }
        for r in 0..k {
            if r != i {
                let f = a[r][i];
                for j in i..=k {
                    a[r][j] -= f * a[i][j];
                }
            }
        }
    }
    let mut w = vec![0.0; nf];
    for (i, &c) in cols.iter().enumerate() {
        w[c] = a[i][k];
    }
    w
}

fn rms_of(x: &[Vec<f64>], y: &[f64], w: &[f64]) -> f64 {
    let s: f64 = x.iter().zip(y).map(|(r, &y)| { let p: f64 = r.iter().zip(w).map(|(a, b)| a * b).sum(); (p - y).powi(2) }).sum();
    (s / x.len().max(1) as f64).sqrt()
}

struct QFit {
    w: Vec<f64>,
    n: usize,
    spread: f64,
    rms_lin: f64,
    rms: f64,
    max: f64,
    curves: Vec<usize>,
    /// residual rms per note bin for the linear fit (structure check)
    bins: Vec<(i32, f64)>,
}

fn fit_q(rows: &[&CellRec], q: usize, pool: &Pool) -> QFit {
    let x: Vec<Vec<f64>> = rows.iter().map(|r| feats(r).iter().map(|&v| v as f64).collect()).collect();
    let y: Vec<f64> = rows.iter().map(|r| q_value(r, q, pool)).collect();
    let mean = y.iter().sum::<f64>() / y.len().max(1) as f64;
    let spread = (y.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / y.len().max(1) as f64).sqrt();
    if CONST_Q.contains(&q) {
        let med = median(&mut y.clone());
        let mut w = vec![0.0; bore_cal::N_FEAT];
        w[0] = med;
        let rms = (y.iter().map(|v| (v - med).powi(2)).sum::<f64>() / y.len() as f64).sqrt();
        let max = y.iter().map(|v| (v - med).abs()).fold(0.0, f64::max);
        return QFit { w, n: rows.len(), spread, rms_lin: rms, rms, max, curves: vec![], bins: vec![] };
    }
    let mut cols: Vec<usize> = BASE_FEATS.to_vec();
    let mut w = lstsq(&x, &y, &cols);
    let rms_lin = rms_of(&x, &y, &w);
    let mut cur = rms_lin;
    let mut curves = vec![];
    // residual means by note bin for the linear fit
    let mut bins = vec![];
    for b in 0..6 {
        let (lo, hi) = (NOTE_LO + b * 12, NOTE_LO + b * 12 + 12);
        let res: Vec<f64> = rows.iter().zip(&x).filter(|(r, _)| r.note >= lo && r.note < hi).map(|(r, row)| { let p: f64 = row.iter().zip(&w).map(|(a, b)| a * b).sum(); q_value(r, q, pool) - p }).collect();
        if !res.is_empty() {
            bins.push((lo, res.iter().sum::<f64>() / res.len() as f64));
        }
    }
    loop {
        let mut best: Option<(usize, f64, Vec<f64>)> = None;
        for &c in &CURVE_FEATS {
            if cols.contains(&c) {
                continue;
            }
            let mut cc = cols.clone();
            cc.push(c);
            let ww = lstsq(&x, &y, &cc);
            let r = rms_of(&x, &y, &ww);
            if best.as_ref().map_or(true, |b| r < b.1) {
                best = Some((c, r, ww));
            }
        }
        match best {
            Some((c, r, ww)) if r < cur * (1.0 - CURVE_GAIN) => {
                cols.push(c);
                curves.push(c);
                w = ww;
                cur = r;
            }
            _ => break,
        }
    }
    if std::env::var("DIAG").is_ok() {
        // diagnostic only: how much would all pairwise products of the base features explain?
        let mut xx: Vec<Vec<f64>> = vec![];
        for row in &x {
            let mut v: Vec<f64> = BASE_FEATS.iter().map(|&c| row[c]).collect();
            for a in 1..BASE_FEATS.len() {
                for b in a..BASE_FEATS.len() {
                    v.push(row[BASE_FEATS[a]] * row[BASE_FEATS[b]]);
                }
            }
            xx.push(v);
        }
        let cols: Vec<usize> = (0..xx[0].len()).collect();
        let mut wide: Vec<Vec<f64>> = xx.clone();
        for r in &mut wide { r.resize(64, 0.0); }
        let mut cc = cols.clone();
        cc.truncate(64);
        let ww = lstsq_n(&wide, &y, &cc, 64);
        let r: f64 = (wide.iter().zip(&y).map(|(r, &y)| { let p: f64 = r.iter().zip(&ww).map(|(a, b)| a * b).sum(); (p - y).powi(2) }).sum::<f64>() / y.len() as f64).sqrt();
        eprintln!("DIAG q{q} n{} base rms {cur:.3} pairwise rms {r:.3} spread {spread:.3}", rows.len());
    }
    let max = rows.iter().zip(&x).map(|(r, row)| { let p: f64 = row.iter().zip(&w).map(|(a, b)| a * b).sum(); (q_value(r, q, pool) - p).abs() }).fold(0.0, f64::max);
    QFit { w, n: rows.len(), spread, rms_lin, rms: cur, max, curves, bins }
}

struct RangeFit {
    w: [[f64; 3]; 2],
    rms: [f64; 2],
    max: [f64; 2],
}

fn fit_range(recs: &[CellRec], ai: usize) -> Option<(RangeFit, Vec<(f32, bool, i32, i32)>)> {
    let mut pts = vec![]; // (fold, open, lo, hi)
    for open in [true, false] {
        for di in 0..FOLDS.len() {
            let live: Vec<i32> = recs.iter().filter(|r| r.ai == ai && r.open == open && r.di == di && r.live).map(|r| r.note).collect();
            if live.len() >= 3 {
                pts.push((FOLDS[di], open, *live.iter().min().unwrap(), *live.iter().max().unwrap()));
            }
        }
    }
    if pts.len() < 4 {
        return None;
    }
    let x: Vec<Vec<f64>> = pts.iter().map(|p| vec![1.0, p.0 as f64, p.1 as u8 as f64]).collect();
    let mut w = [[0.0; 3]; 2];
    let mut rms = [0.0; 2];
    let mut max = [0.0; 2];
    for k in 0..2 {
        let y: Vec<f64> = pts.iter().map(|p| if k == 0 { p.2 as f64 - 1.5 } else { p.3 as f64 + 1.5 }).collect();
        let mut x7: Vec<Vec<f64>> = x.iter().map(|r| { let mut v = r.clone(); v.resize(bore_cal::N_FEAT, 0.0); v }).collect();
        let ww = lstsq(&x7, &y, &[0, 1, 2]);
        rms[k] = rms_of(&x7, &y, &ww);
        max[k] = x7.iter_mut().zip(&y).map(|(r, &y)| (r.iter().zip(&ww).map(|(a, b)| a * b).sum::<f64>() - y).abs()).fold(0.0, f64::max);
        w[k] = [ww[0], ww[1], ww[2]];
    }
    Some((RangeFit { w, rms, max }, pts))
}

const COLORS: [&str; 5] = ["#2a6fdb", "#2a9d8f", "#8a8d91", "#e9a23b", "#d1495b"];

fn svg_scatter(path: &str, title: &str, pts: &[(usize, f64, f64, f64)]) {
    // pts: (anchor, note, measured, fitted)
    let (w, h) = (900.0, 330.0);
    let panel = |x0: f64, xs: &[(f64, f64, usize)], xl: &str, yl: &str| -> String {
        let (xmin, xmax) = xs.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.0), a.1.max(p.0)));
        let (ymin, ymax) = xs.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.1), a.1.max(p.1)));
        let (xr, yr) = ((xmax - xmin).max(1e-9), (ymax - ymin).max(1e-9));
        let (pw, ph) = (370.0, 230.0);
        let mut s = format!("<rect x=\"{x0}\" y=\"50\" width=\"{pw}\" height=\"{ph}\" fill=\"none\" stroke=\"#bbb\"/>");
        for &(a, b, ai) in xs {
            let (px, py) = (x0 + (a - xmin) / xr * pw, 50.0 + ph - (b - ymin) / yr * ph);
            s.push_str(&format!("<circle cx=\"{px:.1}\" cy=\"{py:.1}\" r=\"2\" fill=\"{}\" fill-opacity=\"0.6\"/>", COLORS[ai]));
        }
        s.push_str(&format!("<text x=\"{x0}\" y=\"{}\" font-size=\"11\" fill=\"#555\">{xl}: {xmin:.2} .. {xmax:.2}</text>", 50.0 + ph + 16.0));
        s.push_str(&format!("<text x=\"{x0}\" y=\"44\" font-size=\"11\" fill=\"#555\">{yl}: {ymin:.3} .. {ymax:.3}</text>"));
        s
    };
    let a: Vec<(f64, f64, usize)> = pts.iter().map(|p| (p.2, p.3, p.0)).collect();
    let b: Vec<(f64, f64, usize)> = pts.iter().map(|p| (p.1, p.2 - p.3, p.0)).collect();
    let mut svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" font-family=\"sans-serif\"><rect width=\"100%\" height=\"100%\" fill=\"white\"/><text x=\"20\" y=\"22\" font-size=\"14\" font-weight=\"bold\">{title}</text>");
    svg.push_str(&panel(20.0, &a, "measured", "fitted"));
    svg.push_str(&panel(480.0, &b, "note", "residual"));
    for (i, n) in ANCHOR_NAMES.iter().enumerate() {
        svg.push_str(&format!("<circle cx=\"{}\" cy=\"312\" r=\"4\" fill=\"{}\"/><text x=\"{}\" y=\"316\" font-size=\"11\">{n}</text>", 30 + i * 90, COLORS[i], 38 + i * 90));
    }
    svg.push_str("</svg>");
    std::fs::write(path, svg).unwrap();
}

fn fit(args: &[String]) {
    let csv = args.get(2).expect("fit <csv> <outdir>");
    let outdir = args.get(3).expect("fit <csv> <outdir>");
    let emit = args.iter().any(|a| a == "--emit");
    let mut recs = read_csv(csv);
    // An open bore below MIDI 33 is a different regime (the upper edge of the band runs off the grid, the level model
    // flips): it is outside the working range, so the fit leaves it out and the range starts at 33.
    recs.retain(|r| !(r.open && r.note < OPEN_NOTE_MIN));
    let mut report = String::new();
    let mut coef = vec![vec![vec![0.0f64; bore_cal::N_FEAT]; bore_cal::N_Q]; 5];
    report.push_str(&format!("# Bore calibration fit\n\nGenerated by `bore_calibrate fit` from `{csv}` ({} cells, {} live).\n\n", recs.len(), recs.iter().filter(|r| r.live).count()));
    report.push_str("## Live cells by anchor and bore\n\n| anchor | open | closed |\n|---|---|---|\n");
    for ai in 0..5 {
        let c = |o: bool| { let all = recs.iter().filter(|r| r.ai == ai && r.open == o).count(); let l = recs.iter().filter(|r| r.ai == ai && r.open == o && r.live).count(); format!("{l}/{all}") };
        report.push_str(&format!("| {} | {} | {} |\n", ANCHOR_NAMES[ai], c(true), c(false)));
    }
    report.push_str("\n## Fits\n\nEach row: least squares on the linear features (`1, note, fold, open, stiffness, damping, decay`), then a curve feature (`note^2`, linear frequency, `fold^2`) is added only if it cuts the rms residual by at least 20%.\n`spread` is the standard deviation of the quantity itself, so rms/spread is the unexplained fraction.\n\n| quantity | anchor | n | spread | rms (linear) | rms (final) | max | curve terms |\n|---|---|---|---|---|---|---|---|\n");
    let mut all_pts: Vec<Vec<(usize, f64, f64, f64)>> = vec![vec![]; 10];
    let mut structure = String::new();
    let pools: Vec<Pool> = (0..5).map(|ai| pool_of(&recs, ai)).collect();
    for (qi, &q) in Q_IDS.iter().enumerate() {
        for ai in 0..5 {
            let rows: Vec<&CellRec> = recs.iter().filter(|r| r.ai == ai && r.live).collect();
            if rows.len() < 12 {
                report.push_str(&format!("| {} | {} | {} | - | - | - | - | too few live cells |\n", Q_NAMES[qi], ANCHOR_NAMES[ai], rows.len()));
                continue;
            }
            let f = fit_q(&rows, q, &pools[ai]);
            for r in &rows {
                let x = feats(r);
                let p: f64 = x.iter().zip(&f.w).map(|(a, b)| *a as f64 * b).sum();
                all_pts[qi].push((ai, r.note as f64, q_value(r, q, &pools[ai]), p));
            }
            let curves = if f.curves.is_empty() { "none (linear)".to_string() } else { f.curves.iter().map(|&c| F_NAMES[c]).collect::<Vec<_>>().join(", ") };
            report.push_str(&format!("| {} | {} | {} | {:.3} | {:.3} | {:.3} | {:.3} | {} |\n", Q_NAMES[qi], ANCHOR_NAMES[ai], f.n, f.spread, f.rms_lin, f.rms, f.max, curves));
            let b = f.bins.iter().map(|(n, m)| format!("{n}:{m:+.2}")).collect::<Vec<_>>().join(" ");
            structure.push_str(&format!("- {} / {}: linear-fit residual mean by note octave (start note:mean) {}\n", Q_NAMES[qi], ANCHOR_NAMES[ai], b));
            coef[ai][q] = f.w.clone();
        }
        svg_scatter(&format!("{outdir}/fit_{}.svg", Q_IDS[qi]), &format!("{} (fitted vs measured; residual vs note)", Q_NAMES[qi]), &all_pts[qi]);
    }
    report.push_str("\n## Residual structure of the linear fits\n\nIf the means by octave swing by more than the rms they reveal curvature in pitch.\n\n");
    report.push_str(&structure);
    // note range
    report.push_str("\n## Note ranges\n\nThe lowest and highest live grid note per (anchor, bore, fold), widened by half a step, fitted linearly in `fold` and `open`.\n\n| anchor | bore | fold 0.08 | 0.2 | 0.35 | 0.5 |\n|---|---|---|---|---|---|\n");
    let mut range = [[[0.0f64; 3]; 2]; 5];
    for ai in 0..5 {
        for open in [true, false] {
            let cell = |di: usize| {
                let live: Vec<i32> = recs.iter().filter(|r| r.ai == ai && r.open == open && r.di == di && r.live).map(|r| r.note).collect();
                if live.len() >= 3 { format!("{}-{}", live.iter().min().unwrap(), live.iter().max().unwrap()) } else { "-".into() }
            };
            report.push_str(&format!("| {} | {} | {} | {} | {} | {} |\n", ANCHOR_NAMES[ai], if open { "open" } else { "closed" }, cell(0), cell(1), cell(2), cell(3)));
        }
    }
    report.push_str("\nRange fit residuals (notes):\n\n");
    for ai in 0..5 {
        match fit_range(&recs, ai) {
            Some((rf, _)) => {
                range[ai] = rf.w;
                report.push_str(&format!("- {}: low rms {:.2} max {:.2}; high rms {:.2} max {:.2}\n", ANCHOR_NAMES[ai], rf.rms[0], rf.max[0], rf.rms[1], rf.max[1]));
            }
            None => report.push_str(&format!("- {}: too few live cells\n", ANCHOR_NAMES[ai])),
        }
    }
    // coefficients
    report.push_str("\n## Coefficients\n\nFeature order: ");
    report.push_str(&F_NAMES.join(", "));
    report.push_str("\n\n```\n");
    for ai in 0..5 {
        for (qi, &q) in Q_IDS.iter().enumerate() {
            report.push_str(&format!("{:9} {:34} {}\n", ANCHOR_NAMES[ai], Q_NAMES[qi], coef[ai][q].iter().map(|v| format!("{v:+.4}")).collect::<Vec<_>>().join(" ")));
        }
    }
    report.push_str("```\n");
    std::fs::write(format!("{outdir}/fit.md"), &report).unwrap();
    println!("{report}");

    if emit {
        let mut t = String::new();
        t.push_str("// BEGIN GENERATED (bore_calibrate fit)\n");
        t.push_str(&format!("// Generator: `bore_calibrate sweep` + `fit --emit` (docs/bore/). Grid: {} anchors x 2 bores x {} folds x notes {}..{} step {}, {}x{} aperture/drive cells each,\n// stiffness/damping/decay cycled over 3 levels per cell. Fit error per quantity and anchor: docs/bore/fit.md.\n", ANCHOR_NAMES.len(), FOLDS.len(), NOTE_LO, NOTE_HI, NOTE_STEP_CELL.load(Ordering::Relaxed), APS.len(), N_DRIVE));
        t.push_str("/// `COEF[anchor][quantity][feature]`; see the module docs.\n#[rustfmt::skip]\npub const COEF: [[[f32; N_FEAT]; N_Q]; N_ANCHORS] = [\n");
        for ai in 0..5 {
            t.push_str("    [\n");
            for q in 0..bore_cal::N_Q {
                t.push_str(&format!("        [{}],\n", coef[ai][q].iter().map(|v| format!("{v:.5}")).collect::<Vec<_>>().join(", ")));
            }
            t.push_str("    ],\n");
        }
        t.push_str("];\n/// `RANGE[anchor][0 low / 1 high][1, fold, open]`: the working note range.\n#[rustfmt::skip]\npub const RANGE: [[[f32; 3]; 2]; N_ANCHORS] = [\n");
        for ai in 0..5 {
            t.push_str(&format!("    [[{:.4}, {:.4}, {:.4}], [{:.4}, {:.4}, {:.4}]],\n", range[ai][0][0], range[ai][0][1], range[ai][0][2], range[ai][1][0], range[ai][1][1], range[ai][1][2]));
        }
        t.push_str("];\n// END GENERATED\n");
        let p = "crates/dsp/src/bore_cal.rs";
        let src = std::fs::read_to_string(p).unwrap();
        let a = src.find("// BEGIN GENERATED").unwrap();
        let b = src.find("// END GENERATED").unwrap() + "// END GENERATED\n".len();
        std::fs::write(p, format!("{}{}{}", &src[..a], t, &src[b..])).unwrap();
        println!("wrote {p}");
        println!("REMINDER: bump BORE_CAL_REV in {p}, then re-check the bore presets (client/src/content/presets.ts, calRev).");
    }
}

/// Render the fitted table the way the engine will (default knobs except the swept ones) and
/// print, per anchor / bore / position, which notes speak at breath 0, 0.5 and 1.
fn verify() {
    let notes: Vec<i32> = (24..=96).step_by(6).collect();
    println!("notes: {notes:?}   (S = speaks at breath 0/.5/1 -> count 0..3)");
    let mut total = 0;
    let mut ok = 0;
    for (ai, name) in ANCHOR_NAMES.iter().enumerate() {
        for open in [true, false] {
            for pos in [0.1f32, 0.3, 0.5] {
                let mut line = format!("{name:9} {:6} pos {pos:.1}: ", if open { "open" } else { "closed" });
                for &n in &notes {
                    let mut c = 0;
                    for breath in [0.0f32, 0.5, 1.0] {
                        let k = bore_cal::Knobs { character: ai as f32 * 0.25, open, position: pos, breath, ..Default::default() };
                        let r = bore_cal::resolve(n as f32, &k);
                        let setup = NoteSetup { freq_hz: midi_hz(n as f32), open, position: r.position, tune_cents: r.tune_cents, attack_ms: 10.0, ..NoteSetup::default() };
                        total += 1;
                        if measure(&r.raw, &setup).speaks {
                            c += 1;
                            ok += 1;
                        }
                    }
                    line.push_str(&format!("{c:2}"));
                }
                println!("{line}");
            }
        }
    }
    println!("speaks {ok}/{total}");
}
