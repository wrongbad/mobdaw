//! `match_bore <sf2> <outdir> [gens] [pop]`: render 5 GM programs, search bore knobs to match, write wavs + best.json.
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

struct Rng(u64);
impl Rng {
    fn u(&mut self) -> f64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; (self.0 >> 11) as f64 / (1u64 << 53) as f64 }
    fn n(&mut self) -> f64 { (-2.0 * self.u().max(1e-12).ln()).sqrt() * (6.2831853 * self.u()).cos() }
}

fn score(x: &[f64], open: bool, probes: &[Probe], ts: &[Target]) -> f32 {
    let rp = real(x);
    let mut tot = 0.0;
    for (p, t) in probes.iter().zip(ts) {
        tot += match render_bore(&rp, open, *p) { Some(y) => loss(t, &y), None => 60.0 };
    }
    tot / probes.len() as f32
}

fn search(open: bool, seed: u64, gens: usize, pop: usize, probes: &[Probe], ts: &[Target]) -> (Vec<f64>, f32) {
    let d = PARAMS.len();
    let mut rng = Rng(seed | 1);
    // Random restarts for the initial mean: best of a scattered batch.
    let mut mean: Vec<f64> = (0..d).map(|_| rng.u()).collect();
    let starts: Vec<Vec<f64>> = (0..pop * 3).map(|_| (0..d).map(|_| rng.u()).collect()).collect();
    let sc: Vec<f32> = starts.par_iter().map(|x| score(x, open, probes, ts)).collect();
    let bi = (0..starts.len()).min_by(|&a, &b| sc[a].total_cmp(&sc[b])).unwrap();
    mean.clone_from(&starts[bi]);
    let (mut best, mut bl) = (mean.clone(), sc[bi]);
    let mut sigma = 0.25;
    for _ in 0..gens {
        let cands: Vec<Vec<f64>> = (0..pop).map(|_| mean.iter().map(|m| (m + sigma * rng.n()).clamp(0.0, 1.0)).collect()).collect();
        let sc: Vec<f32> = cands.par_iter().map(|x| score(x, open, probes, ts)).collect();
        let mut idx: Vec<usize> = (0..pop).collect();
        idx.sort_by(|&a, &b| sc[a].total_cmp(&sc[b]));
        let mu = pop / 4;
        let mut nm = vec![0.0; d];
        for &i in &idx[..mu] { for k in 0..d { nm[k] += cands[i][k] / mu as f64; } }
        if sc[idx[0]] < bl { bl = sc[idx[0]]; best = cands[idx[0]].clone(); sigma = (sigma * 1.1).min(0.4); } else { sigma = (sigma * 0.93).max(0.02); }
        mean = nm;
    }
    (best, bl)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let sf2 = Path::new(&a[1]);
    let out = Path::new(&a[2]);
    let gens: usize = a.get(3).map_or(40, |s| s.parse().unwrap());
    let pop: usize = a.get(4).map_or(24, |s| s.parse().unwrap());
    let mut report = String::from("# GM5 bore match\n\n| program | GM | open | loss | untuned-best-of-random |\n|---|---|---|---|---|\n");
    for (prog, name, keys) in PROGRAMS {
        let dir = out.join(name);
        fs::create_dir_all(&dir).unwrap();
        let probes: Vec<Probe> = keys.iter().map(|&k| Probe { key: k, vel: 90, hold: 1.2, dur: 1.8 }).collect();
        let tgt: Vec<Vec<f32>> = probes.iter().map(|p| render_sf2(sf2, prog, *p)).collect();
        for (p, t) in probes.iter().zip(&tgt) { write_wav(&dir.join(format!("target_{}.wav", p.key)), t); }
        let ts: Vec<Target> = tgt.iter().map(|t| target(t)).collect();
        let mut res = vec![];
        for open in [true, false] {
            let (x, l) = search(open, 7 + prog as u64, gens, pop, &probes, &ts);
            res.push((open, x, l));
        }
        res.sort_by(|a, b| a.2.total_cmp(&b.2));
        let (open, x, l) = &res[0];
        let rp = real(x);
        let mut js = String::from("{\n");
        write!(js, "  \"gm\": {prog}, \"open\": {open}, \"loss\": {l:.3}").unwrap();
        for ((n, _, _), v) in PARAMS.iter().zip(&rp) { write!(js, ",\n  \"{n}\": {v:.4}").unwrap(); }
        js.push_str("\n}\n");
        fs::write(dir.join("best.json"), js).unwrap();
        for p in &probes {
            if let Some(y) = render_bore(&rp, *open, *p) { write_wav(&dir.join(format!("best_{}.wav", p.key)), &y); }
        }
        writeln!(report, "| {name} | {prog} | {open} | {l:.2} | other bore {:.2} |", res[1].2).unwrap();
        eprintln!("{name}: open={open} loss={l:.2}");
    }
    fs::write(out.join("report.md"), report).unwrap();
}
