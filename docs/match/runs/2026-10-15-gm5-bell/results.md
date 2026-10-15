| program | GM | bore | dry loss (incl. vibrato term) | vibrato target / fit (cents, Hz) | attack 10-90% target / fit (ms) | other bore | wet: no reverb | wet: fitted reverb |
|---|---|---|---|---|---|---|---|---|
| clarinet | 71 | closed | 2.39 | 0 / 1, 16.6 / 10.1 | 95 / 28 | 2.87 | 10.35 | 3.32 |
| alto-sax | 65 | open | 2.77 | 10 / 9, 5.0 / 5.0 | 22 / 35 | 2.96 | 9.34 | 3.50 |
| flute | 73 | open | 3.56 | 7 / 5, 6.4 / 6.6 | 63 / 50 | 3.84 | 9.17 | 3.73 |
| cello | 42 | open | 4.67 | 8 / 8, 5.3 / 5.0 | 213 / 277 | 5.27 | 9.98 | 4.53 |
| violin | 40 | open | 4.77 | 12 / 12, 5.7 / 5.5 | 183 / 117 | 5.40 | 9.72 | 4.67 |

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
