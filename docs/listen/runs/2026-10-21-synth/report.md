# listen-eval: synth

2026-10-21, `docs/listen/eval-synth`, 15 takes, git fb39f53, `tools/listen-eval.py`. Raw per-bar data: `bars.csv` (git-ignored).

These takes are synthetic (`agent/tests/synth.py`: strummed Karplus-Strong strings, a body, a room), and the hearing was fitted on the same material: read the numbers as the best case. The point of this tool is a folder of real recordings.

## Overall (chords)

- **14 takes, 456 beats**: root right on **100%**, quality exactly right on **99%** (triad / 7th / power as labelled), major-minor-power family right on 100%.
- key right on **14/14** takes that name one (a relative major/minor instead: 0).
- tuning within 3 cents of the label on 14/14 takes (mean error 1.2, worst 1.7 cents).
- grid check passed on 14/14 takes; hearing took 0.5 s per take on average.

### Does the confidence mean anything?

- mean confidence on beats heard right: 0.96; on beats heard wrong: 1.00 (4 beats).
- beats marked `<- unsure`: 12 (3%); of the wrong beats 0% were marked, of the marked beats 0% were wrong.

### Confusions (label -> heard, beats)

G -> Gmaj7 x4

### Per take

| take | bars | bpm | root | quality | family | key (label -> heard) | tuning err | grid | unsure | heard |
|---|---|---|---|---|---|---|---|---|---|---|
| am-dm-e-am | 8 | 90 4/4 | 100% | 100% | 100% | A minor -> A minor ok | +1.2 | on | 4 | Am \| Dm \| E \| Am \| Am \| Dm \| E \| Am |
| am-f-c-g-driven | 8 | 100 4/4 | 100% | 100% | 100% | A minor -> A minor ok | +1.3 | on | 0 | Am \| F \| C \| G \| Am \| F \| C \| G |
| am-f-c-g-flat | 8 | 100 4/4 | 100% | 100% | 100% | A minor -> A minor ok | +1.2 | on | 0 | Am \| F \| C \| G \| Am \| F \| C \| G |
| am-f-c-g-roomy | 8 | 100 4/4 | 100% | 100% | 100% | A minor -> A minor ok | +1.3 | on | 4 | Am \| F \| C \| G \| Am \| F \| C \| G |
| am-f-c-g-sharp | 8 | 100 4/4 | 100% | 100% | 100% | A minor -> A minor ok | +1.3 | on | 4 | Am \| F \| C \| G \| Am \| F \| C \| G |
| am-f-c-g | 8 | 100 4/4 | 100% | 100% | 100% | A minor -> A minor ok | +1.2 | on | 0 | Am \| F \| C \| G \| Am \| F \| C \| G |
| blues-in-a | 12 | 100 4/4 | 100% | 100% | 100% | A major, A minor -> A major ok | +1.1 | on | 0 | A7 \| A7 \| A7 \| A7 \| D7 \| D7 \| A7 \| A7 \| E7 \| D7 \| A7 \| E7 |
| c-g-am-f | 8 | 90 4/4 | 100% | 100% | 100% | C major -> C major ok | +1.5 | on | 0 | C \| G \| Am \| F \| C \| G \| Am \| F |
| d-a-bm-g | 8 | 100 4/4 | 100% | 88% | 100% | D major -> D major ok | +0.9 | on | 0 | D \| A \| Bm \| Gmaj7 \| D \| A \| Bm \| G |
| d-bm-g-a-waltz | 8 | 110 3/4 | 100% | 100% | 100% | D major -> D major ok | +0.8 | on | 0 | D \| Bm \| G \| A \| D \| Bm \| G \| A |
| em-c-g-d | 8 | 110 4/4 | 100% | 100% | 100% | E minor -> E minor ok | +1.3 | on | 0 | Em \| C \| G \| D \| Em \| C \| G \| D |
| g-em-c-d-140 | 8 | 140 4/4 | 100% | 100% | 100% | G major -> G major ok | +1.2 | on | 0 | G \| Em \| C \| D \| G \| Em \| C \| D |
| g-em-c-d-70 | 8 | 70 4/4 | 100% | 100% | 100% | G major -> G major ok | +1.2 | on | 0 | G \| Em \| C \| D \| G \| Em \| C \| D |
| power-e-a-d-e | 8 | 100 4/4 | 100% | 100% | 100% | E minor -> E minor ok | +1.7 | on | 0 | E5 \| A5 \| D5 \| E5 \| E5 \| A5 \| D5 \| E5 |

### Bars that were not all right

- d-a-bm-g bar 4: label `G`, heard `Gmaj7` (0/4 beats right, confidence 1.00)

## Overall (notes)

- **1 takes**: 17 of 17 labelled notes heard at the right pitch within a 16th (recall 100%, precision 100%); 17 exactly on the labelled slot.

| take | bpm | notes | heard | on the slot | within a 16th | right pitch, other time | octave errors | key | tuning err |
|---|---|---|---|---|---|---|---|---|---|
| sung-a-minor | 90 | 17 | 17 | 17 | 17 | 0 | 0 | A minor | +0.8 |

