| program | GM | bore | dry loss (incl. vibrato term) | vibrato target / fit (cents, Hz) | other bore | wet: no reverb | wet: fitted reverb |
|---|---|---|---|---|---|---|---|
| cello | 42 | open | 3.10 | 8 / 8, 5.3 / 5.3 | 3.87 | 8.47 | 3.02 |
| violin | 40 | open | 3.22 | 12 / 12, 5.7 / 6.1 | 3.84 | 7.93 | 3.32 |

### cello
```json
{
  "gm": 42, "name": "cello", "dry_loss": 3.101, "wet_loss": 3.016,
  "bore": { "bore": 1, "character": 0.9610, "stiffness": 0.7269, "aperture": 0.9235, "position": 0.7985, "damping": 0.5690, "decay": 0.7879, "breath": 0.2594, "noise": 0.5681, "vibrato_depth": 0.0532, "attack_ms": 5.6604, "release_ms": 368.2486, "pitch_vibrato": 0.1436, "vibrato_hz": 4.993 },
  "body": [{ "freq_hz": 87.8, "gain_db": -4.08, "damping": 0.0695 }, { "freq_hz": 171.3, "gain_db": 7.50, "damping": 0.0695 }, { "freq_hz": 214.6, "gain_db": 3.14, "damping": 0.0695 }, { "freq_hz": 226.1, "gain_db": -1.58, "damping": 0.0695 }, { "freq_hz": 268.3, "gain_db": -0.01, "damping": 0.0695 }, { "freq_hz": 516.8, "gain_db": -3.23, "damping": 0.0695 }, { "freq_hz": 1172.3, "gain_db": -5.83, "damping": 0.0695 }, { "freq_hz": 990.3, "gain_db": -5.42, "damping": 0.0695 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2315.9, "damping": 0.606 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.11, "damping": 0.7071 }, { "freq_hz": 212.9, "gain_db": 0.27, "damping": 0.7071 }, { "freq_hz": 1667.3, "gain_db": -0.95, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 6.89, "damping": 0.7071 }],
  "reverb": { "mix": 0.075, "size": 0.513, "damping": 0.105, "predelay_ms": 17.9 }
}
```
### violin
```json
{
  "gm": 40, "name": "violin", "dry_loss": 3.221, "wet_loss": 3.319,
  "bore": { "bore": 1, "character": 0.8915, "stiffness": 0.6141, "aperture": 0.6915, "position": 0.7566, "damping": 0.6448, "decay": 0.8909, "breath": 0.1637, "noise": 0.5498, "vibrato_depth": 0.4069, "attack_ms": 4.9003, "release_ms": 294.7003, "pitch_vibrato": 0.2239, "vibrato_hz": 6.118 },
  "body": [{ "freq_hz": 233.8, "gain_db": -1.61, "damping": 0.1247 }, { "freq_hz": 399.0, "gain_db": 3.25, "damping": 0.1247 }, { "freq_hz": 489.9, "gain_db": 5.28, "damping": 0.1247 }, { "freq_hz": 611.7, "gain_db": -0.88, "damping": 0.1247 }, { "freq_hz": 701.8, "gain_db": -2.17, "damping": 0.1247 }, { "freq_hz": 1016.4, "gain_db": -0.77, "damping": 0.1247 }, { "freq_hz": 2828.5, "gain_db": -4.60, "damping": 0.1247 }, { "freq_hz": 3039.3, "gain_db": 8.91, "damping": 0.1247 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 3150.3, "damping": 0.795 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 3.31, "damping": 0.7071 }, { "freq_hz": 301.4, "gain_db": -2.90, "damping": 0.7071 }, { "freq_hz": 1467.6, "gain_db": -4.58, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 6.67, "damping": 0.7071 }],
  "reverb": { "mix": 0.082, "size": 0.509, "damping": 0.490, "predelay_ms": 57.2 }
}
```
