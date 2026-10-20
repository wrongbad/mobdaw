"""Chaconne with Bent Rules -- for violin and two cellos.

A baroque chaconne in D minor on the lament ground (D C Bb A G Bb A D, one
note per bar), in the sarabande rhythm with the weight on beat 2. It starts
out strict, then each variation bends one rule of the form while the ground
keeps going underneath.

    1-8    theme: sarabande chords, the ground in cello 2
    9-16   var. 1: violin arpeggios in eighths, cello 1 a slow counterline
    17-24  var. 2 (phase): cello 1 keeps the ground in bars; cello 2 plays it
           in notes of five eighths, so the two grounds drift apart across the
           barlines. The violin's bariolage follows cello 1
    25-32  var. 3 (7/8, 2+2+3): the ground limps; the violin's figure, moved
           down the scale, puts C natural over the A major bar
    33-40  var. 4 (mirror): cello 1 plays the ground upside down around D, the
           violin the theme's melody upside down around D. Only cello 2 is
           still the right way up
    41-48  var. 5 (mensuration canon): the ground at three speeds at once,
           one note per bar, per beat, per eighth. The violin's copy climbs a
           step every cycle
    49     cadenza (free bar): a twelve-tone row, its retrograde, and a way
           back into D minor, over an open-fifth drone
    50-58  the theme again, pianissimo, until the last bar: the bass falls a
           tritone from A to Eb instead of to D. The violin's D is the major
           seventh of Eb and is left sounding alone

    python -m badmidi examples/bent_chaconne.py grid --bars 17-24
    python -m badmidi examples/bent_chaconne.py lens --bars 33-40
    python -m badmidi examples/bent_chaconne.py grid --bars 41-42 --step e
"""
from badmidi import *

Dm = key("D minor")
score = Score("Chaconne with Bent Rules", composer="badmidi", meter=(3, 4), key=Dm,
              tempo=63, tempo_text="Grave ma non troppo")
vln = score.part("violin")
vc1 = score.part("cello 1", "cello")
vc2 = score.part("cello 2", "cello")

# --- the ground and the theme ------------------------------------------------------

ground = M("D3.hd | C3.hd | Bb2.hd | A2.hd | G2.hd | Bb2.hd | A2.hd | D2.hd |")
ground_notes = ground.unbarred()

# sarabande: a short first beat, the long note on beat 2
ARIA_7 = "A4.q F5.h | G4.q E5.h | F4.q D5.h | E4.q Cs5.h | D5.q Bb4.h | D5.q G5.h | Cs5.q G5.h |"
INNER_7 = "F3.q A3.h | E3.q G3.h | D3.q F3.h | Cs3.q E3.h | Bb2.q D3.h | G3.q D3.h | E3.q Cs3.h |"
aria = M(ARIA_7, "F5.hd |")
inner = M(INNER_7, "A3.hd |")

# --- var. 1: arpeggios ---------------------------------------------------------------

arpeggios = M("""
    D5.e F5.e A5.e F5.e D5.e A4.e  | E5.e G5.e C6.e G5.e E5.e C5.e  |
    D5.e F5.e Bb5.e F5.e D5.e Bb4.e | Cs5.e E5.e A5.e E5.e Cs5.e A4.e |
    Bb4.e D5.e G5.e D5.e Bb4.e G4.e | D5.e G5.e Bb5.e G5.e D5.e Bb4.e |
    Cs5.e E5.e G5.e E5.e Cs5.e A4.e | D5.e A4.e F4.e A4.e D5.q      |
""")
counterline = M("A3.hd | G3.hd | F3.hd | E3.hd | D3.hd | D3.hd | Cs3.hd | D3.hd |")
GROUND = ["D3", "C3", "Bb2", "A2", "G2", "Bb2", "A2", "D2"]
pulsing_ground = M(*(M(f"{p}.h {p}.q |") for p in GROUND))

# --- var. 2: the ground against itself ---------------------------------------------------

# seven notes of five eighths (17.5 quarters), then the final D fills out the 8 bars
drifting_ground = isorhythm(ground, [2.5], notes=7) + M("D2*6.5")


def bariolage(x, y, z):
    """Bach's string-crossing figure against the open A string."""
    return M(f"{x}.s A4.s {y}.s A4.s {z}.s A4.s {y}.s A4.s {x}.s A4.s {y}.s A4.s |")


bariolage_var = M(*(bariolage(*c) for c in [
    ("D5", "F5", "A5"), ("E5", "G5", "C6"), ("D5", "F5", "Bb5"), ("Cs5", "E5", "A5"),
    ("D5", "G5", "Bb5"), ("G5", "Bb5", "D6"), ("Cs5", "E5", "G5"), ("D5", "F5", "A5"),
]))

# --- var. 3: 7/8 ---------------------------------------------------------------------

limp = M("A5.e> F5.e G5.e> E5.e F5.e> D5.e E5.e |").sequence([-1, -1, -1], scale=Dm) + M("""
    G5.e> Bb5.e A5.e> G5.e F5.e> E5.e D5.e  |
    D5.e> G5.e  F5.e> E5.e D5.e> Bb4.e G4.e |
    Cs5.e> E5.e G5.e> Bb5.e A5.e> G5.e E5.e |
    D5.q> A4.q D4.qd                        |
""")
limping_ground = M(*(M(f"{p}.q> {p}.q {p}.qd |") for p in GROUND))


def offbeats(chord):
    return M(f"R.e {chord}.e' R.e {chord}.e' R.e {chord}.e' R.e |")


offbeat_chords = M(*(offbeats(c) for c in [
    "[F3 A3]", "[E3 G3]", "[D3 F3]", "[Cs3 E3]", "[Bb2 D3]", "[D3 G3]", "[Cs3 G3]", "[D3 A3]",
]))

# --- var. 4: mirror --------------------------------------------------------------------

mirror_ground = ground.invert(around=D3)        # D E F# G A F# G D, rising
mirror_aria = aria.invert(around=D5)

# --- var. 5: the ground at three speeds -------------------------------------------------

per_beat = ground_notes.rhythm(1).octave(1) * 3                   # 3 cycles in 8 bars
per_eighth = ground_notes.rhythm(0.5).octave(2).sequence([1] * 5, scale=Dm)   # 6 cycles

# --- cadenza: row, retrograde, home --------------------------------------------------

ROW = ["D6", "Cs6", "A5", "E5", "Bb4", "G4", "Ab4", "C5", "Fs5", "B5", "F6", "Eb6"]
cadenza = M(
    " ".join(f"{p}.s5" for p in ROW[:10]),
    "F6.h Eb6.q",
    " ".join(f"{p}.s7" for p in ROW[::-1][:7]),        # the retrograde, from Eb
    "Bb4.s7 E5.s7 A5.s7 Cs6.s7 D6.s7 F6.s7 A6.s7",      # ... and up into D minor
    "A6.h A6.e F6.e D6.e A5.e F5.e D5.e |",
)

# --- placement ----------------------------------------------------------------------

vln.at(1, aria, arpeggios, bariolage_var, Bar(25))
vc1.at(1, inner, counterline, ground.octave(1), Bar(25))
vc2.at(1, ground, pulsing_ground, drifting_ground, Bar(25))

score.meter_change(25, "2+2+3/8")
vln.at(25, limp, Bar(33))
vc1.at(25, offbeat_chords, Bar(33))
vc2.at(25, limping_ground, Bar(33))

score.meter_change(33, "3/4")
vln.at(33, mirror_aria, per_eighth, Bar(49))
vc1.at(33, mirror_ground, per_beat, Bar(49))
vc2.at(33, ground, ground, Bar(49))

score.free_bar(49, 12)
vln.at(49, cadenza)
vc1.at(49, "A2*12 |")
vc2.at(49, "D2*12 |50")

vln.at(50, ARIA_7, "D6.hd~ | D6.hd@ |")
vc1.at(50, INNER_7, "[Bb2 G3].hd | R.hd@ |")
vc2.at(50, ground[:7], "Eb2.hd | R.hd@ |")

# --- markings, tempo -------------------------------------------------------------------

vln.mark(1, "mp", '"cantabile"')
vc1.mark(1, "mp")
vc2.mark(1, "mp")
vln.mark(9, "mf")
vc1.mark(9, "mp")
vc2.mark(9, "mf")
vln.mark(17, "mp", '"poco a poco cresc."', "<")
vc1.mark(17, "mp")
vc2.mark(17, "mp", '"in 5/8 against the bar"', "<")
for p in (vln, vc1, vc2):
    p.mark(24, "f")
vln.mark(25, '"con brio"')
vln.mark(33, "pp", '"sul tasto, senza vibrato"')
vc1.mark(33, "pp", '"sul tasto"')
vc2.mark(33, "p")
for p in (vln, vc1, vc2):
    p.mark(41, "p", "<")
    p.mark(48, "ff")
vln.mark(49, "f", '"ad libitum"', ">")
vc1.mark(49, "pp")
vc2.mark(49, "pp")
for p in (vln, vc1, vc2):
    p.mark(50, "pp")
vln.mark(50, '"come prima, ma lontano"')
vc2.mark(57, "ppp")
vc1.mark(57, "ppp")

score.tempo_mark(25, "Più mosso", 84)
score.tempo_mark(33, "Tempo I", 60)
score.accel(41, 47, to=72)
score.tempo_mark(49, "Cadenza", 60)
score.tempo_mark(50, "Tempo I", 60)
score.rit(55, 58, to=44)
