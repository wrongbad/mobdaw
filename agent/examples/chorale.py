"""A short four-part chorale in G major, written to be read in the grid view:

    badmidi examples/chorale.py grid

Phrase 1 ends on a half cadence (I64-V), phrase 2 answers with the same
cadence figure resolved to a perfect authentic cadence (I64-V7-I).
Bar 3 is outer voices in parallel tenths over a rising bass.

Each "|" is a checked barline and "|5" asserts the start of bar 5:
`badmidi check` errors if one doesn't land where it says, so a miscounted
bar can't silently shift the rest. Whitespace is free, so the voices can be
lined up bar by bar, the same way the melody view prints them.
"""
from badmidi import *

score = Score("Chorale", meter=(4, 4), tempo=66, key="G major")
s = score.part("soprano")
a = score.part("alto")
t = score.part("tenor")
b = score.part("bass")

# phrase 1: half cadence
s.at(1, "D5.q B4.q C5.q A4.q  | B4.q G4.q A4.h  | B4.q C5.q D5.q E5.q | C5.q B4.q A4.h  |5")
a.at(1, "G4.q G4.q G4.q Fs4.q | G4.q E4.q Fs4.h | G4.q E4.q G4.q G4.q | A4.q G4.q Fs4.h |5")
t.at(1, "B3.q B3.q E4.q D4.q  | D4.q B3.q D4.h  | D4.q A3.q D4.q C4.q | E4.q D4.q D4.h  |5")
b.at(1, "G2.q E3.q C3.q D3.q  | G2.q E3.q D3.h  | G2.q A2.q B2.q C3.q | A2.q D3.q D3.h  |5")

# phrase 2: authentic cadence
s.at(5, "B4.q C5.q D5.q B4.q | C5.q B4.q A4.q G4.q  | C5.q B4.q A4.h  | G4.w |9")
a.at(5, "G4.q G4.q G4.q G4.q | G4.q G4.q Fs4.q E4.q | E4.q D4.q C4.h  | B3.w |9")
t.at(5, "D4.q E4.q D4.q E4.q | E4.q D4.q D4.q B3.q  | C4.q G3.q Fs3.h | G3.w |9")
b.at(5, "G2.q C3.q B2.q E3.q | C3.q G2.q D3.q E3.q  | C3.q D3.q D3.h  | G2.w |9")
