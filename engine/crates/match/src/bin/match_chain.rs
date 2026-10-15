//! `match_chain <sf2> <outdir> [gens] [pop]`: joint fit of bore + vibrato rate + lowpass + EQ (gains solved in closed
//! form per candidate) against dry GM targets, then a reverb fit against the soundfont's wet render. Writes wavs,
//! best.json per program and report.md.
use match_::*;
use rayon::prelude::*;
use std::{fmt::Write as _, fs, path::Path};

const PROGRAMS: [(i32, &str, [u32; 3]); 5] = [
    (71, "clarinet", [55, 62, 69]),
    (65, "alto-sax", [57, 64, 71]),
    (73, "flute", [67, 74, 81]),
    (42, "cello", [41, 52, 62]),
    (40, "violin", [60, 69, 79]),
];
const PENALTY: f32 = 60.0;

struct Rng(u64);
impl Rng {
    fn u(&mut self) -> f64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; (self.0 >> 11) as f64 / (1u64 << 53) as f64 }
    fn n(&mut self) -> f64 { (-2.0 * self.u().max(1e-12).ln()).sqrt() * (6.2831853 * self.u()).cos() }
}

struct Fit<'a> { probes: &'a [Probe], ts: &'a [Target], lt: &'a [Vec<f64>] }

/// Score one candidate with its own optimal EQ. Returns the loss and the chain (EQ filled in).
fn eval(x: &[f64], open: bool, f: &Fit) -> (f32, Chain) {
    let mut c = chain_from(x, open);
    let pre: Option<Vec<Vec<f32>>> = f.probes.iter().map(|p| pre_eq(&c, *p)).collect();
    let Some(mut pre) = pre else { return (PENALTY, c) };
    c.eq_db = solve_eq(&c.eq_hz, f.lt, &pre);
    let mut tot = 0.0;
    for (y, t) in pre.iter_mut().zip(f.ts) {
        finish(&c, y);
        tot += if y.iter().all(|v| v.is_finite()) { loss(t, y) } else { PENALTY };
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
    let gens: usize = a.get(3).map_or(120, |s| s.parse().unwrap());
    let pop: usize = a.get(4).map_or(32, |s| s.parse().unwrap());
    let mut report = String::from("| program | GM | bore | dry loss | other bore | wet loss: no reverb | wet loss: fitted reverb |\n|---|---|---|---|---|---|---|\n");
    let mut params_md = String::new();
    for (prog, name, keys) in PROGRAMS {
        let dir = out.join(name);
        fs::create_dir_all(&dir).unwrap();
        let probes: Vec<Probe> = keys.iter().map(|&k| Probe { key: k, vel: 90, hold: 1.2, dur: 1.8 }).collect();
        let tgt: Vec<Vec<f32>> = probes.iter().map(|p| render_sf2(sf2, prog, *p)).collect();
        let ts: Vec<Target> = tgt.iter().map(|t| target(t)).collect();
        let lt: Vec<Vec<f64>> = tgt.iter().map(|t| target_ltas(t)).collect();
        let f = Fit { probes: &probes, ts: &ts, lt: &lt };

        // 1. joint dry fit, per bore
        let mut res: Vec<(bool, Vec<f64>, f32)> = [true, false].iter().map(|&open| {
            let (x, l) = es(DIMS, 11 + prog as u64 + open as u64, gens, pop, &|x| eval(x, open, &f).0);
            (open, x, l)
        }).collect();
        res.sort_by(|a, b| a.2.total_cmp(&b.2));
        let (open, x, dry) = res[0].clone();
        let mut c = eval(&x, open, &f).1;

        // 2. reverb vs the soundfont's wet render, longer clips for the tail
        let wp: Vec<Probe> = keys.iter().map(|&k| Probe { key: k, vel: 90, hold: 1.2, dur: 3.0 }).collect();
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
            write_wav(&dir.join(format!("target_dry_{}.wav", p.key)), &render_sf2(sf2, prog, *p));
            write_wav(&dir.join(format!("target_wet_{}.wav", p.key)), &wet[i]);
            let mut y = pre_eq(&c, *p).unwrap();
            let mut d = y.clone();
            finish(&Chain { reverb: None, ..c.clone() }, &mut d);
            write_wav(&dir.join(format!("best_dry_{}.wav", p.key)), &d);
            finish(&c, &mut y);
            write_wav(&dir.join(format!("best_wet_{}.wav", p.key)), &y);
        }

        let rv = c.reverb.unwrap();
        let mut js = format!("{{\n  \"gm\": {prog}, \"name\": \"{name}\", \"dry_loss\": {dry:.3}, \"wet_loss\": {wet_l:.3},\n  \"bore\": {{ \"bore\": {}", open as u8);
        for ((n, _, _), v) in PARAMS.iter().zip(&c.bore) { write!(js, ", \"{n}\": {v:.4}").unwrap(); }
        write!(js, ", \"vibrato_hz\": {:.3} }},\n  \"filter\": {{ \"mode\": \"lowpass\", \"cutoff_hz\": {:.1}, \"damping\": {:.3} }},\n  \"eq\": [", c.vibrato_hz, c.cutoff, c.fdamp).unwrap();
        for i in 0..4 { write!(js, "{}{{ \"freq_hz\": {:.1}, \"gain_db\": {:.2}, \"damping\": {EQ_DAMPING} }}", if i > 0 { ", " } else { "" }, c.eq_hz[i], c.eq_db[i]).unwrap(); }
        write!(js, "],\n  \"reverb\": {{ \"mix\": {:.3}, \"size\": {:.3}, \"damping\": {:.3}, \"predelay_ms\": {:.1} }}\n}}\n", rv[0], rv[1], rv[2], rv[3]).unwrap();
        fs::write(dir.join("best.json"), &js).unwrap();
        writeln!(params_md, "### {name}\n```json\n{js}```").unwrap();
        writeln!(report, "| {name} | {prog} | {} | {dry:.2} | {:.2} | {no_rv:.2} | {wet_l:.2} |", if open { "open" } else { "closed" }, res[1].2).unwrap();
        eprintln!("{name}: dry {dry:.2} wet {no_rv:.2} -> {wet_l:.2}");
    }
    fs::write(out.join("results.md"), format!("{report}\n{params_md}")).unwrap();
}
