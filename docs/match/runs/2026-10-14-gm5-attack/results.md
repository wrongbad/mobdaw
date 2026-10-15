| program | GM | bore | dry loss (incl. vibrato term) | vibrato target / fit (cents, Hz) | attack 10-90% target / fit (ms) | other bore | wet: no reverb | wet: fitted reverb |
|---|---|---|---|---|---|---|---|---|
| clarinet | 71 | closed | 2.77 | 0 / 1, 16.6 / 13.1 | 127 / 250 | 3.11 | 10.37 | 3.54 |
| alto-sax | 65 | open | 3.18 | 10 / 8, 5.0 / 5.0 | 43 / 53 | 3.76 | 9.44 | 3.81 |
| flute | 73 | open | 4.51 | 7 / 5, 6.4 / 7.0 | 170 / 222 | 4.89 | 9.52 | 4.40 |
| cello | 42 | open | 4.83 | 8 / 9, 5.3 / 5.5 | 453 / 408 | 5.70 | 9.93 | 4.50 |
| violin | 40 | open | 4.82 | 12 / 12, 5.7 / 6.1 | 377 / 235 | 5.90 | 9.63 | 4.74 |

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
