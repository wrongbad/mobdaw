| program | GM | bore | dry loss (incl. vibrato term) | vibrato target / fit (cents, Hz) | attack 10-90% target / fit (ms) | other bore | wet: no reverb | wet: fitted reverb |
|---|---|---|---|---|---|---|---|---|
| clarinet | 71 | closed | 3.01 | 0 / 0, 16.6 / 24.5 | 95 / 33 | 3.40 | 10.45 | 3.22 |
| alto-sax | 65 | open | 3.28 | 10 / 9, 5.0 / 5.0 | 22 / 43 | 3.28 | 9.43 | 3.57 |
| flute | 73 | open | 3.89 | 7 / 5, 6.4 / 6.6 | 63 / 47 | 3.99 | 9.36 | 3.96 |
| cello | 42 | open | 5.00 | 8 / 7, 5.3 / 5.0 | 213 / 278 | 5.94 | 10.05 | 4.48 |
| violin | 40 | open | 5.43 | 12 / 10, 5.7 / 6.1 | 183 / 87 | 6.13 | 9.84 | 4.92 |

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
