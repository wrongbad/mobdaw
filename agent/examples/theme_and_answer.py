"""Theme and Answer -- a short string-quartet sketch built from one 4-note idea.

  bars 1-4   theme, answered by its inversion, lifted a third, half cadence
  bars 5-6   the theme moves to the cello; the answer to the viola
  bars 7-10  the head of the theme, augmented, sequenced down the scale
  bars 11-13 theme in octaves, then its retrograde as the cadence; Picardy third

Ideas are Python values developed by transformation; accompaniment is
written directly in string notation. The two mix freely in .at().
"""
from badmidi import *

Em = key("E minor")

theme = M("E4.q G4.e A4.e B4.h")
answer = theme.invert(around=A4).transpose(5)          # G5 E5 D5 C5
lift = theme.transpose(2, scale=Em)                     # G4 B4 C5 D5
half_cadence = M("A4.q G4.e Fs4.e Ds4.h")
bridge = theme.fragment(0, 3).augment(2).octave(1).sequence([-1, -1], scale=Em)
coda = theme.retrograde().octave(1)                     # B5 A5 G5 E5

score = Score("Theme and Answer", meter=(4, 4), tempo=72, key=Em)
vln1 = score.part("violin1", "violin")
vln2 = score.part("violin2", "violin")
vla = score.part("viola")
vc = score.part("cello")

# --- A: statement --------------------------------------------------------------
vln1.at(1, theme, answer, lift, half_cadence, Bar(5))
vln2.at(1, "B3.w  | E4.w | D4.w | B3.w  |5")
vla.at(1,  "G3.w  | G3.w | G3.w | Fs3.w |5")
vc.at(1,   "E3.w  | C3.w | B2.w | B2.w  |5")

# --- B: the theme goes down to the cello, the answer to the viola -------------
vln1.at(5, "B4.w | C5.w |7")
vln2.at(5, "G4.w | G4.w |7")
vla.at(5, "E4.w |", answer.octave(-1), Bar(7))
vc.at(5, theme.octave(-1), "| C3.w |7")

# --- C: sequence ---------------------------------------------------------------
vln1.at(7, bridge, "| Fs5.h Ds5.h |11")
vln2.at(7, "B4.w | A4.w  | A4.w | A4.w |11")
vla.at(7,  "G4.w | Fs4.w | E4.w | B3.w |11")
vc.at(7,   "E2.w | D3.w  | A2.w | B2.w |11")

# --- D: return and cadence -----------------------------------------------------
vln1.at(11, theme.octave(1), "|", coda, "| E5.w")
vln2.at(11, "B4.w |", "A4.hd G4.q  | Gs4.w")
vla.at(11,  "G4.w |", "Ds4.hd E4.q | B3.w")
vc.at(11, theme.octave(-1), "| B2.hd E3.q | E2.w")
