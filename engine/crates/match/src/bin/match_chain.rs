//! `match_chain <sf2> <outdir> [gens] [pop] [--only a,b]`: joint fit of bore + vibrato + body resonator (strings) +
//! lowpass + EQ against dry GM targets, body and EQ gains solved in closed form per candidate; the loss adds a vibrato
//! (pitch track) term. Then a reverb fit against the soundfont's wet render. Writes wavs, best.json per program and
//! results.md.
use match_::*;
use rayon::prelude::*;
use std::{fmt::Write as _, fs, path::Path};

/// Violin body peaks (air mode, body modes, bridge hill); the cello's sit roughly 0.4x lower.
const VIOLIN_BODY: [f32; 8] = [275.0, 400.0, 460.0, 540.0, 700.0, 1000.0, 2500.0, 3200.0];

struct Prog { gm: i32, name: &'static str, keys: [u32; 3], strings: bool }
const PROGRAMS: [Prog; 5] = [
    Prog { gm: 71, name: "clarinet", keys: [55, 62, 69], strings: false },
    Prog { gm: 65, name: "alto-sax", keys: [57, 64, 71], strings: false },
    Prog { gm: 73, name: "flute", keys: [67, 74, 81], strings: false },
    Prog { gm: 42, name: "cello", keys: [41, 52, 62], strings: true },
    Prog { gm: 40, name: "violin", keys: [60, 69, 79], strings: true },
];
const PENALTY: f32 = 60.0;

fn setup(p: &Prog) -> Setup {
    if !p.strings {
        return Setup { character: (0.0, 1.0), body: None };
    }
    let k = if p.name == "cello" { 0.4 } else { 1.0 };
    Setup { character: (0.75, 1.0), body: Some(VIOLIN_BODY.map(|f| f * k)) }
}

struct Rng(u64);
impl Rng {
    fn u(&mut self) -> f64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; (self.0 >> 11) as f64 / (1u64 << 53) as f64 }
    fn n(&mut self) -> f64 { (-2.0 * self.u().max(1e-12).ln()).sqrt() * (6.2831853 * self.u()).cos() }
}

struct Fit<'a> { probes: &'a [Probe], ts: &'a [Target], lt: &'a [Vec<f64>], su: &'a Setup }

/// Score one candidate with its own optimal body/EQ gains. Returns the loss and the chain (gains filled in).
fn eval(x: &[f64], open: bool, f: &Fit) -> (f32, Chain) {
    let mut c = chain_from(x, open, f.su);
    let pre: Option<Vec<Vec<f32>>> = f.probes.iter().map(|p| pre_eq(&c, *p)).collect();
    let Some(mut pre) = pre else { return (PENALTY, c) };
    solve_gains(&mut c, f.lt, &pre);
    let mut tot = 0.0;
    for ((y, t), p) in pre.iter_mut().zip(f.ts).zip(f.probes) {
        finish(&c, y);
        tot += if y.iter().all(|v| v.is_finite()) { loss_pitched(t, y, *p) } else { PENALTY };
    }
    (tot / f.probes.len() as f32, c)
}

/// (mu/mu, lambda)-ES with a scattered start; `score` returns the loss for a normalised point.
fn es(d: usize, seed: u64, gens: usize, pop: usize, score: &(dyn Fn(&[f64]) -> f32 + Sync)) -> (Vec<f64>, f32) {
    let mut rng = Rng(seed | 1);
    let starts: Vec<Vec<f64>> = (0..pop * 3).map(|_| (0..d).map(|_| rng.u()).collect()).collect();
    let sc: Vec<f32> = starts.par_iter().map(|x| score(x)).collect();
    let bi = (0..starts.len()).min_by(|&a, &b| sc[a].total_cmp(&sc[b])).unwrap();
    let (mut mean, mut best, mut bl) = (starts[bi].clone(), starts[bi].clone(), sc[bi]);
    let mut sigma = 0.25;
    for _ in 0..gens {
        let cands: Vec<Vec<f64>> = (0..pop).map(|_| mean.iter().map(|m| (m + sigma * rng.n()).clamp(0.0, 1.0)).collect()).collect();
        let sc: Vec<f32> = cands.par_iter().map(|x| score(x)).collect();
        let mut idx: Vec<usize> = (0..pop).collect();
        idx.sort_by(|&a, &b| sc[a].total_cmp(&sc[b]));
        let mu = pop / 4;
        mean = (0..d).map(|k| idx[..mu].iter().map(|&i| cands[i][k]).sum::<f64>() / mu as f64).collect();
        if sc[idx[0]] < bl { bl = sc[idx[0]]; best = cands[idx[0]].clone(); sigma = (sigma * 1.1).min(0.4); } else { sigma = (sigma * 0.93).max(0.02); }
    }
    (best, bl)
}

fn reverb_real(x: &[f64]) -> [f32; 4] {
    [x[0] as f32, x[1] as f32, x[2] as f32, (x[3] * x[3] * 80.0) as f32]
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let sf2 = Path::new(&a[1]);
    let out = Path::new(&a[2]);
    let gens: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(120);
    let pop: usize = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(32);
    let only: Option<Vec<String>> = a.iter().position(|s| s == "--only").map(|i| a[i + 1].split(',').map(String::from).collect());
    let mut report = String::from("| program | GM | bore | dry loss (incl. vibrato term) | vibrato target / fit (cents, Hz) | other bore | wet: no reverb | wet: fitted reverb |\n|---|---|---|---|---|---|---|---|\n");
    let mut params_md = String::new();
    for pr in PROGRAMS.iter().filter(|p| only.as_ref().map_or(true, |o| o.iter().any(|n| n == p.name))) {
        let (prog, name) = (pr.gm, pr.name);
        let su = setup(pr);
        let dir = out.join(name);
        fs::create_dir_all(&dir).unwrap();
        let probes: Vec<Probe> = pr.keys.iter().map(|&k| Probe { key: k, vel: 90, hold: 1.2, dur: 1.8 }).collect();
        let tgt: Vec<Vec<f32>> = probes.iter().map(|p| render_sf2(sf2, prog, *p)).collect();
        let ts: Vec<Target> = tgt.iter().zip(&probes).map(|(t, p)| target_pitched(t, *p)).collect();
        let lt: Vec<Vec<f64>> = tgt.iter().map(|t| target_ltas(t)).collect();
        let f = Fit { probes: &probes, ts: &ts, lt: &lt, su: &su };

        // 1. joint dry fit, per bore
        let mut res: Vec<(bool, Vec<f64>, f32)> = [true, false].iter().map(|&open| {
            let (x, l) = es(su.dims(), 11 + prog as u64 + open as u64, gens, pop, &|x| eval(x, open, &f).0);
            (open, x, l)
        }).collect();
        res.sort_by(|a, b| a.2.total_cmp(&b.2));
        let (open, x, dry) = res[0].clone();
        let mut c = eval(&x, open, &f).1;
        let vib_t: Vec<(f32, f32)> = tgt.iter().zip(&probes).map(|(t, p)| vibrato(t, *p)).collect();
        let vib_y: Vec<(f32, f32)> = probes.iter().map(|p| vibrato(&render_chain(&c, *p).unwrap(), *p)).collect();
        let avg = |v: &[(f32, f32)]| (v.iter().map(|x| x.0).sum::<f32>() / v.len() as f32, v.iter().map(|x| x.1).sum::<f32>() / v.len() as f32);
        let (vt, vy) = (avg(&vib_t), avg(&vib_y));

        // 2. reverb vs the soundfont's wet render, longer clips for the tail
        let wp: Vec<Probe> = pr.keys.iter().map(|&k| Probe { key: k, vel: 90, hold: 1.2, dur: 3.0 }).collect();
        let wet: Vec<Vec<f32>> = wp.iter().map(|p| render_sf2_fx(sf2, prog, *p, true)).collect();
        let wts: Vec<Target> = wet.iter().map(|t| target(t)).collect();
        let base: Vec<Vec<f32>> = wp.iter().map(|p| { let mut y = pre_eq(&c, *p).unwrap(); finish(&c, &mut y); y }).collect();
        let wl = |rv: Option<[f32; 4]>| -> f32 {
            base.iter().zip(&wts).map(|(y, t)| { let mut y = y.clone(); if let Some(r) = rv { apply_reverb(r, &mut y); } normalise(&mut y); loss(t, &y) }).sum::<f32>() / base.len() as f32
        };
        let no_rv = wl(None);
        let (rx, wet_l) = es(4, 99 + prog as u64, 30, 16, &|x| wl(Some(reverb_real(x))));
        c.reverb = Some(reverb_real(&rx));

        for (i, p) in wp.iter().enumerate() {
            write_wav(&dir.join(format!("{}_dry_target.wav", p.key)), &render_sf2(sf2, prog, *p));
            write_wav(&dir.join(format!("{}_wet_target.wav", p.key)), &wet[i]);
            let mut y = pre_eq(&c, *p).unwrap();
            let mut d = y.clone();
            finish(&Chain { reverb: None, ..c.clone() }, &mut d);
            write_wav(&dir.join(format!("{}_dry_best.wav", p.key)), &d);
            finish(&c, &mut y);
            write_wav(&dir.join(format!("{}_wet_best.wav", p.key)), &y);
        }

        let rv = c.reverb.unwrap();
        let mut js = format!("{{\n  \"gm\": {prog}, \"name\": \"{name}\", \"dry_loss\": {dry:.3}, \"wet_loss\": {wet_l:.3},\n  \"bore\": {{ \"bore\": {}", open as u8);
        for ((n, _, _), v) in PARAMS.iter().zip(&c.bore) { write!(js, ", \"{n}\": {v:.4}").unwrap(); }
        write!(js, ", \"vibrato_hz\": {:.3} }},\n", c.vibrato_hz).unwrap();
        if let Some(b) = &c.body {
            write!(js, "  \"body\": [").unwrap();
            for i in 0..BODY_BANDS { write!(js, "{}{{ \"freq_hz\": {:.1}, \"gain_db\": {:.2}, \"damping\": {:.4} }}", if i > 0 { ", " } else { "" }, b.hz[i], b.db[i], b.damping).unwrap(); }
            js.push_str("],\n");
        }
        write!(js, "  \"filter\": {{ \"mode\": \"lowpass\", \"cutoff_hz\": {:.1}, \"damping\": {:.3} }},\n  \"eq\": [", c.cutoff, c.fdamp).unwrap();
        for i in 0..4 { write!(js, "{}{{ \"freq_hz\": {:.1}, \"gain_db\": {:.2}, \"damping\": {EQ_DAMPING} }}", if i > 0 { ", " } else { "" }, c.eq_hz[i], c.eq_db[i]).unwrap(); }
        write!(js, "],\n  \"reverb\": {{ \"mix\": {:.3}, \"size\": {:.3}, \"damping\": {:.3}, \"predelay_ms\": {:.1} }}\n}}\n", rv[0], rv[1], rv[2], rv[3]).unwrap();
        fs::write(dir.join("best.json"), &js).unwrap();
        writeln!(params_md, "### {name}\n```json\n{js}```").unwrap();
        writeln!(report, "| {name} | {prog} | {} | {dry:.2} | {:.0} / {:.0}, {:.1} / {:.1} | {:.2} | {no_rv:.2} | {wet_l:.2} |", if open { "open" } else { "closed" }, vt.0, vy.0, vt.1, vy.1, res[1].2).unwrap();
        eprintln!("{name}: dry {dry:.2} vib {vt:?} -> {vy:?} wet {no_rv:.2} -> {wet_l:.2}");
    }
    fs::write(out.join("results.md"), format!("{report}\n{params_md}")).unwrap();
}
