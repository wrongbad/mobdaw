# GM5 joint chain match (bore + filter + EQ, then reverb)

Provenance: base commit 9c7d87b + uncommitted joint-chain code (dirty), `match_chain FluidR3_GM.sf2 <dir> 160 48`, ES seeds 11+GM(+open) / 99+GM (reverb), loss v0 (as 2026-10-14-gm5), 3 probe notes per program at vel 90. Dry fit uses 1.2 s held / 1.8 s clips; reverb fit uses 3.0 s clips against the soundfont's own wet render (rustysynth reverb+chorus on, GM default sends). Rendered through the engine's real filter (kind 1), EQ (kind 8) and reverb (kind 3) devices, so the values carry into the app as-is. ~1 min total.

Method:
1. Joint dry fit, one ES over 16 dims (11 bore knobs, vibrato rate, lowpass cutoff and damping, EQ bell 1/2 centres), per bore type. Each candidate gets its own EQ: the 4 band gains are solved in closed form (centred ridge least squares of the mean target-minus-candidate long-term log spectrum onto each band's response, shared across all probe notes, ±12 dB cap) before it is scored. So the timbre knobs are always judged with their best EQ, and EQ can only do broad, note-independent shaping.
2. Reverb fit (mix, size, damping, predelay) with the dry chain frozen, against the wet target.

| program | GM | bore | dry loss (joint) | dry loss (bore only, same budget) | wet: no reverb | wet: fitted reverb |
|---|---|---|---|---|---|---|
| clarinet | 71 | open | 2.03 | 2.77 | 9.50 | 2.97 |
| alto sax | 65 | open | 2.32 | 3.31 | 8.64 | 2.91 |
| flute | 73 | open | 2.96 | 3.71 | 8.32 | 2.99 |
| cello | 42 | open | 3.40 | 4.01 | 8.64 | 3.26 |
| violin | 40 | open | 3.32 | 3.90 | 8.05 | 3.37 |

The bore-only column is `match_bore ... 160 48` (docs/match/runs/2026-10-14-gm5-bore-samebudget, local), so the gain is from the chain, not budget.

## Reading it

- Joint fit beats bore-only by 0.6-1.0 on every program. Fitted EQ gains stay small (|g| <= 2.3 dB): the lowpass and bore knobs carry the tone, as intended.
- Reverb settles consistently at mix 0.06-0.17, size ~0.5, low damping. Tails match the soundfont's by eye (compare_best_wet.png). Violin predelay is 50 ms (range 0-80), much longer than the others; check by ear.
- Still missing: vibrato. Fitted rates are 2.8-4 Hz with small depth; the 40-band log loss averages out pitch wobble, so it can't see it. Needs a pitch-track (f0 contour) term.
- Clarinet now fits with open bore and character 0.91 (bow anchor) plus a 2.5 kHz lowpass, instead of a closed reed. FluidR3's clarinet has strong even harmonics, so this may be honest, but it's a candidate to listen to against the closed-reed variant.
- Flute aperture at 0, violin breath 0.04 and noise 0.99: still on bounds.

Per-program `best.json` (bore, filter, EQ, reverb in app units), and dry/wet target and best WAVs: `<program>/` (local). Plots: `compare_best_dry.png`, `compare_best_wet.png` (local; `engine/crates/match/plot_compare.py <dir> target_wet best_wet`).

## Parameters
### clarinet
```json
{
  "gm": 71, "name": "clarinet", "dry_loss": 2.030, "wet_loss": 2.973,
  "bore": { "bore": 1, "character": 0.9093, "stiffness": 0.5729, "aperture": 0.7919, "position": 0.4809, "damping": 0.9705, "decay": 0.6681, "breath": 0.2954, "noise": 0.0000, "vibrato_depth": 0.1691, "attack_ms": 2.7643, "release_ms": 22.5046, "vibrato_hz": 4.037 },
  "filter": { "mode": "lowpass", "cutoff_hz": 2494.5, "damping": 0.494 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.53, "damping": 0.7071 }, { "freq_hz": 643.2, "gain_db": 0.30, "damping": 0.7071 }, { "freq_hz": 2079.1, "gain_db": 0.88, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -0.09, "damping": 0.7071 }],
  "reverb": { "mix": 0.154, "size": 0.465, "damping": 0.270, "predelay_ms": 5.1 }
}
```
### alto-sax
```json
{
  "gm": 65, "name": "alto-sax", "dry_loss": 2.322, "wet_loss": 2.905,
  "bore": { "bore": 1, "character": 0.0519, "stiffness": 0.3524, "aperture": 0.5701, "position": 0.4209, "damping": 0.6556, "decay": 0.3443, "breath": 0.2105, "noise": 0.2255, "vibrato_depth": 0.4575, "attack_ms": 2.3822, "release_ms": 135.5947, "vibrato_hz": 5.393 },
  "filter": { "mode": "lowpass", "cutoff_hz": 2344.2, "damping": 0.627 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 0.17, "damping": 0.7071 }, { "freq_hz": 511.7, "gain_db": 0.21, "damping": 0.7071 }, { "freq_hz": 3383.4, "gain_db": 0.49, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": -0.46, "damping": 0.7071 }],
  "reverb": { "mix": 0.150, "size": 0.481, "damping": 0.320, "predelay_ms": 4.7 }
}
```
### flute
```json
{
  "gm": 73, "name": "flute", "dry_loss": 2.959, "wet_loss": 2.987,
  "bore": { "bore": 1, "character": 0.8831, "stiffness": 0.7744, "aperture": 0.0000, "position": 0.5802, "damping": 0.5689, "decay": 0.9232, "breath": 0.3791, "noise": 0.5789, "vibrato_depth": 0.0863, "attack_ms": 3.2244, "release_ms": 180.7965, "vibrato_hz": 3.435 },
  "filter": { "mode": "lowpass", "cutoff_hz": 2267.7, "damping": 0.658 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.07, "damping": 0.7071 }, { "freq_hz": 200.0, "gain_db": -2.31, "damping": 0.7071 }, { "freq_hz": 2915.8, "gain_db": 0.59, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 1.32, "damping": 0.7071 }],
  "reverb": { "mix": 0.166, "size": 0.488, "damping": 0.373, "predelay_ms": 7.7 }
}
```
### cello
```json
{
  "gm": 42, "name": "cello", "dry_loss": 3.398, "wet_loss": 3.257,
  "bore": { "bore": 1, "character": 0.7483, "stiffness": 0.7676, "aperture": 0.6963, "position": 0.2981, "damping": 0.5084, "decay": 0.4209, "breath": 0.2748, "noise": 0.7228, "vibrato_depth": 0.4885, "attack_ms": 4.6678, "release_ms": 368.8427, "vibrato_hz": 2.808 },
  "filter": { "mode": "lowpass", "cutoff_hz": 1901.1, "damping": 0.564 },
  "eq": [{ "freq_hz": 100.0, "gain_db": -0.72, "damping": 0.7071 }, { "freq_hz": 425.2, "gain_db": -0.60, "damping": 0.7071 }, { "freq_hz": 1567.6, "gain_db": -0.97, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 1.70, "damping": 0.7071 }],
  "reverb": { "mix": 0.059, "size": 0.523, "damping": 0.261, "predelay_ms": 18.9 }
}
```
### violin
```json
{
  "gm": 40, "name": "violin", "dry_loss": 3.318, "wet_loss": 3.373,
  "bore": { "bore": 1, "character": 0.2946, "stiffness": 0.9979, "aperture": 0.6156, "position": 0.2555, "damping": 0.6296, "decay": 0.4617, "breath": 0.0354, "noise": 0.9931, "vibrato_depth": 0.2074, "attack_ms": 10.8619, "release_ms": 298.2484, "vibrato_hz": 2.922 },
  "filter": { "mode": "lowpass", "cutoff_hz": 4494.7, "damping": 1.011 },
  "eq": [{ "freq_hz": 100.0, "gain_db": 1.28, "damping": 0.7071 }, { "freq_hz": 809.1, "gain_db": -0.81, "damping": 0.7071 }, { "freq_hz": 2565.9, "gain_db": 0.06, "damping": 0.7071 }, { "freq_hz": 8000.0, "gain_db": 0.19, "damping": 0.7071 }],
  "reverb": { "mix": 0.095, "size": 0.506, "damping": 0.496, "predelay_ms": 50.0 }
}
```
