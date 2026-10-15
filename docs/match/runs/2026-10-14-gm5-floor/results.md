| program | GM | bore | dry loss (incl. vibrato term) | vibrato target / fit (cents, Hz) | attack 10-90% target / fit (ms) | other bore | wet: no reverb | wet: fitted reverb |
|---|---|---|---|---|---|---|---|---|
| clarinet | 71 | open | 2.79 | 0 / 0, 16.6 / 28.7 | 95 / 78 | 2.84 | 10.49 | 3.38 |
| alto-sax | 65 | open | 2.96 | 10 / 8, 5.0 / 5.0 | 22 / 28 | 3.33 | 9.43 | 3.63 |
| flute | 73 | open | 3.65 | 7 / 5, 6.4 / 6.6 | 63 / 72 | 4.15 | 9.19 | 3.79 |
| cello | 42 | open | 4.70 | 8 / 9, 5.3 / 5.2 | 213 / 198 | 5.45 | 10.12 | 4.55 |
| violin | 40 | open | 4.82 | 12 / 11, 5.7 / 6.1 | 183 / 122 | 5.79 | 9.66 | 4.73 |

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
