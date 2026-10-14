# GM5 bore match (first end-to-end pass)

Provenance: base commit ef8273a + uncommitted `engine/crates/match` (dirty), `match_bore FluidR3_GM.sf2 <dir> 80 32`, seed 7+GM, bore calibration 79% speak fit, loss v0 (log-band STFT L1 at 512/2048 + 2x dB envelope), 3 probe notes per program (vel 90, 1.2 s held, 1.8 s), 44.1 kHz, rustysynth dry (reverb/chorus off). Machine: local.

Search: random-scatter start (3x pop) then (mu/mu,lambda)-ES with 1/5-style sigma, 80 gens x 32, run once per bore (closed/open), keep the lower loss. Not CMA-ES, no staging, no analytic init. Whole run takes ~10 s.

| program | GM | bore | loss | other bore | character | stiff | aperture | position | damping | decay | breath | noise | vib depth | attack ms | release ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| clarinet | 71 | closed | 3.03 | 3.55 | 0.10 | 0.99 | 0.00 | 0.98 | 0.76 | 0.58 | 0.57 | 0.00 | 0.26 | 8.5 | 20 |
| alto sax | 65 | open | 3.30 | 3.55 | 0.87 | 0.68 | 0.32 | 0.38 | 1.00 | 0.65 | 0.43 | 0.03 | 0.56 | 2.4 | 143 |
| flute | 73 | closed | 3.54 | 3.93 | 0.10 | 0.56 | 0.20 | 0.94 | 0.97 | 0.71 | 0.04 | 0.09 | 0.31 | 9.2 | 189 |
| cello | 42 | open | 4.02 | 4.29 | 0.72 | 0.86 | 0.22 | 0.64 | 0.71 | 0.49 | 0.32 | 0.07 | 0.35 | 2.6 | 374 |
| violin | 40 | open | 3.91 | 4.49 | 0.69 | 0.75 | 0.42 | 0.65 | 0.90 | 0.57 | 0.14 | 0.63 | 0.14 | 2.9 | 297 |

Spectrograms (target left, best right, mid note of each): `compare.png` (local, ignored; regenerate with `engine/crates/match/plot_compare.py`).

## Reading it

- Harmonic series, brightness slope and odd/even balance (clarinet closed bore) match well by eye.
- Unmatched: violin/cello vibrato (we fix rate at the 5 Hz default, target wobbles faster/deeper; rate is not in the search), the soundfont's hard note-off cut (bore release is slewed), and sax/flute broadband noise texture.
- Several fits sit on bounds (clarinet aperture 0, position 0.98, flute breath 0.04, release 20 ms floor). Likely the loss exploiting calibration seams: breath ~0 and position ~1 are edges of the sounding region, so treat these as suspicious, not final. Candidates, not shipped presets.
- Loss is mean abs log-power difference, so 3-4 means roughly 3-4 nepers per band: the numbers are only comparable between candidates, not absolute quality.

## Next

1. Add vibrato rate to the search; clamp position/breath inside the calibrated interior and compare.
2. Listen to `best_*.wav` vs `target_*.wav` and adjust loss weights (envelope term, attack weight).
3. Swap ES for CMA-ES, add `speaks` gate from `bore_calibrate`, then promote to the planned `match-worker`.
