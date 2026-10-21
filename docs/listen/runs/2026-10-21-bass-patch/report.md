# Bass patch for finnwave (audition me)

`badmidi push --patch bass` makes a track with these finnwave params (agent/badmidi/patches.py). They were chosen from
the DSP (engine/crates/dsp/src/finnwave.rs, synth.rs), **not by ear**: please listen.

| param | value | why |
|---|---|---|
| rolloff | 0.5 | harmonic k is e^-kb: 2nd at 0.6, 3rd 0.22, 4th 0.14 of the fundamental (measured 0.5 / 0.29 / 0.16 at the attack) |
| env->rolloff | 0.5 | starts brighter than it ends: the note mellows as the envelope falls to the sustain |
| attack | 3 ms | fast, not a click |
| decay | 180 ms | to sustain 0.5 |
| sustain | 0.5 | |
| release | 90 ms | short, notes stop cleanly |
| gain | 1.4 | peak 0.53 at velocity 0.8 (default patch: 0.21) |

finnwave has no filter, vibrato or mono switch (64 voices summed), so "low-pass fairly closed, no vibrato, mono" is
approximated by the rolloff and envelope only. A lone-voice (monophonic) feel needs a short release so notes do not overlap.

Files (WAV, git-ignored; regenerate): `bass.wav` is the patch (E1 A1 D2 G2 open strings, then a short riff),
`default-finnwave.wav` the same notes on the default patch.

```
cd engine && cargo build --release -p dsp --bin render_patch
engine/target/release/render_patch docs/listen/runs/2026-10-21-bass-patch/bass.wav rolloff=0.5 "env→rolloff=0.5" attack=3 decay=180 sustain=0.5 release=90 gain=1.4
```
