//! Render a few notes of a finnwave patch to a 16-bit mono WAV, to audition it offline.
//!
//! ```text
//! cargo run --release -p dsp --bin render_patch -- out.wav rolloff=0.5 env→rolloff=0.5 attack=3 decay=180 sustain=0.5 release=90 gain=0.8
//! ```
//! Params are the finnwave names (shared/src/devices.ts). Plays the open strings E1 A1 D2 G2, then a short riff, one
//! note per half second, 70% of it held. Used for `badmidi` named patches (agent/badmidi/patches.py).

use dsp::synth::{Synth, P_ATTACK_MS, P_DECAY_MS, P_ENV_TO_ROLLOFF, P_GAIN, P_RELEASE_MS, P_ROLLOFF, P_SUSTAIN};
use std::io::Write;

const SR: u32 = 48_000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(out) = args.first() else {
        eprintln!("usage: render_patch out.wav [param=value ...]");
        std::process::exit(2);
    };
    let mut s = Synth::new(SR as f32);
    for kv in &args[1..] {
        let (k, v) = kv.split_once('=').expect("param=value");
        let id = match k {
            "rolloff" => P_ROLLOFF,
            "env→rolloff" => P_ENV_TO_ROLLOFF,
            "attack" => P_ATTACK_MS,
            "decay" => P_DECAY_MS,
            "sustain" => P_SUSTAIN,
            "release" => P_RELEASE_MS,
            "gain" => P_GAIN,
            _ => panic!("unknown param {k}"),
        };
        s.set_param_smooth(id, v.parse().expect("number"), 0.0);
    }
    // (midi pitch, half-second slots held)
    let notes: [(u32, usize); 12] = [(28, 4), (33, 4), (38, 4), (43, 4), (33, 1), (33, 1), (40, 1), (36, 1), (31, 1), (33, 1), (38, 2), (33, 4)];
    let slot = (SR / 2) as usize;
    let total: usize = notes.iter().map(|n| n.1).sum::<usize>() * slot + SR as usize;
    let mut buf = vec![0.0f32; total];
    let mut t = 0usize;
    for (pitch, slots) in notes {
        s.note_on(pitch, 0.8, (t + slots * slot * 7 / 10) as i64);
        let end = t + slots * slot;
        while t < end {
            let n = 32.min(end - t);
            s.release_due(t as i64);
            s.render_add(&mut buf[t..t + n]);
            t += n;
        }
    }
    let mut tail = t;
    while tail < total {
        let n = 32.min(total - tail);
        s.release_due(tail as i64);
        s.render_add(&mut buf[tail..tail + n]);
        tail += n;
    }
    let peak = buf.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    let mut f = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    let data = (buf.len() * 2) as u32;
    f.write_all(b"RIFF").unwrap();
    f.write_all(&(36 + data).to_le_bytes()).unwrap();
    f.write_all(b"WAVEfmt ").unwrap();
    for v in [16u32, 0x0001_0001, SR, SR * 2, 0x0010_0002, ] {
        f.write_all(&v.to_le_bytes()).unwrap();
    }
    f.write_all(b"data").unwrap();
    f.write_all(&data.to_le_bytes()).unwrap();
    for x in &buf {
        f.write_all(&((x.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).unwrap();
    }
    println!("wrote {out}: {:.1} s, peak {peak:.2}", buf.len() as f32 / SR as f32);
}
