"""Ember Chaconne -- for string quartet.

A four-bar descending-tetrachord ground in D minor, varied eight times and
given a cinematic arc: a lone cello, slow accumulation, a lift into D major,
a full-voiced climax, and a Picardy close.

    1-4     cello alone: the ground
    5-8     viola enters in broken chords
    9-12    second violin adds eighth-note figuration
    13-16   first violin sings a long line over the full texture
    17-20   dotted-rhythm ground, the quartet in repeated chords
    21-24   lift: the ground in D major
    25-28   climax: sixteenth-note figuration over a leaping bass
    29-32   return to the minor, dissolving
    33      Picardy cadence
"""
from badmidi import *

K = key("D minor")
score = Score("Ember Chaconne", composer="badmidi", meter=(3, 4), key=K,
              tempo=60, tempo_text="Largo")
vn1 = score.part("violin", "violin")
vn2 = score.part("violin 2", "violin")
vla = score.part("viola")
vc = score.part("cello")

MINOR = [("D4", "F4", "A4"), ("C4", "E4", "G4"), ("Bb3", "D4", "F4"), ("A3", "Cs4", "E4")]
MAJOR = [("D4", "Fs4", "A4"), ("Cs4", "E4", "A4"), ("B3", "D4", "Fs4"), ("A3", "Cs4", "E4")]


def fig(order, dur, chords=MINOR, shift=0):
    """One bar per chord: the chord tones in `order`, at duration `dur`."""
    bars = []
    for c in chords:
        toks = [f"{c[i][:-1]}{int(c[i][-1]) + shift}.{dur}" for i in order]
        bars.append(" ".join(toks) + " |")
    return " ".join(bars)


REST4 = "R.hd | R.hd | R.hd | R.hd |"

# --- the ground ----------------------------------------------------------
ground = "D3.hd | C3.hd | Bb2.hd | A2.hd |"
dotted = "D3.qd D3.e D3.q | C3.qd C3.e C3.q | Bb2.qd Bb2.e Bb2.q | A2.qd A2.e A2.q |"
major = "D3.hd | Cs3.hd | B2.hd | A2.hd |"
leaping = "D3.q D4.q D3.q | C3.q C4.q C3.q | Bb2.q Bb3.q Bb2.q | A2.q A3.q A2.q |"
fading = "D3.hd | C3.hd | Bb2.hd | A2.hd |"

# --- cello: the ground throughout ----------------------------------------
vc.at(1, ground, ground, ground, ground, dotted, major, leaping, fading,
      "D3.hd@ |")

# --- viola ---------------------------------------------------------------
vla.at(1, REST4)
vla.at(5, fig([0, 1, 2], "q"))
vla.at(9, "F4.hd | E4.hd | D4.hd | Cs4.hd |")
vla.at(13, fig([0, 1, 2], "q"))
vla.at(17, "F3.hd | E3.hd | D3.hd | Cs3.hd |")
vla.at(21, fig([0, 1, 2], "q", MAJOR))
vla.at(25, fig([0, 1, 2, 1, 2, 1], "e"))
vla.at(29, "F4.hd | E4.hd | D4.hd | Cs4.hd |")
vla.at(33, "A3.hd@ |")

# --- second violin -------------------------------------------------------
vn2.at(1, REST4, REST4)
vn2.at(9, fig([0, 1, 2, 1, 2, 1], "e"))
vn2.at(13, "F4.hd | E4.hd | D4.hd | Cs4.hd |")
vn2.at(17, fig([2, 1, 0], "q"))
vn2.at(21, fig([0, 1, 2, 1, 2, 1], "e", MAJOR))
vn2.at(25, fig([0, 1, 2, 1, 2, 1], "e"))
vn2.at(29, "A4.hd | G4.hd | F4.hd | E4.hd |")
vn2.at(33, "Fs4.hd@ |")

# --- first violin: silent, then the tune ---------------------------------
vn1.at(1, REST4, REST4, REST4)
vn1.at(13, "F5.h E5.q | E5.h G5.q | D5.h F5.q | Cs5.q E5.q A5.q |")
vn1.at(17, "A5.qd G5.e F5.q | G5.qd F5.e E5.q | F5.qd E5.e D5.q | E5.h A5.q |")
vn1.at(21, "A5.h Fs5.q | A5.h E5.q | D5.h Fs5.q | E5.h A5.q |")
vn1.at(25, fig([0, 1, 2, 1] * 3, "s", shift=1))
vn1.at(29, "A5.h F5.q | G5.h E5.q | F5.h D5.q | E5.h Cs5.q |")
vn1.at(33, "D5.hd@ |")

# --- shape ---------------------------------------------------------------
vc.mark(1, "pp", '"sotto voce"')
vla.mark(5, "p")
vn2.mark(9, "mp")
vn1.mark(13, "mf", '"espressivo"')
vn1.mark(17, "f")
vn1.mark(21, "mp", '"luminoso"')
vn1.mark(25, "ff", "<")
vn1.mark(29, "mp", ">")
vn1.mark(32, "pp")
score.rit(31, 33, to=44)
