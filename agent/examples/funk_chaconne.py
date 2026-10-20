"""Chaconne and Fugue on a Funk Ground -- for organ.

The ground is the baroque lament bass (D C Bb A: i VII VI V) recast as a
syncopated pedal riff, voiced as funk chords: Dm9, C9, Bbmaj7, A7#9. The
riff is one bar sequenced down the scale, and that one idea runs the piece:
the variations, the canon and the fugue's episodes are all built by
sequencing down the same steps, so they always fit the ground.

    1-4    the ground alone, in the pedal (16' + 8')
    5-8    var. 1: clavinet-style comping on the Swell
    9-12   var. 2: a syncopated sarabande line on the Great
    13-16  var. 3: sixteenth-note bariolage, as in Bach's chaconne
    17-20  var. 4: quartal chords planing down the scale, 3+3+2
    21-24  var. 5: canon at the ninth below, one bar behind
    25-32  Fugue: exposition (alto, soprano answer, tenor, pedal answer)
    33-36  episode: the ground returns; the subject's head rides down it
    37-38  middle entry in G minor, phrygian half cadence
    39-40  dominant pedal, A7b9 / A7#9 stabs
    41-48  finale: the ground twice, with the subject sequenced above
    49     Picardy D6/9
"""
from badmidi import *

Dm = key("D minor")
score = Score("Chaconne and Fugue on a Funk Ground", composer="badmidi",
              meter=(4, 4), key=Dm, tempo=104, tempo_text="Groovy, not too fast")
rh, lh, ped = score.organ()
alto = score.part("alto", "organ", group="Organ", staff="rh")
rh.balance = 6

# --- the ground ------------------------------------------------------------------

riff = M("D3.qd A3.e' R.e D4.e' C4.e' A3.e' |")
ground = riff.sequence([-1, -1], scale=Dm) + M("A2.qd E3.e' R.e A3.e' G3.e' Cs3.e' |")

# Swell comping: one 16th-note "chank" pattern per bar, the chords planing down by step
COMP = ["[F3 A3 C4 E4]", "[E3 G3 Bb3 D4]", "[D3 F3 A3 C4]", "[Cs3 G3 C4]"]   # Dm9 C9 Bbmaj9 A7#9


def chank(chord):
    return M(f"R.s {chord}.s' R.e R.e {chord}.e' R.s {chord}.s' R.e {chord}.e' R.e |")


comping = M(*(chank(c) for c in COMP))

# --- chaconne variations ---------------------------------------------------------

sarabande = M("A5.qd G5.e~ G5.e F5.e D5.q |").sequence([-1, -1, -1], scale=Dm)
bariolage = M("D5.s A4.s F5.s A4.s E5.s A4.s F5.s A4.s A5.s A4.s F5.s A4.s E5.s A4.s D5.s A4.s |"
              ).sequence([-1, -1, -1], scale=Dm)
quartal = M("[A4 D5 G5].qd^ [G4 C5 F5].qd^ [A4 D5 G5].q^ |").sequence([-1, -1, -1], scale=Dm)

# canon at the ninth below: the ground falls a step each bar, so a line that
# fits bar k fits bar k+1 when moved down a step, one bar later
leader = M("""
    D5.e F5.e A5.e G5.s F5.s E5.e D5.e E5.e F5.e |
    G5.qd A5.e Bb5.q G5.e E5.e |
    D5.e C5.e D5.e E5.e F5.q D5.e Bb4.e |
    E5.qd D5.e Cs5.q A4.q |
""")
follower = leader[:-4].transpose(-1, scale=Dm).octave(-1)      # the first three bars

# --- fugue ---------------------------------------------------------------------------

subject = M("D4.e A4.e R.s A4.s G4.s F4.s E4.s F4.s G4.e~ G4.s F4.s E4.s D4.s | Cs4.e E4.e A3.e R.e D4.q R.q |")
answer = M("A4.e D5.e R.s E5.s D5.s C5.s B4.s C5.s D5.e~ D5.s C5.s B4.s A4.s | Gs4.e B4.e E4.e R.e A4.q R.q |")
counter = M("F4.q E4.q D4.e G4.e E4.q | D4.q C4.e B3.e C4.q Cs4.e E4.e |")
head = M("D4.e A4.e R.s A4.s G4.s F4.s E4.s F4.s G4.e~ G4.s F4.s E4.s D4.s |")
head_down_the_ground = head.sequence([-1, -1, -1], scale=Dm)    # fits Dm9 C9 Bbmaj7 A7#9

# --- registration ----------------------------------------------------------------------

rh.registration(1, "Gt.: Principals 8' 4'", "organ")
lh.registration(1, "Sw.: Flutes 8' 4' 2 2/3' (perc.)", "percussive organ")
ped.registration(1, "Ped.: 16' 8'", "organ")
rh.registration(17, "Gt.: + Mixture", "rock organ")
rh.registration(21, "Gt.: Principals 8' 4'", "organ")
lh.registration(21, "Sw.: Principal 8', Flute 4'", "organ")
lh.registration(33, "Sw.: Flutes (perc.)", "percussive organ")
lh.registration(37, "Sw.: Principal 8', Flute 4'", "organ")
rh.registration(39, "Gt.: + Mixture", "rock organ")
lh.registration(41, "Sw.: Flutes (perc.)", "percussive organ")
rh.registration(41, "Gt.: Full", "organ")
ped.registration(41, "Ped.: + Reeds 16'", "organ")
rh.registration(45, "Gt.: Full + Mixture", "rock organ")

# --- pedal -------------------------------------------------------------------------------

ped.at(1, ground * 6, Bar(25))                       # chaconne
ped.at(31, answer.octave(-2), Bar(33))               # the fugue's bass entry
ped.at(33, ground, Bar(37))                          # episode
ped.at(39, "A2.w~ | A2.w |41")                       # dominant pedal
ped.at(41, ground * 2, "D3.w@ |50")                  # finale

# --- chaconne ------------------------------------------------------------------------------

lh.at(5, comping * 4, Bar(21))                       # vars. 1-4
rh.at(9, sarabande, bariolage, quartal, leader, Bar(25))
lh.at(22, follower, Bar(25))

# --- fugue: exposition ---------------------------------------------------------------------

alto.at(25, subject, counter,
        "F4.q D4.q E4.q D4.q | E4.q Cs4.q A3.q Cs4.q |",
        "D4.q C4.q D4.q C4.q | E4.q D4.q C4.q E4.q |33")
rh.at(27, answer,
      "D5.q A4.q G4.e C5.e A4.q | G4.q E4.q F4.q E4.q |",
      "A4.q C5.q G4.q A4.q | B4.q Gs4.q A4.q G4.q |33")
lh.at(29, subject.octave(-1), counter.octave(-1), Bar(33))

# --- episode, middle entry, dominant pedal ------------------------------------------------

rh.at(33, head_down_the_ground.octave(1), Bar(37))
alto.at(33, "F4.w | E4.w | D4.w | Cs4.w |37")
lh.at(33, comping, Bar(37))

rh.at(37, subject.transpose(5), Bar(39))
alto.at(37, "Bb3.q D4.q C4.e F4.e D4.q | C4.q Bb3.e A3.e Bb3.q G3.e D4.e |39")
lh.at(37, "G3.h A3.q Bb3.q | D3.h G2.q Bb2.q |39")

rh.at(39, "[G4 Bb4 Cs5 E5].qd^ [G4 Bb4 Cs5 E5].qd^ [G4 Bb4 Cs5 E5].q^ |",
          "[G4 C5 E5].qd^ [G4 C5 E5].qd^ [G4 Cs5 E5 A5].q^ |41")
lh.at(39, "[Cs3 G3].qd^ [Cs3 G3].qd^ [Cs3 G3].q^ | [Cs3 G3].qd^ [Cs3 G3].qd^ [Cs3 E3 G3].q^ |41")

# --- finale ---------------------------------------------------------------------------------

rh.at(41, head_down_the_ground.octave(1).double(-12), quartal.octave(1), "[D5 Fs5 B5 E6 A6].w@ |50")
alto.at(45, head_down_the_ground, "[Fs4 A4].w@ |50")
lh.at(41, comping * 2, "[D3 Fs3 A3 E4].w@ |50")

# --- dynamics, sections, tempo ----------------------------------------------------------------

rh.mark(1, '"Chaconne"', "mp")
rh.mark(9, "mf")
rh.mark(13, "<")
rh.mark(17, "f")
rh.mark(21, "mf", ">")
rh.mark(24, "p")
rh.mark(25, '"Fuga"', "mp", "<")
rh.mark(31, "f")
rh.mark(33, "mf")
rh.mark(37, "mf")
rh.mark(39, "<")
rh.mark(40, "ff")
rh.mark(41, "ff", "<")
rh.mark(45, "fff")
score.rit(48, 49, to=80)
