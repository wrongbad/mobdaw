| program | GM | bore | dry loss (incl. vibrato term) | vibrato target / fit (cents, Hz) | other bore | wet: no reverb | wet: fitted reverb |
|---|---|---|---|---|---|---|---|
| cello | 42 | open | 3.37 | 8 / 8, 5.3 / 5.3 | 3.84 | 8.55 | 3.28 |
| violin | 40 | open | 3.36 | 12 / 12, 5.7 / 6.1 | 3.90 | 8.04 | 3.35 |

### cello
```json
{
  "gm": 42, "name": "cello", "dry_loss": 3.368, "wet_loss": 3.280,
  "bore": { "bore": 1, "character": 0.9266, "stiffness": 0.7994, "aperture": 0.9424, "position": 0.6575, "damping": 0.4050, "decay": 0.6236, "breath": 0.4328, "noise": 0.6332, "vibrato_depth": 0.2206, "attack_ms": 6.4759, "release_ms": 373.4485, "pitch_vibrato": 0.1453, "vibrato_hz": 4.872 },
  "body": [{ "freq_hz": 92.9, "gain_db": -0.90, "damping": 0.1206 }, { "freq_hz": 178.3, "gain_db": 1.66, "damping": 0.1206 }, { "freq_hz": 162.6, "gain_db": 1.52, "damping": 0.1206 }, { "freq_hz": 175.8, "gain_db": 1.65, "damping": 0.1206 }, { "freq_hz": 217.5, "gain_db": 1.55, "damping": 0.1206 }, { "freq_hz": 508.5, "gain_db": 0.96, "damping": 0.1206 }, { "freq_hz": 1064.1, "gain_db": -1.41, "damping": 0.1206 }, { "freq_hz": 1066.9, "gain_db": -1.43, "damping": 0.1206 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 2988.4, "damping": 0.749 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.03, "damping": 0.7071 }, { "freq_hz": 416.0, "gain_db": 0.19, "damping": 0.7071 }, { "freq_hz": 3141.6, "gain_db": -0.91, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 0.76, "damping": 0.7071 }],
  "reverb": { "mix": 0.069, "size": 0.504, "damping": 0.435, "predelay_ms": 18.3 }
}
```
### violin
```json
{
  "gm": 40, "name": "violin", "dry_loss": 3.364, "wet_loss": 3.351,
  "bore": { "bore": 1, "character": 0.8933, "stiffness": 0.4581, "aperture": 0.8094, "position": 0.5943, "damping": 0.4893, "decay": 0.8762, "breath": 0.0704, "noise": 0.6202, "vibrato_depth": 0.3805, "attack_ms": 3.6859, "release_ms": 296.0659, "pitch_vibrato": 0.2194, "vibrato_hz": 6.122 },
  "body": [{ "freq_hz": 227.5, "gain_db": -1.37, "damping": 0.0986 }, { "freq_hz": 356.1, "gain_db": 0.18, "damping": 0.0986 }, { "freq_hz": 461.2, "gain_db": 1.25, "damping": 0.0986 }, { "freq_hz": 671.1, "gain_db": -0.86, "damping": 0.0986 }, { "freq_hz": 640.8, "gain_db": -0.76, "damping": 0.0986 }, { "freq_hz": 993.6, "gain_db": -1.28, "damping": 0.0986 }, { "freq_hz": 2874.5, "gain_db": 0.39, "damping": 0.0986 }, { "freq_hz": 2995.3, "gain_db": 0.63, "damping": 0.0986 }],
  "filter": { "mode": "lowpass", "cutoff_hz": 3876.6, "damping": 0.839 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 0.87, "damping": 0.7071 }, { "freq_hz": 379.9, "gain_db": -0.44, "damping": 0.7071 }, { "freq_hz": 1081.2, "gain_db": -1.08, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 0.96, "damping": 0.7071 }],
  "reverb": { "mix": 0.096, "size": 0.461, "damping": 0.256, "predelay_ms": 51.9 }
}
```
