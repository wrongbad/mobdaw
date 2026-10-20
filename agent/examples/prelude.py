"""Prelude in C minor -- Allegro agitato, for piano.

    1-2    intro: ff stab and cascade, dominant ninth, silence under a fermata
    3-10   A: the theme over surging left-hand sixteenths (half cadence, then full)
    11-18  A': the theme in octaves, forte, turning toward A-flat
    19-26  B: cantabile in A-flat major, poco meno mosso, gentler eighths
    27-34  development: the theme's head sequenced up the scale over a rising
           bass, then its rhythm climbing a diminished seventh over a G pedal,
           accelerando to fff, and a cascade down into...
    35-42  recapitulation, ff in octaves, its ending wrenched to the Neapolitan
    43-46  coda: cascade, hammered iv-V-i, final fermata

    badmidi examples/prelude.py pdf      # sheet music
    badmidi examples/prelude.py wav      # listen
"""
from badmidi import *

Cm = key("C minor")
score = Score("Prelude in C minor", composer="badmidi", meter=(4, 4), key=Cm,
              tempo=100, tempo_text="Allegro agitato")
rh, lh = score.piano()
rh.balance = 8      # performance only: let the melody sing over the figuration

# --- left-hand figuration ----------------------------------------------------
# Each harmony is a five-note voicing; the figure decides how it's broken.

H = {
    "i":    (C2, G2, C3, Eb3, G3),
    "iv":   (F1, C2, F2, Ab2, C3),
    "V":    (G1, D2, G2, B2, D3),
    "V7":   (G1, D2, F2, B2, D3),
    "III":  (Eb2, Bb2, Eb3, G3, Bb3),
    "VI":   (Ab1, Eb2, Ab2, C3, Eb3),
    "iiø7": (F1, D2, Ab2, C3, F3),     # in first inversion, over F
    "i64":  (G1, C2, G2, C3, Eb3),
    "N6":   (F1, Db2, F2, Ab2, Db3),
    "Gm":   (G1, D2, G2, Bb2, D3),
    "Bb":   (Bb1, F2, Bb2, D3, F3),
    "Eb7":  (Eb2, Bb2, Db3, G3, Bb3),
    "Fm7":  (F1, C2, Eb2, Ab2, C3),
    "Db":   (Db2, Ab2, Db3, F3, Ab3),
    "Ab64": (Eb2, Ab2, C3, Eb3, Ab3),
    "Bbm6": (Db2, F2, Bb2, Db3, F3),
    "C7":   (C2, G2, Bb2, E3, G3),
    "G7b9": (G1, D2, F2, Ab2, B2),
}


def surge(chord, beats):
    """Sixteenths up through the voicing and back, two beats per wave."""
    a, b, c, d, e = chord
    return M(*(p.s for p in (a, b, c, d, e, d, c, b))) * int(beats // 2)


def ripple(chord, beats):
    """Gentler eighths: a full arch over a bar, or a quick rise over half a bar."""
    a, b, c, d, e = chord
    return M(*(p.e for p in ((a, b, c, d, e, d, c, b) if beats == 4 else (a, c, d, e))))


def figuration(progression: str, figure):
    """'i | iv V | III' -> one or two harmonies per bar, broken by `figure`,
    with the pedal changing whenever the harmony does. Each | is checked."""
    out, prev = [], None
    for bar in progression.split("|"):
        names = bar.split()
        for name in names:
            if name != prev:
                out.append(PED)
            out.append(figure(H[name], 4 // len(names)))
            prev = name
        out.append(BAR)
    return M(*out)


# --- material ------------------------------------------------------------------

head = M("R.e G4.e C5.qd> D5.e Eb5.q |")                     # the theme's first bar
theme_a = head + M("F5.qd Eb5.e D5.h | R.e Bb4.e Eb5.qd> F5.e G5.q | Ab5.qd G5.e F5.e Eb5.e D5.q |")
theme_b1 = head + M("F5.qd Eb5.e Ab5.h> |")
theme_b2 = M("G5.q Eb5.q D5.q B4.q | C5.h R.h |")
to_A_flat = M("G5.q Eb5.q Db5.q Bb4.q | C5.q Bb4.q Ab4.q G4.q |")

cantabile = M("""
    C5.hd Eb5.q    | Ab5.h G5.q F5.q | F5.h Eb5.q Db5.q | C5.h Bb4.h |
    C5.hd Eb5.q    | F5.h Ab5.q Db6.q | C6.h Bb5.h      | Ab5.h G5.q Bb4.q |
""")

# development: the head climbs the scale, then its rhythm climbs a diminished seventh
rising = head.transpose(3, scale=Cm).sequence([1, 1, 1], scale=Cm)     # over F G Ab Bb
dim_head = M("R.e B4.e D5.qd> F5.e Ab5.q |")
climbing = dim_head.sequence([3, 3])                                  # B, D, F: one chord, rising
cascade = M("[Ab5 B5 D6 F6].h^ F6.s D6.s B5.s Ab5.s F5.s D5.s B4.s Ab4.s |")

# --- right hand ----------------------------------------------------------------

rh.at(1, "[C4 Eb4 G4 C5].q^ C6.s B5.s Ab5.s G5.s F5.s Eb5.s D5.s C5.s B4.s Ab4.s G4.s F4.s |",
         "[B3 D4 F4 Ab4].h^ R.h@ |3")
rh.at(3, theme_a, theme_b1, theme_b2, Bar(11))
rh.at(11, theme_a.double(12), theme_b1.double(12), to_A_flat.double(12), Bar(19))
rh.at(19, cantabile, Bar(27))
rh.at(27, rising.double(-12), climbing.double(-12), cascade, Bar(35))
rh.at(35, theme_a.double(12), theme_b1.double(12),
      M("Ab5.qd G5.e F5.e Eb5.e Db5.q | C5.h B4.h |").double(12), Bar(43))
rh.at(43, """
    [C5 Eb5 G5 C6].q^ C6.s G5.s Eb5.s C5.s G4.s Eb4.s C4.s G3.s R.q |
    [Ab4 C5 F5 Ab5].q^ R.q [G4 B4 D5 F5 G5].q^ R.q |
    [C5 Eb5 G5 C6].q^ R.q [Ab4 C5 F5 Ab5].q^ [G4 B4 D5 G5].q^ |
    [C4 G4 C5 Eb5 G5 C6].w^@ |47
""")

# --- left hand -----------------------------------------------------------------

lh.at(1, "ped [C1 C2].w^ | [G1 G2].h^ R.h@ |3")
lh.at(3, figuration("i | iv V | III | VI V7 | i | iv iiø7 | i64 V7 | i", surge), Bar(11))
lh.at(11, figuration("i | iv V | III | VI V7 | i | iv iiø7 | Eb7 | Eb7", surge), Bar(19))
lh.at(19, figuration("VI | Fm7 | Db | Ab64 Eb7 | VI | Bbm6 | Ab64 Eb7 | VI C7", ripple), Bar(27))
lh.at(27, figuration("iv | Gm | VI | Bb | G7b9 | G7b9", surge),
          "ped", "G1.s G2.s " * 8, "|", "G1.s G2.s " * 8, Bar(35))
lh.at(35, figuration("i | iv V | III | VI V7 | i | iv iiø7 | N6 | i64 V7", surge), Bar(43))
lh.at(43, """
    ped [C1 C2].w^ |
    ped [F1 F2].q^ R.q ped [G1 G2].q^ R.q |
    ped [C1 C2].q^ R.q ped [F1 F2].q^ ped [G1 G2].q^ |
    ped [C1 C2].w^@ | *
""")

# --- dynamics and expression (shared by both hands, printed between the staves) ---

rh.mark(1, "ff")
rh.mark(3, "p", '"agitato"')
rh.mark(4, "<", beat=3)
rh.mark(6, "f")
rh.mark(6, ">", beat=3)
rh.mark(7, "mf")
rh.mark(8, "<")
rh.mark(9, "ff")
rh.mark(9, ">", beat=3)
rh.mark(11, "f")
rh.mark(13, "<")
rh.mark(16, "ff")
rh.mark(17, ">")
rh.mark(19, "p", '"cantabile"')
rh.mark(21, "<")
rh.mark(22, "mf")
rh.mark(22, ">", beat=3)
rh.mark(23, "p")
rh.mark(24, "<")
rh.mark(25, "f")
rh.mark(25, ">", beat=3)
rh.mark(26, "p")
rh.mark(27, '"cresc. poco a poco"', "<")
rh.mark(31, "f", "<")
rh.mark(33, "ff", "<")
rh.mark(34, "fff")
rh.mark(35, "ff", '"con fuoco"')
rh.mark(40, "<")
rh.mark(41, "fff")
rh.mark(44, "sfz")
rh.mark(44, "sfz", beat=3)

# --- tempo -----------------------------------------------------------------------

score.tempo_mark(19, "poco meno mosso", 88)
score.tempo_mark(27, "a tempo", 100)
score.accel(31, 35, to=112)
score.tempo_mark(35, "Tempo I", 100)
score.rit(45, 47, to=66)
