"""Phase study -- for two marimbas.

A twelve-note cell in 12/16, played in unison, then slipping apart by one
sixteenth at a time: each slip is a bar where the second marimba plays the
cell twelve-in-eleven (a 12:11 tuplet) and lands one note ahead; then four
bars at the new offset. Twelve slips bring it back round to unison.

    1-8     A  unison, x8
    9-68    B  twelve blocks of a slip bar and four bars (x4) at the new offset
    69-76   C  both parts a fifth higher, x8
    77-93   D  back in the first key, written in unison throughout: the second marimba's
               playback drifts three sixteenths ahead (bars 77-84) and back (85-92),
               the way a loop on tape would; the last bar lands together

    badmidi examples/phase_study.py form      the shape of it
    badmidi examples/phase_study.py lens      collapsed: only the changes are listed
    badmidi examples/phase_study.py check     notes which loops are engraved as repeats, and the drift
    badmidi examples/phase_study.py midi      D is only audible in the MIDI/wav: the page shows unison
"""
from fractions import Fraction

from badmidi import *

score = Score("Phase study", composer="badmidi", meter=(12, 16), tempo=76, key="E major",
              tempo_text="Steady")
m1 = score.part("m1", "marimba")
m2 = score.part("m2", "marimba")

cell = M("E4.s Fs4.s B4.s Cs5.s D5.s Fs4.s E4.s Cs5.s B4.s Fs4.s D5.s Cs5.s |")


def rotated(k):
    """The cell started k notes in."""
    return cell.rotate(k).rebar("12/16")


def slip(k):
    """One bar: the rotated cell squeezed twelve notes into eleven sixteenths,
    then the note after it, so the next bar starts one note further on."""
    r = rotated(k)
    return M(r.unbarred().diminish(Fraction(12, 11)), r.notes[0], "|")


# A: in unison
for p in (m1, m2):
    p.loop(1, cell, times=8)

# B: the second marimba slips ahead; the first never moves
bar = 9
for k in range(12):
    m1.at(bar, cell)
    m2.at(bar, slip(k))
    m1.loop(bar + 1, cell, times=4)
    m2.loop(bar + 1, rotated(k + 1), times=4)
    bar += 5

# C: a fifth higher, in unison
up = cell.transpose(7)
for p in (m1, m2):
    p.loop(bar, up, times=8)
assert bar == 69

# D: in unison on the page; in the playback the second marimba gets ahead and returns
for p in (m1, m2):
    p.loop(77, cell, times=16)
    p.at(93, "B4.hd |")
m2.drift(77, 85, ahead=Fraction(3, 4), text="gradually ahead, up to 3/16")
m2.drift(85, 93, ahead=-Fraction(3, 4), text="gradually back to unison")

score.section(1, "A", "in unison")
score.section(9, "B", "the second marimba slips one sixteenth per block")
score.section(69, "C", "a fifth higher")
score.section(77, "D", "unison on the page; the second marimba drifts ahead and back")

for p in (m1, m2):
    p.mark(1, "p")
    p.mark(9, "mp", "<")
    p.mark(49, "f", ">")
    p.mark(64, "p")
    p.mark(69, "mf")
    p.mark(93, "pp")
