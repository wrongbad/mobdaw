| program | GM | bore | dry loss (incl. vibrato term) | vibrato target / fit (cents, Hz) | attack 10-90% target / fit (ms) | other bore | wet: no reverb | wet: fitted reverb |
|---|---|---|---|---|---|---|---|---|
| clarinet | 71 | closed | 3.57 | 0 / 1, 16.6 / 8.1 | 95 / 33 | 3.74 | 10.33 | 3.26 |
| alto-sax | 65 | closed | 3.54 | 10 / 8, 5.0 / 5.0 | 22 / 22 | 3.56 | 9.42 | 3.61 |
| flute | 73 | open | 3.85 | 7 / 5, 6.4 / 6.6 | 63 / 62 | 4.32 | 9.16 | 3.51 |
| cello | 42 | open | 5.43 | 8 / 8, 5.3 / 5.0 | 213 / 218 | 6.60 | 9.99 | 4.33 |
| violin | 40 | open | 5.94 | 12 / 10, 5.7 / 6.1 | 183 / 118 | 6.41 | 9.97 | 4.85 |

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
