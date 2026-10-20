"""Woven Chaconne -- for string quartet.

An eight-bar ground in E minor (E D C B A C B E, one note per bar) and its
harmony: i, VII, VI, V, iv, iiø7/C, V7, i. The harmony never changes. Each
variation weaves the bar out of a different kind of interlocking rhythm.
Every figure is drawn from the bar's chord tones, so however the threads
cross, each onset belongs to the harmony of its bar.

    1-8    theme: a sarabande over the ground
    9-16   var. 1 (hemiola, 2:3): violin 1 in dotted quarters (6/8), violin
           2 in quarters (3/4), the viola in eighths sharing both; the
           cello's ground pulses in dotted halves split as 2+1
    17-24  var. 2 (3:4): violin 1 in triplet eighths, the viola in
           sixteenths beneath it, violin 2 holding the thirds
    25-32  var. 3 (hocket): one sixteenth-note line passed among violin 1,
           violin 2 and viola, a note each in turn. Each player gets every
           third sixteenth, a dotted-eighth pulse four against the bar's three
    33-40  var. 4 (interlocking canon): violin 2 shadows violin 1 a sixteenth
           behind and a chord tone lower; two lines of eighths that add up
           to one of sixteenths. The viola's syncopes fill the offbeats of
           the quarter
    41-48  var. 5 (additive): 3+3+2 eighths against the 3/4 bar. Violin 1
           accents the groups, violin 2 the same groups started two eighths
           later (2+3+3), the viola 3+2+3; the cycles of eight eighths line up
           with the bar only every four bars
    49-56  var. 6 (phasing): three ostinati in sixteenths, cycling every 5
           (violin 1), 7 (violin 2) and 8 (viola) against the bar's 12. None
           of them lines up with another until the variation ends
    57-64  var. 7 (2:3:4:5): quintuplet sixteenths, sixteenths, triplet
           eighths and dotted quarters all at once, tutti
    65-74  the theme again, the threads drawn together: everything in one
           rhythm, a hemiola into the cadence; the last chord in E major

    python -m badmidi examples/woven_chaconne.py grid --bars 25-26 --step s
    python -m badmidi examples/woven_chaconne.py lens --bars 33-40 --kinds parallel
    python -m badmidi examples/woven_chaconne.py grid --bars 57 --step s
"""
from fractions import Fraction as F
from itertools import cycle

from badmidi import *

K = key("E minor")
score = Score("Woven Chaconne", composer="badmidi", meter=(3, 4), key=K,
              tempo=69, tempo_text="Andante sostenuto")
vn1 = score.part("violin 1", "violin")
vn2 = score.part("violin 2", "violin")
vla = score.part("viola")
vc = score.part("cello")

# --- the ground and its harmony -------------------------------------------------------
ground = M("E3.hd | D3.hd | C3.hd | B2.hd | A2.hd | C3.hd | B2.hd | E2.hd |")
CHORDS = [("E", "G", "B"), ("D", "F#", "A"), ("C", "E", "G"), ("B", "D#", "F#"),
          ("A", "C", "E"), ("F#", "A", "C", "E"), ("B", "D#", "F#", "A"), ("E", "G", "B")]
BAR = 3                                             # quarters in a bar


def ladder(chord, lo):
    """Every pitch of the chord from lo up, bottom first."""
    lo = Pitch.parse(lo).midi
    out = [Pitch.parse(f"{n}{o}") for o in range(1, 8) for n in chord]
    return sorted(p for p in out if p.midi >= lo)


TUPLETS = {F(1, 3): (3, 2), F(1, 6): (3, 2), F(1, 5): (5, 4), F(2, 5): (5, 4)}


def weave(durs, steps, lo, bars=8, delay=0, accents=(), chords=CHORDS):
    """A thread through the harmony.

    durs (in quarters) and steps (rungs of the bar's chord ladder from lo
    up, None for a rest) cycle independently; each onset takes its pitch from
    the chord of the bar it falls in. accents lists the positions in the
    duration cycle that get an accent. delay starts the thread late.
    """
    total = F(bars * BAR)
    t = F(delay)
    out = [R * t] if t else []
    durs, steps = [F(d) for d in durs], list(steps)
    i = 0
    while t < total:
        d = min(durs[i % len(durs)], total - t)
        step = steps[i % len(steps)]
        tup = TUPLETS.get(d)
        if step is None:
            out.append(Note((), d, tuplet=tup))
        else:
            rungs = ladder(chords[int(t // BAR) % len(chords)], lo)
            art = ">" if i % len(durs) in accents else ""
            out.append(Note([rungs[step]], d, art=art, tuplet=tup))
        t += d
        i += 1
    return M(out)


# --- theme: sarabande -----------------------------------------------------------------
aria = M("B4.q E5.h | A4.q D5.h | G4.q C5.h | Fs4.q B4.h | "
         "C5.q E5.h | E5.q C5.q A4.q | Ds5.q Fs5.q A5.q | G5.hd |")
alto = M("G4.hd | Fs4.hd | E4.hd | Ds4.hd | E4.q A4.h | C5.q A4.q Fs4.q | "
         "B4.q A4.q Fs4.q | E4.hd |")
tenor = M("E4.q B3.h | D4.q A3.h | C4.q G3.h | B3.q Fs3.h | "
          "A3.q A3.h | A3.q E4.q C4.q | Fs3.q B3.q Ds4.q | B3.hd |")

# --- var. 1: hemiola ------------------------------------------------------------------
six_eight = weave([1.5], [6, 4, 5, 7], "E4", accents=(0,))
three_four = weave([1] * 3, [4, 3, 2], "B3", accents=(0,))
shared = weave([.5] * 6, [0, 2, 1, 3, 2, 1], "C3", accents=(0, 3))
pulsing = M(*(M(f"{n.pitch}.h {n.pitch}.q |") for n in ground.notes))

# --- var. 2: three against four -------------------------------------------------------
triplets = weave([F(1, 3)] * 3, [3, 4, 5, 6, 5, 4, 3, 2, 3], "E4", accents=(0,))
sixteenths = weave([.25], [0, 2, 1, 3], "C3")
thirds = M("G4.hd | Fs4.hd | G4.hd | Fs4.hd | E4.hd | E4.hd | Ds4.hd | E4.hd |")

# --- var. 3: hocket -------------------------------------------------------------------
LINE = [6, 7, 3, 5, 6, 2, 7, 8, 4, 6, 5, 3]     # one line, twelve sixteenths a bar: three strata
hocket = [weave([.25], [LINE[k] if k % 3 == j else None for k in range(12)], "B3")
          for j in range(3)]
for j, h in enumerate(hocket):
    hocket[j] = M([n if n.is_rest else n.articulate("'") for n in h.notes])

# --- var. 4: interlocking canon -------------------------------------------------------
CANON = [6, 4, 5, 3, 4, 2, 7, 5, 6, 4, 8, 7]
leader = weave([.5], CANON, "B3")
shadow = weave([.5], [s - 1 for s in CANON], "B3", delay=.25)
syncopes = weave([.5, 1, 1, .5], [None, 2, 3, 2], "C3")

# --- var. 5: additive -----------------------------------------------------------------
GROUPS = [.5] * 8
add_1 = weave(GROUPS, [6, 4, 5, 5, 3, 4, 7, 5], "E4", accents=(0, 3, 6))
add_2 = weave(GROUPS, [3, 4, 2, 3, 5, 3, 4, 2], "B3", accents=(2, 5, 0))
add_3 = weave(GROUPS, [1, 2, 3, 1, 2, 3, 2, 1], "C3", accents=(0, 3, 5))
add_cello = M(*(M(f"{n.pitch}.q> {n.pitch}.q {n.pitch}.q |") for n in ground.notes))

# --- var. 6: phasing ostinati ---------------------------------------------------------
phase_5 = weave([.5, .75], [7, 5], "E4", accents=(0,))
phase_7 = weave([.5, .5, .75], [4, 5, 3], "B3", accents=(0,))
phase_8 = weave([.75, .75, .5], [3, 1, 2], "C3", accents=(0,))

# --- var. 7: two, three, four, five ---------------------------------------------------
fives = weave([F(1, 5)] * 5, [5, 6, 7, 8, 9, 8, 7, 6, 7, 8], "E4", accents=(0,))
fours = weave([.25] * 4, [4, 5, 6, 5, 3, 4, 5, 4], "B3", accents=(0,))
threes = weave([F(1, 3)] * 3, [2, 3, 4, 3, 2, 1], "C3", accents=(0,))
twos = M(*(M(f"{n.pitch}.qd> {n.pitch.name[:-1]}{n.pitch.octave + 1}.qd |")
           for n in ground.notes))

# --- return: one rhythm, hemiola cadence -----------------------------------------------
aria_end = M("B4.q E5.h | A4.q D5.h | G4.q C5.h | Fs4.q B4.h | "
             "C5.q E5.h | E5.q C5.q A4.q | Ds5.h Fs5.h A5.h | Gs5.hd~ | Gs5.hd@ |")
alto_end = M("G4.q G4.h | Fs4.q Fs4.h | E4.q E4.h | Ds4.q Ds4.h | "
             "E4.q C4.h | C4.q A3.q C4.q | B3.h B3.h Ds4.h | B3.hd~ | B3.hd@ |")
tenor_end = M("E4.q B3.h | D4.q A3.h | C4.q G3.h | B3.q Fs3.h | "
              "C4.q A3.h | A3.q Fs3.q E3.q | Fs3.h A3.h Fs3.h | E4.hd~ | E4.hd@ |")
bass_end = M("E3.q E3.h | D3.q D3.h | C3.q C3.h | B2.q B2.h | "
             "A2.q A2.h | C3.q C3.q C3.q | B2.h B2.h B2.h | E2.hd~ | E2.hd@ |")

# --- placement ------------------------------------------------------------------------
vn1.at(1, aria, six_eight, triplets, hocket[0], leader, add_1, phase_5, fives,
       Bar(65), aria_end, Bar(75))
vn2.at(1, alto, three_four, thirds, hocket[1], shadow, add_2, phase_7, fours,
       Bar(65), alto_end, Bar(75))
vla.at(1, tenor, shared, sixteenths, hocket[2], syncopes, add_3, phase_8, threes,
       Bar(65), tenor_end, Bar(75))
vc.at(1, ground, pulsing, ground, ground, ground, add_cello, ground, twos,
      Bar(65), bass_end, Bar(75))

# --- shape ----------------------------------------------------------------------------
vn1.mark(1, "p", '"dolce"')
for p in (vn2, vla, vc):
    p.mark(1, "p")
for p in (vn1, vn2, vla, vc):
    p.mark(9, "mp")
    p.mark(17, "mf")
    p.mark(25, "p")
    p.mark(33, "mp")
    p.mark(41, "mf")
    p.mark(49, "p", "<")
    p.mark(57, "f")
    p.mark(65, "pp")
vn1.mark(25, '"spiccato"')
vn1.mark(49, '"each in its own cycle"')
vn1.mark(65, '"come prima"')
score.tempo_mark(25, "poco più mosso", 76)
score.tempo_mark(49, "a tempo", 69)
score.tempo_mark(65, "Tempo I", 63)
score.rit(70, 75, to=44)
