#!/bin/sh
# One-factor-at-a-time sweeps around the defaults (stiffness .5, damping .3, decay .7), notes every 12 semitones.
BIN=/Users/k/projects/www/kyle.fi/mobdaw/engine/target/release/bore_calibrate
D=$(dirname "$0")
for s in 0 0.25 0.75 1; do $BIN sweep $D/stiff_$s.csv --pin $s,0.3,0.7 --note-step 12; done
for d in 0 0.15 0.45 0.6 0.8 1; do $BIN sweep $D/damp_$d.csv --pin 0.5,$d,0.7 --note-step 12; done
for r in 0 0.2 0.4 0.6 0.85 1; do $BIN sweep $D/decay_$r.csv --pin 0.5,0.3,$r --note-step 12; done
$BIN sweep $D/base.csv --pin 0.5,0.3,0.7 --note-step 12
echo done > $D/DONE
