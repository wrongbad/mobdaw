//! `rescore <sf2> <run dir>...`: score each run's best.json (dry chain) under the current loss, with its parts and the
//! attack/vibrato measurements, so runs fitted under different loss versions can be compared. Prints a markdown table.
use match_::*;
use std::{fs, path::Path};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let sf2 = Path::new(&a[1]);
    println!("| program | run | total | spectral+env | attack | vibrato+harmonics | attack ms target / fit | vibrato cents target / fit | harmonic dB err (all / even) |\n|---|---|---|---|---|---|---|---|---|");
    for pr in &PROGRAMS {
        let ps = probes(pr);
        let tgt: Vec<Vec<f32>> = ps.iter().map(|p| render_sf2(sf2, pr.gm, *p)).collect();
        let ts: Vec<Target> = tgt.iter().zip(&ps).map(|(t, p)| target_pitched(t, *p)).collect();
        let att_t = tgt.iter().map(|t| attack_time(t)).sum::<f32>() / 3.0 * 1000.0;
        let vib_t = tgt.iter().zip(&ps).map(|(t, p)| vibrato(t, *p).0).sum::<f32>() / 3.0;
        for run in &a[2..] {
            let Ok(js) = fs::read_to_string(Path::new(run).join(pr.name).join("best.json")) else { continue };
            let c = chain_from_json(&js);
            let ys: Vec<Vec<f32>> = ps.iter().map(|p| render_chain(&c, *p).unwrap()).collect();
            let parts: Vec<(f32, f32, f32)> = ys.iter().zip(&ts).zip(&ps).map(|((y, t), p)| loss_parts(t, y, *p)).collect();
            let m = |f: &dyn Fn(&(f32, f32, f32)) -> f32| parts.iter().map(f).sum::<f32>() / 3.0;
            let (b, at, v) = (m(&|x| x.0), m(&|x| x.1), m(&|x| x.2));
            let att_y = ys.iter().map(|y| attack_time(y)).sum::<f32>() / 3.0 * 1000.0;
            let vib_y = ys.iter().zip(&ps).map(|(y, p)| vibrato(y, *p).0).sum::<f32>() / 3.0;
            // mean |dB| harmonic-level error, and of the even harmonics alone
            let herr = |even: bool| ys.iter().zip(&ts).zip(&ps).map(|((y, t), p)| {
                let (th, yh) = (t.harm.as_ref().unwrap(), harmonic_levels(y, *p));
                let d: Vec<f32> = th.iter().zip(&yh).enumerate().filter(|(k, _)| !even || k % 2 == 1).map(|(_, (a, b))| (a - b).abs()).collect();
                d.iter().sum::<f32>() / d.len().max(1) as f32
            }).sum::<f32>() / 3.0;
            let (h_all, h_even) = (herr(false), herr(true));
            let label = Path::new(run).file_name().unwrap().to_string_lossy();
            println!("| {} | {label} | {:.2} | {b:.2} | {at:.2} | {v:.2} | {att_t:.0} / {att_y:.0} | {vib_t:.0} / {vib_y:.0} | {h_all:.1} / {h_even:.1} |", pr.name, b + at + v);
        }
    }
}
