# GM5 re-match: attack loss term, relative ridge for the winds, noise investigation

Provenance: runs 2026-10-14-gm5-attack (commit 8931054) and 2026-10-14-gm5-floor (8931054 + FLOOR_DB, committed with this file), each `match_chain FluidR3_GM.sf2 <dir> 250 48` (run.sh in each dir), calibration ef8273a, ~15 min per run. Comparison: `rescore FluidR3_GM.sf2 <runs>` (rescore.md), which scores every run's best.json (dry chain) under the **current** loss, so rows are comparable across runs fitted under different loss versions.

Loss changes, in order:
1. gm5-attack: attack term (first 300 ms: 256-point band spectrogram L1 + 2x 5 ms dB envelope L1, weight 1). The winds also get the relative ridge (they were fitted with the old absolute one in gm5-joint). Vibrato rate term gated on both target and fit having vibrato (a flat contour's "rate" is jitter and blew up the score of no-vibrato fits).
2. gm5-floor: each loss spectrum frame floored 60 dB under its loudest band, to stop deep inter-harmonic valleys dominating.

## Re-scored under the current loss (lower is better)

| program | gm5-joint (first joint fit) | strings-body | gm5-attack | gm5-floor | attack ms target / best run |
|---|---|---|---|---|---|
| clarinet | 3.50 | | **2.50** | 2.79 | 95 / 90 |
| alto sax | 4.43 | | **2.83** | 2.96 | 22 / 32 |
| flute | 5.01 | | 3.93 | **3.65** | 63 / 72 |
| cello | 7.24 | 4.61 | **4.66** | 4.70 | 213 / 180 |
| violin | 6.44 | 4.88 | **4.77** | 4.82 | 183 / 140 |

Breakdown per part (spectral+envelope, attack, vibrato) in rescore.md. The attack part drops for every program (e.g. clarinet 1.57 -> 0.83, violin 1.80 -> 1.51), and the winds' spectral part improves with the relative ridge (clarinet 1.83 -> 1.62).

Picked for presets (presets.matched.ts): gm5-attack for clarinet, alto sax, cello (near tie with strings-body; better attack and HNR) and violin; gm5-floor for flute. Note the presets' `loss` field is each run's own wet loss, so it is not comparable between the flute and the rest.

## Noise: not a bug

Strings fits keep noise at 0.6-0.9. Forcing the gm5-attack violin to noise 0.3 / 0 raises its spectral loss 3.17 -> 3.52 -> 5.47. Harmonic-to-noise ratio of the held part (`hnr.py`):

| program | target | gm5-joint | gm5-attack | gm5-floor |
|---|---|---|---|---|
| clarinet | 39.2 | 51.8 | 41.3 | 29.4 |
| alto sax | 29.2 | 40.7 | 33.3 | 36.0 |
| flute | 30.1 | 32.7 | 32.6 | 35.9 |
| cello | 28.0 | 28.8 | 28.4 | 28.7 |
| violin | 18.6 | 25.3 | 25.8 | 25.7 |

The recordings are this noisy (the violin's HNR is 18.6 dB); the fits are as clean or cleaner. The knob reads high because the loop filters the drive noise heavily. So the level is right; what may still be off by ear is the noise *character* (bow noise is pulsed with the stick-slip and sits under the harmonics; ours is white drive noise). The 60 dB floor did not change this, and made the clarinet too noisy (29 dB vs 39); it stays in the loss as the principled choice, but it is not why noise reads high.

## Next

- Listen. If the strings still sound wrong, the suspects are now noise character (pulsed bow noise) and the fast-but-smooth onset (no bow scratch transient).
- The ES reaches different optima per run for the same program (cello spreads 4.61-4.70): a few restarts per program, or CMA-ES, would make picks less noisy.

## Parameters (gm5-attack)
### clarinet
```json
{
  "gm": 71, "name": "clarinet", "dry_loss": 2.767, "wet_loss": 3.544,
  "bore": { "bore": 0, "character": 0.1753, "stiffness": 0.5412, "aperture": 0.4762, "position": 0.9793, "damping": 0.4957, "decay": 0.5074, "breath": 0.9783, "noise": 0.0419, "vibrato_depth": 0.3332, "attack_ms": 17.2356, "release_ms": 20.0000, "pitch_vibrato": 0.0080, "vibrato_hz": 4.967 },
  "filter": { "mode": "lowpass", "cutoff_hz": 2602.8, "damping": 0.413 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -3.91, "damping": 0.7071 }, { "freq_hz": 242.5, "gain_db": -5.00, "damping": 0.7071 }, { "freq_hz": 2159.9, "gain_db": 8.85, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 1.54, "damping": 0.7071 }],
  "reverb": { "mix": 0.141, "size": 0.475, "damping": 0.502, "predelay_ms": 18.0 }
}
```
### alto-sax
```json
{
  "gm": 65, "name": "alto-sax", "dry_loss": 3.178, "wet_loss": 3.809,
  "bore": { "bore": 1, "character": 0.7033, "stiffness": 0.5277, "aperture": 0.2863, "position": 0.5893, "damping": 0.8007, "decay": 0.0108, "breath": 0.4503, "noise": 0.2004, "vibrato_depth": 0.0714, "attack_ms": 4.4036, "release_ms": 141.4421, "pitch_vibrato": 0.1452, "vibrato_hz": 4.890 },
  "filter": { "mode": "lowpass", "cutoff_hz": 2175.4, "damping": 0.835 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -1.46, "damping": 0.7071 }, { "freq_hz": 200.0, "gain_db": -7.35, "damping": 0.7071 }, { "freq_hz": 1813.4, "gain_db": 6.48, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -1.40, "damping": 0.7071 }],
  "reverb": { "mix": 0.096, "size": 0.449, "damping": 0.207, "predelay_ms": 33.9 }
}
```
### flute
```json
{
  "gm": 73, "name": "flute", "dry_loss": 4.510, "wet_loss": 4.396,
  "bore": { "bore": 1, "character": 0.1630, "stiffness": 0.6981, "aperture": 0.3165, "position": 0.6158, "damping": 0.4346, "decay": 0.6544, "breath": 0.0185, "noise": 0.7066, "vibrato_depth": 0.2077, "attack_ms": 3.5033, "release_ms": 188.5097, "pitch_vibrato": 0.1031, "vibrato_hz": 5.296 },
  "filter": { "mode": "lowpass", "cutoff_hz": 1372.8, "damping": 1.111 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -2.76, "damping": 0.7071 }, { "freq_hz": 700.3, "gain_db": 0.62, "damping": 0.7071 }, { "freq_hz": 2362.5, "gain_db": 11.28, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 12.00, "damping": 0.7071 }],
  "reverb": { "mix": 0.205, "size": 0.465, "damping": 0.479, "predelay_ms": 2.6 }
}
```
### cello
```json
{
  "gm": 42, "name": "cello", "dry_loss": 4.830, "wet_loss": 4.503,
  "bore": { "bore": 1, "character": 0.9373, "stiffness": 0.5602, "aperture": 1.0000, "position": 0.7812, "damping": 0.3987, "decay": 0.5322, "breath": 0.3907, "noise": 0.7310, "vibrato_depth": 0.4018, "attack_ms": 3.8746, "release_ms": 363.4991, "pitch_vibrato": 0.1593, "vibrato_hz": 5.933 },
  "body": [{ "freq_hz": 86.7, "gain_db": -2.61, "damping": 0.0628 }, { "freq_hz": 166.2, "gain_db": 9.90, "damping": 0.0628 }, { "freq_hz": 201.6, "gain_db": 8.27, "damping": 0.0628 }, { "freq_hz": 217.3, "gain_db": 0.42, "damping": 0.0628 }, { "freq_hz": 220.1, "gain_db": 1.28, "damping": 0.0628 }, { "freq_hz": 485.8, "gain_db": -3.01, "damping": 0.0628 }, { "freq_hz": 1016.5, "gain_db": -8.66, "damping": 0.0628 }, { "freq_hz": 1138.7, "gain_db": 0.35, "damping": 0.0628 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2913.6, "damping": 0.511 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 3.32, "damping": 0.7071 }, { "freq_hz": 653.5, "gain_db": 2.71, "damping": 0.7071 }, { "freq_hz": 1014.1, "gain_db": -0.06, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 5.08, "damping": 0.7071 }],
  "reverb": { "mix": 0.085, "size": 0.485, "damping": 0.400, "predelay_ms": 17.2 }
}
```
### violin
```json
{
  "gm": 40, "name": "violin", "dry_loss": 4.825, "wet_loss": 4.739,
  "bore": { "bore": 1, "character": 0.8290, "stiffness": 0.4934, "aperture": 0.8533, "position": 0.8608, "damping": 0.7208, "decay": 0.9838, "breath": 0.0890, "noise": 0.6683, "vibrato_depth": 0.2027, "attack_ms": 2.5374, "release_ms": 281.1294, "pitch_vibrato": 0.2201, "vibrato_hz": 6.313 },
  "body": [{ "freq_hz": 326.9, "gain_db": 5.07, "damping": 0.0753 }, { "freq_hz": 451.9, "gain_db": 8.16, "damping": 0.0753 }, { "freq_hz": 529.6, "gain_db": 4.67, "damping": 0.0753 }, { "freq_hz": 603.8, "gain_db": -0.03, "damping": 0.0753 }, { "freq_hz": 755.4, "gain_db": 0.31, "damping": 0.0753 }, { "freq_hz": 894.4, "gain_db": 1.78, "damping": 0.0753 }, { "freq_hz": 2590.6, "gain_db": 0.93, "damping": 0.0753 }, { "freq_hz": 3566.8, "gain_db": 4.16, "damping": 0.0753 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 4235.0, "damping": 0.675 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 5.78, "damping": 0.7071 }, { "freq_hz": 457.5, "gain_db": -0.80, "damping": 0.7071 }, { "freq_hz": 1600.3, "gain_db": -3.51, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 4.69, "damping": 0.7071 }],
  "reverb": { "mix": 0.099, "size": 0.489, "damping": 0.440, "predelay_ms": 31.7 }
}
```

## Parameters (gm5-floor)
### clarinet
```json
{
  "gm": 71, "name": "clarinet", "dry_loss": 2.788, "wet_loss": 3.379,
  "bore": { "bore": 1, "character": 0.2035, "stiffness": 0.6326, "aperture": 0.1573, "position": 0.5000, "damping": 0.4467, "decay": 0.0431, "breath": 0.9533, "noise": 0.5370, "vibrato_depth": 0.2983, "attack_ms": 11.9838, "release_ms": 20.0000, "pitch_vibrato": 0.0000, "vibrato_hz": 7.294 },
  "filter": { "mode": "lowpass", "cutoff_hz": 1760.7, "damping": 0.464 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -1.49, "damping": 0.7071 }, { "freq_hz": 541.3, "gain_db": -3.30, "damping": 0.7071 }, { "freq_hz": 2214.0, "gain_db": 9.36, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -0.19, "damping": 0.7071 }],
  "reverb": { "mix": 0.115, "size": 0.522, "damping": 0.635, "predelay_ms": 30.3 }
}
```
### alto-sax
```json
{
  "gm": 65, "name": "alto-sax", "dry_loss": 2.956, "wet_loss": 3.625,
  "bore": { "bore": 1, "character": 0.6983, "stiffness": 0.5993, "aperture": 0.2152, "position": 0.5654, "damping": 0.6767, "decay": 0.1093, "breath": 0.5127, "noise": 0.1442, "vibrato_depth": 0.1389, "attack_ms": 5.1008, "release_ms": 144.9138, "pitch_vibrato": 0.1493, "vibrato_hz": 5.030 },
  "filter": { "mode": "lowpass", "cutoff_hz": 2807.3, "damping": 0.678 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.50, "damping": 0.7071 }, { "freq_hz": 807.8, "gain_db": 2.28, "damping": 0.7071 }, { "freq_hz": 1851.7, "gain_db": 6.20, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -0.36, "damping": 0.7071 }],
  "reverb": { "mix": 0.101, "size": 0.500, "damping": 0.492, "predelay_ms": 4.4 }
}
```
### flute
```json
{
  "gm": 73, "name": "flute", "dry_loss": 3.648, "wet_loss": 3.790,
  "bore": { "bore": 1, "character": 0.0303, "stiffness": 0.7936, "aperture": 0.0271, "position": 0.5704, "damping": 0.6686, "decay": 0.5561, "breath": 0.0336, "noise": 0.6468, "vibrato_depth": 0.1917, "attack_ms": 2.2858, "release_ms": 190.5297, "pitch_vibrato": 0.0949, "vibrato_hz": 5.582 },
  "filter": { "mode": "lowpass", "cutoff_hz": 1488.0, "damping": 1.063 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.89, "damping": 0.7071 }, { "freq_hz": 672.0, "gain_db": 0.74, "damping": 0.7071 }, { "freq_hz": 3085.5, "gain_db": 5.42, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 1.70, "damping": 0.7071 }],
  "reverb": { "mix": 0.181, "size": 0.476, "damping": 0.724, "predelay_ms": 7.4 }
}
```
### cello
```json
{
  "gm": 42, "name": "cello", "dry_loss": 4.704, "wet_loss": 4.549,
  "bore": { "bore": 1, "character": 0.9015, "stiffness": 0.8177, "aperture": 1.0000, "position": 0.8099, "damping": 0.4727, "decay": 0.5798, "breath": 0.3567, "noise": 0.8819, "vibrato_depth": 0.3045, "attack_ms": 2.9167, "release_ms": 367.6073, "pitch_vibrato": 0.1561, "vibrato_hz": 4.276 },
  "body": [{ "freq_hz": 91.9, "gain_db": -4.21, "damping": 0.0674 }, { "freq_hz": 165.9, "gain_db": 3.45, "damping": 0.0674 }, { "freq_hz": 176.6, "gain_db": 3.78, "damping": 0.0674 }, { "freq_hz": 196.5, "gain_db": 5.07, "damping": 0.0674 }, { "freq_hz": 218.4, "gain_db": -0.42, "damping": 0.0674 }, { "freq_hz": 489.8, "gain_db": -1.72, "damping": 0.0674 }, { "freq_hz": 1115.1, "gain_db": -5.03, "damping": 0.0674 }, { "freq_hz": 1096.8, "gain_db": -3.30, "damping": 0.0674 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2287.5, "damping": 0.470 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.24, "damping": 0.7071 }, { "freq_hz": 752.2, "gain_db": -2.19, "damping": 0.7071 }, { "freq_hz": 2943.2, "gain_db": -2.80, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 4.46, "damping": 0.7071 }],
  "reverb": { "mix": 0.065, "size": 0.512, "damping": 0.468, "predelay_ms": 52.6 }
}
```
### violin
```json
{
  "gm": 40, "name": "violin", "dry_loss": 4.822, "wet_loss": 4.734,
  "bore": { "bore": 1, "character": 0.8382, "stiffness": 0.5589, "aperture": 0.7844, "position": 0.1600, "damping": 0.5264, "decay": 0.9722, "breath": 0.1358, "noise": 0.6019, "vibrato_depth": 0.3086, "attack_ms": 4.5765, "release_ms": 292.0765, "pitch_vibrato": 0.2156, "vibrato_hz": 6.137 },
  "body": [{ "freq_hz": 245.5, "gain_db": -0.39, "damping": 0.1940 }, { "freq_hz": 512.8, "gain_db": 4.60, "damping": 0.1940 }, { "freq_hz": 404.6, "gain_db": 4.23, "damping": 0.1940 }, { "freq_hz": 629.4, "gain_db": -0.73, "damping": 0.1940 }, { "freq_hz": 665.0, "gain_db": -1.32, "damping": 0.1940 }, { "freq_hz": 863.6, "gain_db": -0.24, "damping": 0.1940 }, { "freq_hz": 2934.5, "gain_db": 1.91, "damping": 0.1940 }, { "freq_hz": 3391.5, "gain_db": 0.91, "damping": 0.1940 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 3660.4, "damping": 0.596 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 5.40, "damping": 0.7071 }, { "freq_hz": 494.9, "gain_db": -0.91, "damping": 0.7071 }, { "freq_hz": 1790.2, "gain_db": -4.56, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 4.74, "damping": 0.7071 }],
  "reverb": { "mix": 0.076, "size": 0.486, "damping": 0.556, "predelay_ms": 72.8 }
}
```
