# GM5: valve noise, air, wander + noise-band and shimmer loss terms

Provenance: commit e2bbd11 (DSP) + matcher wip commit before this file, `match_chain FluidR3_GM.sf2 <dir> 250 48` (run.sh), calibration ef8273a. rescore.md: every candidate run under the current loss.

## Why

"Still too pure, like a synth." Measured on target vs fit (`alive.py`): pitch jitter was already close, but (1) the flute/sax high noise (4-12 kHz, between the harmonics) was 6-11 dB short: noise injected into the loop gets filtered by it and can't get there; (2) shimmer (fast level fluctuation) was 2-3x too low on violin and flute; (3) the loss saw neither (the band spectrogram averages inter-harmonic noise with the harmonics, and shimmer is below its time/level resolution).

## Changes

- DSP (docs/bore.md, engine-api kind 10 params 17-19): `valve noise` (relative jitter of the reed/jet opening and bow force inside g(Δ): pulsed at the note's period, the valve only acts for part of each cycle), `air` (radiated high-passed noise outside the loop, shaped by the junction flow so it pulses with the tone), `wander` (8 Hz random drift of drive and opening). Separate noise sources, so presets not using them are unchanged; a test checks every anchor / bore still speaks in tune at full valve noise + wander.
- Loss: + 0.05 per dB mean inter-harmonic noise error over 0.1-0.5 / 0.5-1.5 / 1.5-4 / 4-12 kHz, + 1.0 per dB shimmer error.

## Results (rescore.md, current loss)

| program | previous preset | gm5-noise | picked | noise dB err | shimmer target / picked |
|---|---|---|---|---|---|
| clarinet | **3.42** (gm5-harm) | 3.57 | gm5-harm | 7.1 | 0.14 / 0.14 |
| alto sax | 3.64 (gm5-harm) | **3.63** | gm5-noise | 5.3 -> 3.4 | 0.29 / 0.23 |
| flute | 4.27 (gm5-bell) | **3.85** | gm5-noise | 5.4 -> 2.1 | 0.36 / 0.32 |
| cello | 5.43 (gm5-harm) | **5.42** | gm5-noise | 4.5 -> 4.2 | 0.68 / 0.55 |
| violin | 6.10 (gm5-attack) | **5.95** | gm5-noise | 3.1 -> 3.0 | 1.08 / 0.93 (was 0.39) |

Inter-harmonic noise, dB re total (0.1-0.5 / 0.5-1.5 / 1.5-4 / 4-12 kHz), target vs gm5-noise: flute -44.6 -39.2 -37.9 -47.1 vs -44.8 -39.5 -37.4 -49.0 (the 4-12 kHz band was -58 before `air`).

How the fits split the noise: flute mostly `air` (0.68); violin / cello mostly `valve noise` (0.76 / 0.81) and `wander` (0.73 / 0.55), with the old drive noise down to 0.12 on the violin.

## Oddities

- The sax fit picked a closed bore (conical in reality, so open is the physical choice) and the clarinet fit in gm5-noise a bow-like character (0.91). They score best; listen.
- Vibrato delay is still fitted at 1-1.4 s everywhere although only the flute's vibrato fades in (see gm5-harm fit.md).

## Parameters (2026-10-15-gm5-noise)
### clarinet
```json
{
  "gm": 71, "name": "clarinet", "dry_loss": 3.570, "wet_loss": 3.262,
  "bore": { "bore": 0, "character": 0.9140, "stiffness": 0.6177, "aperture": 0.6793, "position": 0.0000, "damping": 0.8950, "decay": 0.7565, "breath": 0.7986, "noise": 0.0000, "vibrato_depth": 0.1019, "attack_ms": 53.8380, "release_ms": 20.2671, "pitch_vibrato": 0.0254, "vibrato_delay_ms": 1387.8491, "bell": 0.0293, "valve_noise": 0.2619, "air": 0.0339, "wander": 0.0788, "vibrato_hz": 2.608 },
  "body": [{ "freq_hz": 326.9, "gain_db": 0.25, "damping": 0.1466 }, { "freq_hz": 475.7, "gain_db": 0.06, "damping": 0.1466 }, { "freq_hz": 1044.3, "gain_db": -1.88, "damping": 0.1466 }, { "freq_hz": 881.3, "gain_db": 2.28, "damping": 0.1466 }, { "freq_hz": 1393.4, "gain_db": 7.08, "damping": 0.1466 }, { "freq_hz": 2087.4, "gain_db": 5.91, "damping": 0.1466 }, { "freq_hz": 2802.2, "gain_db": 7.53, "damping": 0.1466 }, { "freq_hz": 3708.6, "gain_db": 3.81, "damping": 0.1466 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2908.5, "damping": 0.499 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -1.27, "damping": 0.7071 }, { "freq_hz": 353.0, "gain_db": -0.32, "damping": 0.7071 }, { "freq_hz": 2936.3, "gain_db": 2.56, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -0.06, "damping": 0.7071 }],
  "reverb": { "mix": 0.130, "size": 0.494, "damping": 0.575, "predelay_ms": 10.0 }
}
```
### alto-sax
```json
{
  "gm": 65, "name": "alto-sax", "dry_loss": 3.541, "wet_loss": 3.608,
  "bore": { "bore": 0, "character": 0.2537, "stiffness": 0.8399, "aperture": 0.1154, "position": 0.9991, "damping": 0.6617, "decay": 0.6395, "breath": 0.6734, "noise": 0.2740, "vibrato_depth": 0.3931, "attack_ms": 11.2015, "release_ms": 151.9218, "pitch_vibrato": 0.2186, "vibrato_delay_ms": 1108.2604, "bell": 0.9335, "valve_noise": 0.3230, "air": 0.0000, "wander": 0.1354, "vibrato_hz": 4.719 },
  "body": [{ "freq_hz": 289.1, "gain_db": -0.41, "damping": 0.1942 }, { "freq_hz": 562.2, "gain_db": 2.62, "damping": 0.1942 }, { "freq_hz": 1039.7, "gain_db": -0.10, "damping": 0.1942 }, { "freq_hz": 829.9, "gain_db": 0.43, "damping": 0.1942 }, { "freq_hz": 1666.9, "gain_db": -1.19, "damping": 0.1942 }, { "freq_hz": 2361.6, "gain_db": 5.69, "damping": 0.1942 }, { "freq_hz": 3083.9, "gain_db": -1.89, "damping": 0.1942 }, { "freq_hz": 3963.9, "gain_db": -5.83, "damping": 0.1942 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 3287.1, "damping": 0.851 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.53, "damping": 0.7071 }, { "freq_hz": 217.1, "gain_db": -1.08, "damping": 0.7071 }, { "freq_hz": 1594.7, "gain_db": 0.67, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -0.10, "damping": 0.7071 }],
  "reverb": { "mix": 0.116, "size": 0.485, "damping": 0.401, "predelay_ms": 4.3 }
}
```
### flute
```json
{
  "gm": 73, "name": "flute", "dry_loss": 3.851, "wet_loss": 3.514,
  "bore": { "bore": 1, "character": 0.9190, "stiffness": 0.6249, "aperture": 0.6483, "position": 0.6025, "damping": 0.9996, "decay": 0.6099, "breath": 0.3000, "noise": 0.0315, "vibrato_depth": 0.3956, "attack_ms": 5.3597, "release_ms": 189.2098, "pitch_vibrato": 0.1177, "vibrato_delay_ms": 985.1006, "bell": 0.5515, "valve_noise": 0.2148, "air": 0.6763, "wander": 0.1826, "vibrato_hz": 4.622 },
  "body": [{ "freq_hz": 262.8, "gain_db": -5.10, "damping": 0.1423 }, { "freq_hz": 661.0, "gain_db": -1.63, "damping": 0.1423 }, { "freq_hz": 614.0, "gain_db": 1.56, "damping": 0.1423 }, { "freq_hz": 1133.3, "gain_db": 2.29, "damping": 0.1423 }, { "freq_hz": 1493.4, "gain_db": 4.90, "damping": 0.1423 }, { "freq_hz": 1927.5, "gain_db": 7.24, "damping": 0.1423 }, { "freq_hz": 2948.4, "gain_db": 6.27, "damping": 0.1423 }, { "freq_hz": 4189.9, "gain_db": 2.36, "damping": 0.1423 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 708.4, "damping": 0.510 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -5.18, "damping": 0.7071 }, { "freq_hz": 370.5, "gain_db": 1.97, "damping": 0.7071 }, { "freq_hz": 4391.3, "gain_db": 3.30, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 3.67, "damping": 0.7071 }],
  "reverb": { "mix": 0.154, "size": 0.482, "damping": 0.338, "predelay_ms": 38.8 }
}
```
### cello
```json
{
  "gm": 42, "name": "cello", "dry_loss": 5.426, "wet_loss": 4.332,
  "bore": { "bore": 1, "character": 0.9225, "stiffness": 0.7608, "aperture": 0.5686, "position": 0.7983, "damping": 0.2964, "decay": 0.5600, "breath": 0.2970, "noise": 0.5892, "vibrato_depth": 0.2216, "attack_ms": 2.3237, "release_ms": 363.5356, "pitch_vibrato": 0.1971, "vibrato_delay_ms": 993.9552, "bell": 0.4732, "valve_noise": 0.8079, "air": 0.1718, "wander": 0.5485, "vibrato_hz": 3.527 },
  "body": [{ "freq_hz": 83.9, "gain_db": -2.97, "damping": 0.1428 }, { "freq_hz": 165.4, "gain_db": 7.89, "damping": 0.1428 }, { "freq_hz": 218.3, "gain_db": 2.66, "damping": 0.1428 }, { "freq_hz": 237.1, "gain_db": -0.02, "damping": 0.1428 }, { "freq_hz": 355.4, "gain_db": -2.59, "damping": 0.1428 }, { "freq_hz": 427.7, "gain_db": 1.48, "damping": 0.1428 }, { "freq_hz": 771.6, "gain_db": -2.10, "damping": 0.1428 }, { "freq_hz": 1244.0, "gain_db": -10.10, "damping": 0.1428 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 1628.7, "damping": 0.550 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -4.06, "damping": 0.7071 }, { "freq_hz": 653.6, "gain_db": -0.04, "damping": 0.7071 }, { "freq_hz": 4583.9, "gain_db": 1.37, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 6.72, "damping": 0.7071 }],
  "reverb": { "mix": 0.059, "size": 0.518, "damping": 0.204, "predelay_ms": 41.4 }
}
```
### violin
```json
{
  "gm": 40, "name": "violin", "dry_loss": 5.945, "wet_loss": 4.852,
  "bore": { "bore": 1, "character": 0.9360, "stiffness": 0.2260, "aperture": 0.5139, "position": 0.2548, "damping": 0.7015, "decay": 0.7237, "breath": 0.3421, "noise": 0.1173, "vibrato_depth": 0.4441, "attack_ms": 4.9783, "release_ms": 294.9896, "pitch_vibrato": 0.3636, "vibrato_delay_ms": 1380.3741, "bell": 0.3500, "valve_noise": 0.7554, "air": 0.1618, "wander": 0.7331, "vibrato_hz": 6.016 },
  "body": [{ "freq_hz": 337.0, "gain_db": 3.72, "damping": 0.1146 }, { "freq_hz": 428.7, "gain_db": 3.37, "damping": 0.1146 }, { "freq_hz": 522.3, "gain_db": 4.77, "damping": 0.1146 }, { "freq_hz": 424.1, "gain_db": 2.54, "damping": 0.1146 }, { "freq_hz": 742.2, "gain_db": 0.24, "damping": 0.1146 }, { "freq_hz": 1320.7, "gain_db": -2.76, "damping": 0.1146 }, { "freq_hz": 2956.2, "gain_db": 2.46, "damping": 0.1146 }, { "freq_hz": 3790.2, "gain_db": 3.01, "damping": 0.1146 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 4867.1, "damping": 0.852 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.92, "damping": 0.7071 }, { "freq_hz": 531.0, "gain_db": 0.43, "damping": 0.7071 }, { "freq_hz": 2074.9, "gain_db": 0.23, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 6.75, "damping": 0.7071 }],
  "reverb": { "mix": 0.087, "size": 0.484, "damping": 0.430, "predelay_ms": 80.0 }
}
```
