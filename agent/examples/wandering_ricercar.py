"""Ricercar on Wandering Finals -- for clarinet, tenor sax and baritone sax.

Renaissance habits throughout: points of imitation, parallel 6-3 chords,
cross relations, a Phrygian cadence. Almost every sonority is a triad or an
open interval, but the mode never settles. The collection moves and the
final moves with it, so there is never a tonic to come home to. The rhythm
never settles either. Written at concert pitch.

    1-8    3+3+2/8. Exposition on a D dorian subject: clarinet; tenor a
           fifth below in G dorian (Bb against the clarinet's B); baritone
    9-14   the subject in Bb lydian (clarinet), then a stretto in the
           baritone two and a half bars later, entering on the 7th eighth.
           A cross relation (B against Bb) and a Phrygian-ish rise E F G A
           to an A major chord
    15-26  7/8 (3+2+2, the melody often phrased 2+3+2). Fauxbourdon: one
           melody in parallel 6-3 chords, the middle voice
           a perfect fourth down in its own mode, the baritone an eighth late so
           every step makes a suspension. The same tune in A mixolydian,
           C lydian, E phrygian
    27-34  6/4 galliard on chords a major third apart (E C Ab E, Am F Db A):
           baritone in 3/2 halves, tenor on the off-halves, clarinet in 6/4
    35-42  the galliard again, the tune in the tenor, roles swapped
    43-50  3+3+2/8. The subject in E phrygian: tenor; baritone in
           augmentation as a cantus firmus across the barlines; clarinet in
           stretto on the 7th eighth. Phrygian cadence F -> E: it ends on
           E major, which sounds like a half cadence in A

    python -m badmidi examples/wandering_ricercar.py grid --bars 9-14
    python -m badmidi examples/wandering_ricercar.py lens --bars 15-18
    python -m badmidi examples/wandering_ricercar.py grid --bars 27-30
"""
from badmidi import *

score = Score("Ricercar on Wandering Finals", composer="badmidi", meter="3+3+2/8",
              key="C major", tempo=76, tempo_text="Flowing, with lilt")
cl = score.part("clarinet")
ten = score.part("tenor sax", "bassoon", program=66, range=(Ab2, E5), clef='"treble_8"')
bari = score.part("baritone sax", "bassoon", program=67, range=(A1, Ab4), clef="bass")

# --- the subject ----------------------------------------------------------------------

subject = M("D4.qd A4.qd G4.q | F4.e E4.e D4.e E4.qd C4.q | D4.q E4.e F4.qd G4.q |")
in_bb_lydian = subject.transpose(-2, scale=key("F major"))         # Bb F E D C ...
in_e_phrygian = subject.transpose(1, scale=key("C major"))         # E B A G F ...

# --- I. exposition: 1-14 ----------------------------------------------------------------

cl.at(1, subject.octave(1), """
    G5.e F5.e D5.e C5.qd A4.q               |
    R.e Bb4.e C5.e D5.qd E5.q               |
    A4.q D5.e C5.qd B4.q                    |
    R.e C5.e D5.e~ D5.e C5.e B4.e C5.e E5.e |
    D5.q B4.e A4.qd B4.q                    |9
""", in_bb_lydian.octave(1), """
    E5.e F5.qd C5.q B4.e A4.e |
    G5.e A5.qd F5.q Gs5.q     |
    A5.e G5.qd E5.h           |15
""")
ten.at(3, subject.transpose(-7).octave(1), """
    F4.qd C4.qd D4.q      |
    A3.qd G3.qd E3.q      |
    A3.q G3.e A3.qd D4.q  |9
    D4.qd F4.qd G4.q      |
    D4.qd C4.qd F4.q      |
    R.q F4.qd~ F4.e G4.q  |
    G4.e D4.qd C4.q D4.q  |
    C4.e A3.qd F4.q E4.q  |
    C4.e B3.qd Cs4.h      |15
""")
bari.at(6, subject.octave(-1),
        "Bb2.qd D3.qd C3.q | G2.qd A2.qd D3.q | G2.q A2.e Bb2.qd")
bari.at(11, in_bb_lydian.transpose(-11, scale=key("F major")).octave(1), "A2.q |15", beat=7)

# --- II. fauxbourdon: 15-26 ---------------------------------------------------------------

TUNE = [4, 3, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 2, 3, 4]               # scale degrees above the final
TUNE_RHYTHM = [1.5, 1, 1,  .5, .5, .5, 1, 1,  1, 1.5, 1,  .5, .5, .5, 2]   # 3+2+2, 3+2+2, 2+3+2, 3+4


def degrees(final, mode, steps, rhythm):
    K = key(f"{final[:-1]} {mode}")
    return M(*(M(f"{final}.q").transpose(d, scale=K) for d in steps)).rhythm(*rhythm)


def fauxbourdon(final, mode):
    """The tune on top; a perfect fourth below it, so the middle voice is in
    the mode a fourth away (A mixolydian over E mixolydian, G against G#); a
    diatonic sixth (+ an octave) below the tune, the bass an eighth late.
    It closes on the open octave-fifth."""
    top = degrees(final, mode, TUNE, TUNE_RHYTHM)
    mid = top.transpose(-5)
    low_steps = [d - 12 for d in TUNE[:-1]] + [TUNE[-1] - 14]
    low = M("R.e", degrees(final, mode, low_steps, TUNE_RHYTHM[:-1] + [1.5]))
    return top, mid, low


score.meter_change(15, "3+2+2/8")
for bar, (final, mode) in zip((15, 19, 23), [("A4", "mixolydian"), ("C4", "lydian"),
                                              ("E4", "phrygian")]):
    top, mid, low = fauxbourdon(final, mode)
    cl.at(bar, top, Bar(bar + 4))
    ten.at(bar, mid, Bar(bar + 4))
    bari.at(bar, low, Bar(bar + 4))

# --- III. galliard on mediants: 27-42 --------------------------------------------------

# chords a major third apart: (bass root, fifth), the tenor's three chord tones
CHORDS = [("E2", "B2", "E3", "Gs3 B3 E4"), ("C3", "G2", "C3", "G3 C4 E4"),
          ("Ab2", "Eb3", "Ab2", "Ab3 C4 Eb4"), ("E2", "B2", "E3", "Gs3 B3 E4"),
          ("A2", "E3", "A2", "A3 C4 E4"), ("F2", "C3", "F2", "A3 C4 F4"),
          ("Db3", "Ab2", "Db3", "Ab3 Db4 F4"), ("A2", "E3", "A2", "A3 Cs4 A3")]
galliard_tune = M("""
    B4.q E5.h Gs5.q B5.q Gs5.q  |  G5.hd E5.q C5.q D5.q  |
    Eb5.q C5.h Db5.q Eb5.h      |  Gs5.h Fs5.q E5.h B4.q |
    C5.q E5.h A5.q G5.q E5.q    |  F5.hd A5.q G5.q F5.q  |
    Ab5.q F5.h Eb5.q Db5.h      |  Cs5.hd B4.q Cs5.q E5.q |
""")
halves = M(*(M(f"{a}.h {b}.h {c}.h |") for a, b, c, _ in CHORDS))          # 3/2 against 6/4
dotted = M(*(M(f"{a}.hd {b}.hd |") for a, b, _, _ in CHORDS))
offbeats = M(*(M("R.q {}.h {}.h {}.q |".format(*t.split())) for *_, t in CHORDS))

score.meter_change(27, "6/4")
cl.at(27, galliard_tune, offbeats.octave(1), Bar(43))
ten.at(27, offbeats, galliard_tune.octave(-1), Bar(43))
bari.at(27, halves, dotted, Bar(43))

# --- IV. cantus firmus and Phrygian close: 43-50 ------------------------------------------

score.meter_change(43, "3+3+2/8")
ten.at(43, in_e_phrygian, """
    A4.e D4.qd F4.h       |
    C4.h A3.q B3.q        |
    B3.h Cs4.q D4.q       |
    D4.qd C4.qd A3.q      |
    Gs3.w@                |51
""")
bari.at(43, in_e_phrygian.octave(-2).augment(2), "F2.w | E2.w@ |51")
cl.at(43, "R.e B4.e E5.e G5.qd D5.q | D5.qd D5.e C5.q F5.q | B4.q D5.qd B4.e")
cl.at(45, in_e_phrygian.octave(1), "E5.q | F5.qd E5.e D5.h | E5.w@ |51", beat=7)

# --- markings, tempo ----------------------------------------------------------------------

cl.mark(1, "mp", '"dolce"')
ten.mark(3, "mp")
bari.mark(6, "mp")
cl.mark(9, "mf")
bari.mark(11, "mf", beat=7)
for p in (cl, ten, bari):
    p.mark(15, "p", '"legato"')
    p.mark(19, "mp")
    p.mark(23, "p")
    p.mark(27, "f")
cl.mark(27, '"leggiero, ben ritmico"')
for p in (cl, ten, bari):
    p.mark(35, "mf")
cl.mark(43, "mp")
ten.mark(43, "mf")
bari.mark(43, "mf", '"sostenuto"')
for p in (cl, ten, bari):
    p.mark(49, ">")
    p.mark(50, "pp")

score.tempo_mark(15, "Più tranquillo", 66)
score.tempo_mark(27, "Gagliarda", 144)
score.tempo_mark(43, "Tempo I", 76)
score.rit(48, 50, to=56)
