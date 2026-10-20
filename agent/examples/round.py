"""Frère Jacques as a four-voice round, plus a cello playing the tune in
augmentation (twice as slow) underneath.

Shows: one motif placed at staggered anchors, barlines checked inside a
reusable motif, and a transformed copy (augment + octave) as a canon voice.
"""
from badmidi import *

tune = M("""
    F4.q G4.q A4.q F4.q             | F4.q G4.q A4.q F4.q             |
    A4.q Bb4.q C5.h                 | A4.q Bb4.q C5.h                 |
    C5.e D5.e C5.e Bb4.e A4.q F4.q  | C5.e D5.e C5.e Bb4.e A4.q F4.q  |
    F4.q C4.q F4.h                  | F4.q C4.q F4.h                  |
""")

score = Score("Round", meter=(4, 4), tempo=112, key="F major")
voices = [
    score.part("flute"),
    score.part("oboe"),
    score.part("clarinet"),
    score.part("bassoon"),
]
for i, voice in enumerate(voices):
    line = tune.octave(-1) if voice.instrument == "bassoon" else tune
    voice.at(1 + 2 * i, line * 2)            # entries at bars 1, 3, 5, 7

score.part("cello").at(7, tune.augment(2).octave(-2), Bar(23))
