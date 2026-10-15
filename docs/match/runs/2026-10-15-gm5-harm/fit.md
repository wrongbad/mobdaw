# GM5: bell, vibrato delay, body for winds, harmonic-level loss

Provenance: runs 2026-10-15-gm5-bell (commit 423731c) and 2026-10-15-gm5-harm (that + harmonic/split-vibrato terms, wip commit before this file), each `match_chain FluidR3_GM.sf2 <dir> 250 48` (run.sh), calibration ef8273a (the new knobs sit outside the calibrated loop). rescore.md scores every candidate run under the current loss.

## Changes

- DSP (docs/bore.md, docs/engine-api.md): bore `vibrato delay` (param 15, fade-in ms) and `bell` (param 16): even harmonics above ~1.2 kHz by ring-modulating the output's upper partials with an in-phase copy of the fundamental, outside the loop. Tried and dropped first: a tone-hole allpass in the closed end's reflection (inharmonic upper resonances pulled the pitch ±100+ cents unpredictably), and squaring the output (a square wave squared is constant). Note: the first tone-hole and bell tests used raw settings that did not speak (RMS ~1e-8), which hid all of this for a while; the tests now go through the calibration and assert the note sounds.
- Matcher: body stage for winds too (8 peaks 300 Hz-4 kHz, ±40%); vibrato delay and bell searched.
- Loss (gm5-harm): harmonic levels h1-h16 of the held part (0.08 per dB mean error): the band spectrogram cannot see odd/even balance up high (a quarter-octave band there holds 2-3 harmonics; the evens moving 40 dB shift it ~0.4 dB), which is why gm5-bell's clarinet fit set bell to 0. Vibrato depth compared early and late in the held part.

## Results (rescore.md, current loss, lower is better)

| program | gm5-attack (previous presets) | gm5-bell | gm5-harm | picked | harmonic dB err all / even, picked |
|---|---|---|---|---|---|
| clarinet | 3.36 | 3.24 | **3.01** | gm5-harm | 6.6 / 9.0 (was 10.6 / 17.0) |
| alto sax | 3.51 | 3.28 | 3.28 | gm5-harm | 4.9 / 5.3 (was 8.2 / 8.0) |
| flute | 4.32 | **3.84** | 3.89 | gm5-bell | 3.2 / 3.8 (was 3.7 / 3.0, gm5-floor) |
| cello | 5.20 | 5.24 | **5.00** | gm5-harm | 5.4 / 5.0 (was 6.8 / 6.9) |
| violin | **5.26** | 5.47 | 5.43 | gm5-attack | 6.0 / 6.3 (unchanged) |

Clarinet harmonics at G3 (dB re strongest, h1-h16):

```
target       -1  -38  -13  -37  -11  -38    0  -10   -4  -10   -5  -23  -16  -18  -10  -25
gm5-attack    0  -56   -6  -52   -6  -47   -6  -44   -6  -42   -6  -41   -9  -44  -15  -47
gm5-harm      0  -46  -10  -52  -13  -42  -10  -34  -13  -31  -11  -31  -14  -34  -17  -35
```

The 1.4 kHz peak is now there (body stage), and the upper evens are up ~15 dB, but still ~20 dB under the target's. The fit only uses bell 0.05: more bell also raises the low evens (h2-h6) that the target keeps at -37, so the search stops early. A steeper high-pass in the bell path would let it go further.

## Vibrato delay: misused

The soundfont's strings and sax have steady vibrato from ~0.2 s; only the flute fades in (0 -> 8.5 cents over 1 s; `vibrato_envelope.py`). The fits do the opposite: gm5-harm fades strings/sax in over 0.6-1.4 s, and the flute stays flat (its vibrato is near the pitch tracker's resolution at those pitches). Zeroing the delay in those fits makes them worse (sax 3.28 -> 3.66), since they compensated with deeper pitch vibrato. The picked violin (gm5-attack) has no delay. Next: bound the delay per family, or a finer (interpolated) pitch tracker so the flute's fade is visible.

## Next

1. Steeper (4th-order) bell high-pass so the upper evens can rise without the low ones.
2. Vibrato delay: finer pitch tracker; bound it for strings.
3. Attack: gm5-harm traded some attack accuracy (clarinet 33 vs 95 ms target) for harmonics; W_ATTACK may need raising.

## Parameters (2026-10-15-gm5-bell)
### clarinet
```json
{
  "gm": 71, "name": "clarinet", "dry_loss": 2.394, "wet_loss": 3.318,
  "bore": { "bore": 0, "character": 0.2120, "stiffness": 0.7682, "aperture": 0.3049, "position": 0.9953, "damping": 0.5905, "decay": 0.4192, "breath": 0.8806, "noise": 0.2150, "vibrato_depth": 0.1785, "attack_ms": 22.4734, "release_ms": 20.2155, "pitch_vibrato": 0.0118, "vibrato_delay_ms": 811.3232, "bell": 0.0000, "vibrato_hz": 5.511 },
  "body": [{ "freq_hz": 274.7, "gain_db": -1.36, "damping": 0.2345 }, { "freq_hz": 494.0, "gain_db": -0.81, "damping": 0.2345 }, { "freq_hz": 829.6, "gain_db": -1.27, "damping": 0.2345 }, { "freq_hz": 1180.9, "gain_db": -2.69, "damping": 0.2345 }, { "freq_hz": 1385.6, "gain_db": 4.97, "damping": 0.2345 }, { "freq_hz": 2255.6, "gain_db": 5.85, "damping": 0.2345 }, { "freq_hz": 3836.3, "gain_db": 3.03, "damping": 0.2345 }, { "freq_hz": 3006.5, "gain_db": 5.69, "damping": 0.2345 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2817.5, "damping": 0.550 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.70, "damping": 0.7071 }, { "freq_hz": 709.5, "gain_db": 0.02, "damping": 0.7071 }, { "freq_hz": 1675.3, "gain_db": 2.13, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -0.03, "damping": 0.7071 }],
  "reverb": { "mix": 0.130, "size": 0.494, "damping": 0.575, "predelay_ms": 10.0 }
}
```
### alto-sax
```json
{
  "gm": 65, "name": "alto-sax", "dry_loss": 2.767, "wet_loss": 3.496,
  "bore": { "bore": 1, "character": 0.7296, "stiffness": 0.5952, "aperture": 0.2477, "position": 0.5886, "damping": 0.6750, "decay": 0.1903, "breath": 0.4805, "noise": 0.1306, "vibrato_depth": 0.1590, "attack_ms": 4.5505, "release_ms": 142.7349, "pitch_vibrato": 0.2292, "vibrato_delay_ms": 1137.6941, "bell": 0.2730, "vibrato_hz": 4.998 },
  "body": [{ "freq_hz": 332.6, "gain_db": -0.16, "damping": 0.1030 }, { "freq_hz": 472.0, "gain_db": 2.77, "damping": 0.1030 }, { "freq_hz": 996.6, "gain_db": 3.58, "damping": 0.1030 }, { "freq_hz": 1193.7, "gain_db": 4.60, "damping": 0.1030 }, { "freq_hz": 1373.1, "gain_db": 2.81, "damping": 0.1030 }, { "freq_hz": 2357.5, "gain_db": 9.73, "damping": 0.1030 }, { "freq_hz": 2137.1, "gain_db": 0.36, "damping": 0.1030 }, { "freq_hz": 4208.5, "gain_db": -4.32, "damping": 0.1030 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2872.2, "damping": 0.608 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -1.54, "damping": 0.7071 }, { "freq_hz": 239.0, "gain_db": -1.27, "damping": 0.7071 }, { "freq_hz": 2867.4, "gain_db": 0.80, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -1.44, "damping": 0.7071 }],
  "reverb": { "mix": 0.149, "size": 0.433, "damping": 0.461, "predelay_ms": 0.0 }
}
```
### flute
```json
{
  "gm": 73, "name": "flute", "dry_loss": 3.555, "wet_loss": 3.730,
  "bore": { "bore": 1, "character": 0.8492, "stiffness": 0.4281, "aperture": 0.2600, "position": 0.6812, "damping": 0.6127, "decay": 0.6848, "breath": 0.3305, "noise": 0.3517, "vibrato_depth": 0.4563, "attack_ms": 3.2053, "release_ms": 200.4844, "pitch_vibrato": 0.1270, "vibrato_delay_ms": 1085.1348, "bell": 0.4642, "vibrato_hz": 4.550 },
  "body": [{ "freq_hz": 323.1, "gain_db": 0.46, "damping": 0.2404 }, { "freq_hz": 486.5, "gain_db": 4.15, "damping": 0.2404 }, { "freq_hz": 981.6, "gain_db": -3.26, "damping": 0.2404 }, { "freq_hz": 1289.0, "gain_db": 3.15, "damping": 0.2404 }, { "freq_hz": 2053.5, "gain_db": 2.77, "damping": 0.2404 }, { "freq_hz": 1735.7, "gain_db": 2.50, "damping": 0.2404 }, { "freq_hz": 2493.6, "gain_db": 3.57, "damping": 0.2404 }, { "freq_hz": 3705.9, "gain_db": 2.43, "damping": 0.2404 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 1074.3, "damping": 0.414 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 0.32, "damping": 0.7071 }, { "freq_hz": 309.6, "gain_db": -1.91, "damping": 0.7071 }, { "freq_hz": 4860.8, "gain_db": 1.69, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 2.18, "damping": 0.7071 }],
  "reverb": { "mix": 0.167, "size": 0.460, "damping": 0.063, "predelay_ms": 45.7 }
}
```
### cello
```json
{
  "gm": 42, "name": "cello", "dry_loss": 4.666, "wet_loss": 4.530,
  "bore": { "bore": 1, "character": 0.9925, "stiffness": 0.3477, "aperture": 0.3414, "position": 0.4037, "damping": 0.3565, "decay": 0.4394, "breath": 0.2336, "noise": 0.7165, "vibrato_depth": 0.5385, "attack_ms": 16.4381, "release_ms": 378.2030, "pitch_vibrato": 0.1655, "vibrato_delay_ms": 799.2211, "bell": 0.7575, "vibrato_hz": 3.907 },
  "body": [{ "freq_hz": 121.4, "gain_db": -0.71, "damping": 0.0856 }, { "freq_hz": 136.6, "gain_db": 2.07, "damping": 0.0856 }, { "freq_hz": 163.9, "gain_db": 8.84, "damping": 0.0856 }, { "freq_hz": 241.8, "gain_db": -0.69, "damping": 0.0856 }, { "freq_hz": 265.2, "gain_db": 5.09, "damping": 0.0856 }, { "freq_hz": 300.6, "gain_db": 0.80, "damping": 0.0856 }, { "freq_hz": 1075.2, "gain_db": -9.40, "damping": 0.0856 }, { "freq_hz": 1452.8, "gain_db": -6.96, "damping": 0.0856 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 1340.7, "damping": 0.709 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -1.26, "damping": 0.7071 }, { "freq_hz": 204.2, "gain_db": -0.30, "damping": 0.7071 }, { "freq_hz": 1833.2, "gain_db": -3.78, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 6.26, "damping": 0.7071 }],
  "reverb": { "mix": 0.076, "size": 0.491, "damping": 0.270, "predelay_ms": 24.3 }
}
```
### violin
```json
{
  "gm": 40, "name": "violin", "dry_loss": 4.775, "wet_loss": 4.665,
  "bore": { "bore": 1, "character": 0.9367, "stiffness": 0.3356, "aperture": 0.9740, "position": 0.8401, "damping": 0.6207, "decay": 0.9124, "breath": 0.2527, "noise": 0.9390, "vibrato_depth": 0.2107, "attack_ms": 2.2649, "release_ms": 288.7427, "pitch_vibrato": 0.3713, "vibrato_delay_ms": 1267.4984, "bell": 0.6748, "vibrato_hz": 5.279 },
  "body": [{ "freq_hz": 316.7, "gain_db": 5.38, "damping": 0.0626 }, { "freq_hz": 439.6, "gain_db": 8.90, "damping": 0.0626 }, { "freq_hz": 525.1, "gain_db": 8.31, "damping": 0.0626 }, { "freq_hz": 663.6, "gain_db": -0.95, "damping": 0.0626 }, { "freq_hz": 725.5, "gain_db": 0.28, "damping": 0.0626 }, { "freq_hz": 798.8, "gain_db": 3.13, "damping": 0.0626 }, { "freq_hz": 2436.9, "gain_db": -4.40, "damping": 0.0626 }, { "freq_hz": 3207.0, "gain_db": 0.02, "damping": 0.0626 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2583.8, "damping": 0.599 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 6.04, "damping": 0.7071 }, { "freq_hz": 272.4, "gain_db": -0.11, "damping": 0.7071 }, { "freq_hz": 1436.3, "gain_db": -6.81, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 5.56, "damping": 0.7071 }],
  "reverb": { "mix": 0.079, "size": 0.489, "damping": 0.225, "predelay_ms": 49.3 }
}
```

## Parameters (2026-10-15-gm5-harm)
### clarinet
```json
{
  "gm": 71, "name": "clarinet", "dry_loss": 3.013, "wet_loss": 3.224,
  "bore": { "bore": 0, "character": 0.2296, "stiffness": 0.7805, "aperture": 0.4126, "position": 1.0000, "damping": 0.8040, "decay": 0.3006, "breath": 0.5609, "noise": 0.1010, "vibrato_depth": 0.2589, "attack_ms": 11.7770, "release_ms": 20.4555, "pitch_vibrato": 0.0000, "vibrato_delay_ms": 701.3192, "bell": 0.0539, "vibrato_hz": 4.943 },
  "body": [{ "freq_hz": 298.0, "gain_db": -0.70, "damping": 0.1805 }, { "freq_hz": 433.1, "gain_db": -0.04, "damping": 0.1805 }, { "freq_hz": 772.1, "gain_db": 0.68, "damping": 0.1805 }, { "freq_hz": 1076.4, "gain_db": -2.39, "damping": 0.1805 }, { "freq_hz": 1368.2, "gain_db": 4.91, "damping": 0.1805 }, { "freq_hz": 2151.4, "gain_db": 4.39, "damping": 0.1805 }, { "freq_hz": 3347.1, "gain_db": 3.91, "damping": 0.1805 }, { "freq_hz": 3111.9, "gain_db": 2.14, "damping": 0.1805 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2840.8, "damping": 0.350 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -1.26, "damping": 0.7071 }, { "freq_hz": 692.7, "gain_db": -0.65, "damping": 0.7071 }, { "freq_hz": 2119.8, "gain_db": 2.36, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -0.52, "damping": 0.7071 }],
  "reverb": { "mix": 0.171, "size": 0.440, "damping": 0.307, "predelay_ms": 0.0 }
}
```
### alto-sax
```json
{
  "gm": 65, "name": "alto-sax", "dry_loss": 3.276, "wet_loss": 3.574,
  "bore": { "bore": 1, "character": 0.7985, "stiffness": 0.4634, "aperture": 0.3953, "position": 0.5916, "damping": 0.5703, "decay": 0.1190, "breath": 0.5990, "noise": 0.1001, "vibrato_depth": 0.1766, "attack_ms": 4.9089, "release_ms": 137.4789, "pitch_vibrato": 0.2800, "vibrato_delay_ms": 1350.4392, "bell": 0.5717, "vibrato_hz": 4.703 },
  "body": [{ "freq_hz": 289.0, "gain_db": -0.85, "damping": 0.1794 }, { "freq_hz": 527.4, "gain_db": 1.84, "damping": 0.1794 }, { "freq_hz": 977.3, "gain_db": 3.62, "damping": 0.1794 }, { "freq_hz": 1378.6, "gain_db": 2.33, "damping": 0.1794 }, { "freq_hz": 1410.5, "gain_db": 1.18, "damping": 0.1794 }, { "freq_hz": 2251.8, "gain_db": 4.03, "damping": 0.1794 }, { "freq_hz": 2244.0, "gain_db": 3.48, "damping": 0.1794 }, { "freq_hz": 4479.4, "gain_db": -1.63, "damping": 0.1794 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2679.8, "damping": 0.673 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.71, "damping": 0.7071 }, { "freq_hz": 618.0, "gain_db": 1.46, "damping": 0.7071 }, { "freq_hz": 1898.1, "gain_db": 0.42, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -0.18, "damping": 0.7071 }],
  "reverb": { "mix": 0.114, "size": 0.498, "damping": 0.424, "predelay_ms": 4.6 }
}
```
### flute
```json
{
  "gm": 73, "name": "flute", "dry_loss": 3.894, "wet_loss": 3.960,
  "bore": { "bore": 1, "character": 0.1816, "stiffness": 0.5902, "aperture": 0.2207, "position": 0.3362, "damping": 0.4311, "decay": 0.7743, "breath": 0.0648, "noise": 0.5076, "vibrato_depth": 0.3476, "attack_ms": 2.8632, "release_ms": 184.6715, "pitch_vibrato": 0.1430, "vibrato_delay_ms": 1063.1406, "bell": 0.3706, "vibrato_hz": 4.606 },
  "body": [{ "freq_hz": 313.8, "gain_db": -1.19, "damping": 0.2314 }, { "freq_hz": 532.4, "gain_db": 2.05, "damping": 0.2314 }, { "freq_hz": 940.1, "gain_db": -0.49, "damping": 0.2314 }, { "freq_hz": 1324.0, "gain_db": 6.59, "damping": 0.2314 }, { "freq_hz": 2100.0, "gain_db": 3.56, "damping": 0.2314 }, { "freq_hz": 2139.8, "gain_db": 2.76, "damping": 0.2314 }, { "freq_hz": 2851.6, "gain_db": 3.74, "damping": 0.2314 }, { "freq_hz": 4236.6, "gain_db": 1.45, "damping": 0.2314 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 1021.5, "damping": 0.728 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 0.05, "damping": 0.7071 }, { "freq_hz": 727.3, "gain_db": -0.07, "damping": 0.7071 }, { "freq_hz": 5006.0, "gain_db": 1.44, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 2.16, "damping": 0.7071 }],
  "reverb": { "mix": 0.171, "size": 0.452, "damping": 0.000, "predelay_ms": 62.4 }
}
```
### cello
```json
{
  "gm": 42, "name": "cello", "dry_loss": 5.002, "wet_loss": 4.475,
  "bore": { "bore": 1, "character": 0.9753, "stiffness": 0.6358, "aperture": 0.3029, "position": 0.4221, "damping": 0.0711, "decay": 0.5813, "breath": 0.2610, "noise": 0.5814, "vibrato_depth": 0.5527, "attack_ms": 19.8243, "release_ms": 363.3294, "pitch_vibrato": 0.1394, "vibrato_delay_ms": 565.5035, "bell": 0.7595, "vibrato_hz": 5.052 },
  "body": [{ "freq_hz": 108.3, "gain_db": -1.14, "damping": 0.1283 }, { "freq_hz": 159.5, "gain_db": 3.36, "damping": 0.1283 }, { "freq_hz": 171.1, "gain_db": 8.45, "damping": 0.1283 }, { "freq_hz": 223.2, "gain_db": 0.61, "damping": 0.1283 }, { "freq_hz": 288.2, "gain_db": 3.46, "damping": 0.1283 }, { "freq_hz": 300.1, "gain_db": -0.65, "damping": 0.1283 }, { "freq_hz": 1107.0, "gain_db": -9.28, "damping": 0.1283 }, { "freq_hz": 1515.2, "gain_db": -8.58, "damping": 0.1283 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 1181.7, "damping": 0.520 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.38, "damping": 0.7071 }, { "freq_hz": 367.0, "gain_db": -1.66, "damping": 0.7071 }, { "freq_hz": 3656.8, "gain_db": -2.59, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 5.97, "damping": 0.7071 }],
  "reverb": { "mix": 0.099, "size": 0.446, "damping": 0.267, "predelay_ms": 23.6 }
}
```
### violin
```json
{
  "gm": 40, "name": "violin", "dry_loss": 5.434, "wet_loss": 4.925,
  "bore": { "bore": 1, "character": 0.9109, "stiffness": 0.6184, "aperture": 0.7310, "position": 0.3926, "damping": 0.6957, "decay": 0.7476, "breath": 0.1820, "noise": 0.7060, "vibrato_depth": 0.1271, "attack_ms": 5.3095, "release_ms": 292.9805, "pitch_vibrato": 0.3571, "vibrato_delay_ms": 1437.1659, "bell": 0.5394, "vibrato_hz": 6.259 },
  "body": [{ "freq_hz": 306.7, "gain_db": 4.32, "damping": 0.0490 }, { "freq_hz": 440.1, "gain_db": 9.53, "damping": 0.0490 }, { "freq_hz": 517.5, "gain_db": 6.49, "damping": 0.0490 }, { "freq_hz": 640.4, "gain_db": -2.47, "damping": 0.0490 }, { "freq_hz": 722.4, "gain_db": 1.88, "damping": 0.0490 }, { "freq_hz": 971.2, "gain_db": 1.18, "damping": 0.0490 }, { "freq_hz": 2384.1, "gain_db": -3.85, "damping": 0.0490 }, { "freq_hz": 3545.2, "gain_db": 0.85, "damping": 0.0490 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 3414.7, "damping": 0.749 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 5.56, "damping": 0.7071 }, { "freq_hz": 276.6, "gain_db": -1.40, "damping": 0.7071 }, { "freq_hz": 1506.9, "gain_db": -4.70, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 4.36, "damping": 0.7071 }],
  "reverb": { "mix": 0.089, "size": 0.484, "damping": 0.334, "predelay_ms": 49.8 }
}
```
