"""Chaconne in Mirrors -- for string quartet.

An eight-bar chromatic lament ground in D minor (D C# C B Bb G A A), heard
the right way up, upside down, backwards, and against itself. Every
variation is a different way of reading the same eight notes.

    1-8    theme: a sarabande chorale over the ground
    9-16   var. 1 (invention): two lines in double counterpoint over the
           ground. A (eighths) in violin 1, B (suspensions) in the viola
    17-24  var. 2 (inversion of the counterpoint): A drops to violin 2 and B
           climbs two octaves into violin 1, so B is now the top voice.
           The viola adds a third line in triplets, three against two
    25-32  var. 3 (the ground in the sky): violin 1 plays the ground three
           octaves up over a tonic pedal; the chorale's alto, an octave
           down, in the viola; violin 2 shimmers in sixteenths
    33-40  var. 4 (the ground inverted): mirrored around D it rises
           D Eb E F F# and the harmony drifts to G minor; sighing pairs in
           violin 2
    41-48  var. 5 (the ground in retrograde): backwards it climbs
           chromatically A G Bb B C C# D back to the tonic, in
           dotted-rhythm tutti
    49-56  var. 6 (mirror): the ground in the cello and its inversion in
           violin 1 at once. Their meeting points make a French sixth, an
           augmented triad and a V7b9
    57     general pause
    58-66  the chorale again, pianissimo, ending in D major

    python -m badmidi examples/mirror_chaconne.py grid --bars 49-56
    python -m badmidi examples/mirror_chaconne.py lens --bars 9-24
"""
from badmidi import *

K = key("D minor")
score = Score("Chaconne in Mirrors", composer="badmidi", meter=(3, 4), key=K,
              tempo=66, tempo_text="Grave")
vn1 = score.part("violin 1", "violin")
vn2 = score.part("violin 2", "violin")
vla = score.part("viola")
vc = score.part("cello")

# --- the ground, and its mirrors ---------------------------------------------------
GROUND = ["D3", "Cs3", "C3", "B2", "Bb2", "G2", "A2", "A2"]
ground = M(" ".join(f"{n}.hd |" for n in GROUND))
inverted = ground.invert(around=D3)                 # D Eb E F F# A G G
retro = ground.retrograde()                         # A A G Bb B C C# D


def figure(chords, order, dur, shift=0):
    """One bar per chord: its tones in `order`, at duration `dur`."""
    bars = []
    for c in chords:
        toks = [f"{c[i][:-1]}{int(c[i][-1]) + shift}.{dur}" for i in order]
        bars.append(" ".join(toks) + " |")
    return M(" ".join(bars))


def repeated(notes, dur="e", n=6):
    return M(" ".join(" ".join(f"{p}.{dur}" for _ in range(n)) + " |" for p in notes))


REST8 = M("R.hd |" * 8)

# harmony over the ground: i, V7/C#, V7/iv over C, V/B, iv/Bb, iiø7/G, V(4-3), V7
TONES = [("A3", "D4", "F4", "A4"), ("A3", "Cs4", "E4", "G4"), ("A3", "C4", "D4", "Fs4"),
         ("G3", "B3", "D4", "F4"), ("G3", "Bb3", "D4", "F4"), ("G3", "Bb3", "D4", "E4"),
         ("A3", "Cs4", "E4", "A4"), ("A3", "Cs4", "E4", "G4")]

# --- theme: chorale ------------------------------------------------------------------
soprano = M("F5.q A5.h | G5.q E5.h | Fs5.q A5.h | G5.q D5.h | D5.q G5.h | "
            "Bb5.q G5.q E5.q | D5.h Cs5.q | E5.q G5.h |")
alto = M("A4.hd~ | A4.h G4.q | Fs4.hd | G4.hd | G4.q Bb4.h | D5.hd | A4.hd | Cs5.hd |")
tenor = M("D4.hd | E4.hd | D4.hd | D4.q G3.h | G3.q D4.h | E4.hd | E4.hd | E4.q Cs4.h |")

# --- var. 1-2: double counterpoint ---------------------------------------------------
line_a = M("""
    F5.e E5.e D5.e A4.e D5.e F5.e  | E5.e Cs5.e A4.e Cs5.e A5.e G5.e |
    Fs5.e A5.e C6.e A5.e Fs5.e D5.e | B4.e D5.e G5.e F5.e D5.e F5.e  |
    D5.e Bb4.e G5.e A5.e Bb5.e G5.e | E5.e G5.e Bb5.e A5.e Bb5.e G5.e |
    D5.e E5.e F5.e E5.e D5.e Cs5.e | E5.e A4.e Cs5.e E5.e G5.e Cs6.e |
""")
line_b = M("A3.q D4.h~ | D4.q Cs4.q E4.q~ | E4.q D4.q A4.q~ | A4.q G4.h | "
           "G4.q F4.q D4.q | E4.h D4.q~ | D4.q Cs4.q E4.q | E4.q Cs4.q A3.q |")
line_c = figure(TONES, [0, 1, 2, 3, 2, 1, 0, 1, 2], "e3")

# --- var. 4: the inverted ground modulates to G minor --------------------------------
# i, bVI (Eb), C7/E, F, D7/F#, F#o7/A, iv/G, i of G minor (iv of D)
inv_tune = M("A5.h F5.q | Eb5.h G5.q | Bb5.h G5.q | A5.h C6.q | C6.h A5.q | "
             "C6.h Eb6.q | Eb6.q D6.q C6.q | Bb5.hd |")
sighs = M("""
    E4.e D4.e G4.e F4.e Bb4.e A4.e  | F4.e Eb4.e A4.e G4.e C5.e Bb4.e |
    F4.e E4.e A4.e G4.e C5.e Bb4.e  | G4.e F4.e Bb4.e A4.e D5.e C5.e  |
    G4.e Fs4.e Bb4.e A4.e D5.e C5.e | Bb4.e A4.e D5.e C5.e F5.e Eb5.e |
    D5.e C5.e F5.e Eb5.e A4.e G4.e  | A4.e G4.e C5.e Bb4.e E5.e D5.e  |
""")
inv_inner = M("F3.hd | Bb3.hd | Bb3.hd | A3.hd | A3.hd | Eb4.hd | Eb4.hd | D4.hd |")

# --- var. 5: the retrograde ground climbs back ---------------------------------------
# A, A7, A7/G, Bb, G7/B, C, A7/C#, i
over1 = M("E5.qd E5.e A5.q | G5.qd G5.e E5.q | A5.qd A5.e E5.q | Bb5.qd Bb5.e F5.q | "
          "D6.qd D6.e G5.q | E6.qd E6.e C6.q | E6.qd E6.e A5.q | F6.qd F6.e D6.q |")
over2 = M("Cs5.qd Cs5.e E5.q | E5.qd E5.e Cs5.q | E5.qd E5.e Cs5.q | D5.qd D5.e Bb4.q | "
          "F5.qd F5.e D5.q | E5.qd E5.e G5.q | G5.qd G5.e E5.q | A5.qd A5.e F5.q |")
over3 = M("A4.qd A4.e A4.q | A4.qd A4.e A4.q | A4.qd A4.e A4.q | F4.qd F4.e F4.q | "
          "G4.qd G4.e G4.q | G4.qd G4.e G4.q | A4.qd A4.e A4.q | D4.qd D4.e D4.q |")

# --- var. 6: the ground against its own inversion ------------------------------------
# i, Fr+6 (Eb G A C#) over C#, C7, G7/B, Bb+, A7/G, A7, A7b9
MIRROR = [("A3", "D4", "F4", "A4"), ("A3", "Cs4", "Eb4", "G4"), ("G3", "Bb3", "C4", "E4"),
          ("G3", "B3", "D4", "F4"), ("Bb3", "D4", "Fs4", "Bb4"), ("G3", "A3", "Cs4", "E4"),
          ("A3", "Cs4", "E4", "G4"), ("A3", "Cs4", "E4", "G4")]
DYADS = ["D5 A5", "Cs5 G5", "Bb4 E5", "B4 F5", "Bb4 D5", "Cs5 E5", "Cs5 E5", "Cs5 E5"]
pulse = M(" ".join(f"R.e [{d}].e R.e [{d}].e R.e [{d}].e |" for d in DYADS))
sky_mirror = inverted.octave(3).unbarred()

# --- placement -----------------------------------------------------------------------
vc.at(1, ground, ground, ground, M("D2.hd~ |" * 6, "A2.hd~ | A2.hd |"),
      inverted.octave(0), repeated([n.pitch for n in retro.notes]),
      repeated(GROUND), "R.hd@ |", ground, "D3.hd@ |", Bar(67))

vla.at(1, tenor, line_b, line_c, alto.octave(-1), inv_inner, over3,
       figure(MIRROR, [1, 2, 3, 2, 1, 0] * 2, "s"), "R.hd@ |",
       tenor, "D4.hd@ |", Bar(67))
vn2.at(1, alto, REST8, line_a, figure(TONES, [1, 2, 3, 2, 1, 0] * 2, "s", shift=1),
       sighs, over2, pulse, "R.hd@ |", alto, "A4.hd@ |", Bar(67))
vn1.at(1, soprano, line_a, line_b.octave(2), ground.octave(3), inv_tune, over1,
       M(sky_mirror, Bar(57)), "R.hd@ |", soprano, "Fs5.hd@ |", Bar(67))

# --- shape ---------------------------------------------------------------------------
vn1.mark(1, "p", '"dolce"')
vn2.mark(1, "p"); vla.mark(1, "p"); vc.mark(1, "p")
vn1.mark(9, "mp"); vla.mark(9, "mp"); vc.mark(9, "mp")
vn1.mark(17, "mf"); vn2.mark(17, "mf"); vla.mark(17, "mp")
for p in (vn1, vn2, vla, vc):
    p.mark(25, "pp")
vn1.mark(25, '"flautando"')
for p in (vn1, vn2, vla, vc):
    p.mark(33, "mp")
    p.mark(41, "p", "<")
    p.mark(49, "ff")
    p.mark(58, "pp")
vn1.mark(58, '"come prima"')
score.tempo_mark(25, "poco meno mosso", 58)
score.tempo_mark(33, "a tempo", 66)
score.accel(41, 49, to=76)
score.tempo_mark(58, "Tempo I", 60)
score.rit(64, 67, to=42)
