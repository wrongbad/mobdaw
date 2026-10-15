# Strings re-match: pitch vibrato, body resonator, vibrato loss, bow-only character

Provenance: commit 9361ba2 + relative-ridge change (dirty, committed with this file), `match_chain FluidR3_GM.sf2 <dir> 250 48 --only cello,violin` (run.sh), calibration ef8273a, ES seeds as before, ~10 min per run.

What changed vs 2026-10-14-gm5-joint (see docs/bore.md, docs/engine-api.md kind 11):
- DSP: bore `vibrato pitch` (param 14) retunes the loop at the vibrato rate, 60 cents peak at 1. The old vibrato only modulated the drive (breath vibrato), so the strings could not wobble in pitch at all.
- Chain: a body resonator (kind 11, 8 narrow bells) before the filter. Peak frequencies (±40% around violin values; cello 0.4x) and one shared damping are searched; the 8 body + 4 EQ gains are solved in closed form per candidate on a finer 96-band / 4096-point spectrum.
- Gain solve ridge is now relative to each band's own column energy (body 10%, EQ 30%). The earlier absolute ridge swamped narrow peaks (body gains came out within ±1.7 dB, ~4x shrunk): see 2026-10-14-strings-body-absridge (local). The winds in gm5-joint were fitted with the old absolute ridge, so their small EQ gains are partly that shrinkage, not evidence that the synth alone carries their tone.
- Loss: + 0.08 per cent of vibrato depth error + 0.25 per Hz of rate error (from an autocorrelation pitch track of the held part). Character bounded to 0.75-1 for strings.

| program | dry loss before (gm5-joint, no vibrato term) | absolute ridge | now (incl. vibrato term) | vibrato target / fit | wet loss before / now |
|---|---|---|---|---|---|
| cello | 3.40 | 3.37 | 3.10 | 8 / 8 cents, 5.3 / 5.3 Hz | 3.26 / 3.02 |
| violin | 3.32 | 3.36 | 3.22 | 12 / 12 cents, 5.7 / 6.1 Hz | 3.37 / 3.32 |

Before, the fits escaped the bow (violin character 0.29, breath 0.04, noise 0.99); now both are bowed (0.89-0.93).

## Reading it

- Pitch vibrato is visible in compare_dry.png and matches the soundfont's depth and rate.
- Body gains are real now: violin +8.9 dB at 3.0 kHz (bridge hill), +5.3 dB at 490 Hz, +3.3 dB at 400 Hz (body modes); cello +7.5 dB at 171 Hz. Two peaks often settle close together (violin 2.8 / 3.0 kHz, cut / boost): the fit uses a pair as a sharper shaped bump.
- Still a gap to the target: noise stays high (0.55-0.63) and the bow attack is a fast 4-6 ms. The loss term for the attack is a small part of the clip; a weighted onset segment would help.

## Next

1. Re-run the winds with the relative ridge (their EQ was shrunk).
2. Weight the attack segment in the loss; check bow scratch / noise by ear.
3. Listen; if the body sounds right, consider body for reeds too (sax bell / clarinet bore radiation).

## Parameters
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
