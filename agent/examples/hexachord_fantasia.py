"""Fantasia on Ut re mi fa sol la -- for free-bass accordion.

After Bull's and Sweelinck's hexachord fantasias. The six notes of the
hexachord naturale, C D E F G A, have a complement that is itself a
hexachord: F# G# A# B C# D#, the same six steps a tritone higher. Together
they make all twelve notes. The piece sets the two against each other:
renaissance modal counterpoint on one, a "wrong" answer at the tritone on
the other, and lets them meet.

    1-8    Intonatio: the hexachord as a cantus firmus in the left hand;
           above it a canon at the seventh below over a rising sequence;
           "fa super la" (Bb over A) at the half cadence, Picardy D major
    9-22   Ricercar: the subject on C, answered at the tritone on F#. A
           subject and its answer differ by exactly a tritone, so one
           countersubject fits both, and inverts at the octave; the
           crossings make augmented triads and enharmonic consonances.
           Stretto with the subject al rovescio
    23-34  Divisions on a ground: the hexachord falling through an octave
           (A G F E D C Bb A, the Phrygian close), harmonized in
           fauxbourdon. Each statement halves the note values
    35-42  Passus duriusculus: Sweelinck's chromatic fourth in stretto,
           the two hexachords in parallel tritones, bellows shake at the
           climax
    43-50  Cantus firmus in augmentation in the bass; the canon returns;
           D major, al niente

Free bass: the left hand plays single notes, so it carries lines (the
cantus firmus, the ground, fugue entries) rather than stock chords. There
is no sustain pedal; a note lasts while it's held. The registers are the
accordion's reed ranks (L = 16', M = 8', H = 4'); they print as
registration marks and play back as a reed organ.

    badmidi examples/hexachord_fantasia.py grid --bars 9-22     # augmented triads, (048)
    badmidi examples/hexachord_fantasia.py lens --bars 1-8      # the canon's passing notes and suspensions
    badmidi examples/hexachord_fantasia.py pdf
"""
from badmidi import *

Dm = key("D minor")
F = key("F major")
score = Score("Fantasia on Ut re mi fa sol la", composer="badmidi", meter=(4, 4), key=Dm,
              tempo=56, tempo_text="Lento, come un organo positivo")

ACC = dict(group="Accordion")
rh = score.part("rh", "reed organ", clef="treble", range=(E3, A6), **ACC)
alto = score.part("alto", "reed organ", staff="rh", range=(E3, A6), **ACC)
lh = score.part("lh", "reed organ", clef="bass", range=(E1, Cs5), **ACC)
bass = score.part("bass", "reed organ", staff="lh", range=(E1, Cs5), **ACC)
rh.balance = 6

# --- the material --------------------------------------------------------------

ut_re_mi = M("C3.w D3.w E3.w F3.w G3.w A3.w")             # hexachord naturale
complement = ut_re_mi.transpose(6)                         # F# G# A# B C# D#

# I. a line over the rising-third sequence; the harmony of each bar is the
# previous bar's a step higher, so the line answers itself in canon one bar
# later, a step up and an octave down: a canon at the seventh below.
soggetto = M("E5.h F5.q E5.e D5.e | D5.qd C5.e Bb4.q E5.q | G5.q F5.e E5.e A5.h | F5.qd E5.e D5.h |")
canon_7 = soggetto.transpose(1, scale=F).octave(-1)

# II. subject on C, answer on F#; the countersubject fits both
subject = M("C3.h G3.q A3.q | F3.qd E3.e D3.e E3.e C3.q |")
answer = subject.transpose(6)                                    # F# C# D# | B A# G# A# F#
counter = M("D3.q E3.q A2.q G2.q~ | G2.q D3.q E3.q D3.q |")
counter_on_Fs = counter.transpose(6)
rovescio = subject.octave(1).invert(around=A4).transpose(-9)     # C<->A, D<->G, E<->F


# --- I. Intonatio ----------------------------------------------------------------

lh.at(1, ut_re_mi, "Bb3.h A3.h | A3.w@ |9")
bass.at(1, "A1.h F1.h | Bb1.h G1.h | C2.h A1.h | D2.h Bb1.h | E2.h C2.h | F2.h D2.h |",
        "G2.h A2.h | D2.w@ |9")
rh.at(1, soggetto, "E5.h G5.q E5.q | F5.q A5.e G5.e Fs5.h | G5.q F5.e G5.e E5.h | Fs5.w@ |9")
alto.at(2, canon_7, "A4.h A4.q B4.q | D5.h Cs5.h | D5.w@ |9")

# --- II. Ricercar -----------------------------------------------------------------

lh.at(9, subject, counter, "E3.h B2.h | As2.h Fs2.h |", answer, Bar(17))
alto.at(11, answer.octave(1), counter_on_Fs.octave(1), Bar(15))
rh.at(13, subject.octave(2), counter.octave(2), Bar(17))

# stretto: subject, answer half a bar behind, the subject inverted a bar behind
rh.at(17, subject.octave(2), "Gs4.q A4.q B4.h | A4.h Bb4.h | D5.w | Cs5.w@ |23")
bass.at(17, answer.octave(-1), "E2.h | Fs2.h G2.h | Bb1.w | A1.w@ |23", beat=3)
lh.at(17, "A3.h", counter.octave(1), "G3.h | A3.h G3.h | D3.w | E3.w@ |23")
alto.at(18, rovescio, "D4.w | G4.w | A4.w@ |23")

# --- III. Divisions on a ground ---------------------------------------------------
# The hexachord falling through an octave to the Phrygian close (fa super la
# again, Bb to A), one harmony per half bar in fauxbourdon: the tenor in
# tenths over the ground.

ground = M("A2.h G2.h | F2.h E2.h | D2.h C2.h | Bb1.h A1.h |")
tenths = M("C4.h B3.h | A3.h Gs3.h | F3.h E3.h | D3.h Cs3.h |")
GROUND_CHORDS = [(A3, C4, E4), (G3, B3, E4), (F3, A3, D4), (E3, Gs3, B3),
                 (D3, F3, A3), (C3, E3, A3), (Bb2, D3, G3), (A2, Cs3, E3)]


def division(chord):
    """Free-bass sixteenths through one harmony: up, over the top, and back."""
    a, b, c = chord
    return M(*(p.s for p in (a, b, c, a + 12, c, b, a + 12, c)))


pavana = M("E5.q A4.q B4.q E5.q | F5.q A4.q B4.q Gs4.q | F5.q D5.q E5.q C5.q | D5.q Bb4.q Cs5.h |")
diminution = M("""
    E5.e A5.e G5.e E5.e  B4.e E5.e G5.e E5.e  | F5.e D5.e A4.e D5.e  Gs4.e B4.e E5.e B4.e |
    D5.e F5.e A5.e F5.e  A5.e E5.e C6.e A5.e  | G5.e D5.e Bb4.e E5.e Cs5.e E5.e A5.e E5.e |
""")
fauxbourdon = M("""
    [E5 A5 C6].h [E5 G5 B5].h | [D5 F5 A5].h [D5 Gs5 B5].h |
    [F5 A5 D6].h [E5 A5 E6].h | [D5 G5 D6].h [E5 A5 Cs6].h |
""")

bass.at(23, ground * 3, Bar(35))
lh.at(23, tenths * 2, *(division(c) for c in GROUND_CHORDS), Bar(35))
rh.at(23, pavana, diminution, fauxbourdon, Bar(35))

# --- IV. Passus duriusculus ----------------------------------------------------------
# Lay the two hexachords side by side and every pair is a tritone: C/F#, D/G#,
# E/A#, F/B, G/C#, A/D#. The right hand runs them in parallel over the
# chromatic fourth in stretto, which falls on to the dominant. At the climax
# a triad from each hexachord, C major and F# major, sounds at once.

def tritones(octave, down=False):
    """The two hexachords side by side, in eighth-note triplets."""
    lo, hi = ut_re_mi.octave(octave - 3).pitches, complement.octave(octave - 3).pitches
    pairs = [(a & b).e3 for a, b in zip(lo, hi)]
    return M(*(pairs[::-1] if down else pairs))


up4, down4, up5, down5 = tritones(4), tritones(4, True), tritones(5), tritones(5, True)
passus = M("D4.h Cs4.h | C4.h B3.h | Bb3.h A3.h |")
petrushka = "[C5 E5 Fs5 G5 As5 Cs6]"

rh.at(35, up4, down4, "|", up4, down4, "|", up4, up5, "|", down5, down4, "|",
      up5, down5, "|", up4, up5, "|",
      " ".join([f"{petrushka}.s>", f"{petrushka}.s"] * 8), "|",
      f"{petrushka}.h [Cs5 E5 G5 A5].h@ |43")
lh.at(35, passus, "Gs3.h G3.h | Fs3.h F3.h | E3.w | E3.h Eb3.h | D3.h Cs3.h@ |43")
bass.at(36, passus.transpose(-5).octave(-1), "Eb2.h D2.h | Cs2.h C2.h | B1.h Bb1.h | A1.w@ |43")

# --- V. Cantus firmus in the bass ----------------------------------------------------
# The Intonatio again with its voices exchanged: the hexachord in the bass,
# the old bass line in the tenor, the canon unchanged above them.

bass.at(43, ut_re_mi.octave(-1), "Bb2.h A2.h | D2.w@ |51")
lh.at(43, "A3.h F3.h | Bb3.h G3.h | C4.h A3.h | D4.h Bb3.h | E4.h C4.h | F4.h D4.h |",
      "G3.h A3.h | A3.w@ |51")
rh.at(43, soggetto, "E5.h G5.q E5.q | F5.q A5.e G5.e Fs5.h | G5.q F5.e G5.e E5.h | Fs5.w@ |51")
alto.at(44, canon_7, "A4.h A4.q B4.q | D5.h Cs5.h | D5.w@ |51")

# --- registration, dynamics, tempo -------------------------------------------------------

rh.registration(1, "M (8')")
lh.registration(1, "Free bass: L M (16' 8')")
rh.registration(23, "M H (8' 4')")
rh.registration(35, "L M H (16' 8' 4')")
rh.registration(43, "M (8')")
lh.registration(43, "Free bass: L (16')")

rh.mark(1, "pp", '"legato, senza vibrato"')
rh.mark(3, "<")
rh.mark(5, "mp")
rh.mark(6, "<")
rh.mark(7, "mf", ">")
rh.mark(8, "p")
rh.mark(9, '"ben articolato"')
rh.mark(13, "mp")
rh.mark(15, "mf")
rh.mark(17, "f")
rh.mark(19, ">", beat=3)
rh.mark(21, "mp")
rh.mark(23, "mp", '"dolce"')
rh.mark(27, "mf")
rh.mark(31, "f", '"il basso cantando"')
rh.mark(33, ">", beat=3)
rh.mark(34, "mp")
rh.mark(35, "p", '"inquieto"')
rh.mark(36, "<")
rh.mark(39, "f")
rh.mark(40, "<")
rh.mark(41, "fff", '"bellows shake"')
rh.mark(42, ">")
rh.mark(43, "pp")
rh.mark(46, "<")
rh.mark(48, "mp")
rh.mark(49, ">")
rh.mark(50, "ppp", '"al niente"')

score.tempo_mark(9, "Ricercar. Andante grave", 66)
score.rit(21, 22, to=52)
score.tempo_mark(23, "Divisioni sopra il basso", 72)
score.tempo_mark(35, "Più mosso, inquieto", 84)
score.accel(39, 41, to=96)
score.tempo_mark(43, "Tempo I", 56)
score.rit(49, 51, to=44)
