"""Fuga a 6 on a chromatic subject -- for flute, oboe, violin, viola,
bassoon and cello.

The subject leaps up a fifth, falls back through the triad, then slides
down the lament tetrachord D C# C B Bb A in eighths. The tonal answer bends
its head (A D, not A E). The countersubject runs in parallel sixths under
the chromatic tail; it has one shape against the subject and one against
the answer.

    1-12   exposition, six entries climbing, then the two bass instruments:
           viola S, violin A, oboe S, flute A, cello S, bassoon A, each
           over the countersubject in the voice that just finished
    13-15  episode 1: a chain of 4-3 suspensions in the flute over a
           circle of fifths, viola in running eighths
    16-19  middle entries in F major (flute) and C (bassoon). The
           countersubject's chromatic sixths now go to the flat side:
           Db, Ebm/Gb, Db/F
    20-22  episode 2: the suspension chain inverted, back to the dominant
    23-24  mirror: the subject in the cello and its inversion in the violin
           at the same moment, a twelfth apart
    25-29  stretto: four entries three beats apart, cello, viola, oboe,
           bassoon, over two and a half octaves
    30-34  the chaconne's lament ground returns in the bassoon over a tonic
           pedal; a chorale over it closes on D major

    python -m badmidi examples/chromatic_fugue.py grid --bars 23-29
    python -m badmidi examples/chromatic_fugue.py lens --bars 1-12
"""
from badmidi import *

K = key("D minor")
score = Score("Fuga a 6 on a Chromatic Subject", composer="badmidi", meter=(4, 4), key=K,
              tempo=72, tempo_text="Andante sostenuto")
fl = score.part("flute")
ob = score.part("oboe")
vn = score.part("violin")
va = score.part("viola")
bn = score.part("bassoon")
vc = score.part("cello")

# --- material ------------------------------------------------------------------------
subject = M("D4.h A4.q F4.q | D4.e Cs4.e C4.e B3.e Bb3.q A3.q |")
answer = M("A4.h D5.q C5.q | A4.e Gs4.e G4.e Fs4.e F4.q E4.q |")
inversion = M("D4.h G3.q Bb3.q | D4.e Eb4.e E4.e F4.e Fs4.q G4.q |")
cs_answer = M("R.e C4.e D4.e E4.e F4.q E4.q | C4.q Bb3.q A3.q Gs3.q |")     # under the answer
cs_subject = M("R.e F3.e G3.e A3.e D4.q A3.q | F3.q Eb3.q D3.q Cs3.q |")   # under the subject
subject_F = M("F5.h C6.q A5.q | F5.e E5.e Eb5.e D5.e Db5.q C5.q |")        # middle entry, F major
cs_F = M("R.e A4.e Bb4.e C5.e F5.q C5.q | Ab4.q Gb4.q F4.q E4.q |")
answer_C = M("C4.h F4.q E4.q | C4.e B3.e Bb3.e A3.e Ab3.q G3.q |")
cs_C = M("R.e E3.e F3.e G3.e A3.q G3.q | E3.q Db3.q C3.q B2.q |")

# the chaconne's ground, two notes to the bar
ground = M("D3.h Cs3.h | C3.h B2.h | Bb2.h G2.h | A2.h A2.h |")

REST = "R.w |"

# --- exposition ----------------------------------------------------------------------
va.at(1, subject, cs_answer,
      "D3.q G3.q F3.q D3.q | Bb3.q Eb3.q G3.q A3.q |",                       # 5-6
      "A3.q F3.q Bb3.q C4.q | F3.q G3.q D3.q E3.q |",                        # 7-8
      "F3.h A3.q A3.q | A3.h G3.q Cs4.q |",                                  # 9-10
      "A3.q D4.h E4.q | A3.q E4.q C4.q B3.q |", Bar(13))                     # 11-12
vn.at(1, REST, REST, answer, cs_subject.octave(1),
      "E4.q A4.q D4.q E4.q | A4.q D4.h B3.q |",                              # 7-8
      "A4.h E4.q A4.q | D4.hd E4.q |",                                       # 9-10
      "C5.q A4.q A4.q C5.q | C5.h A4.q E4.q |", Bar(13))                         # 11-12
ob.at(1, REST * 4, subject.octave(1), cs_answer.octave(1),
      "D5.h Cs5.q A4.q | A4.h D5.q Cs5.q |",                                 # 9-10
      "E5.q F5.q F5.q G5.q | A5.q G5.q A5.q B5.q |", Bar(13))                          # 11-12
fl.at(1, REST * 6, answer.octave(1),
      "A5.q F5.q E5.q D5.q | F5.q Fs5.q G5.q E5.q |", REST * 2, Bar(13))     # 9-12
vc.at(1, REST * 8, subject.octave(-1), cs_answer.octave(-1), Bar(13))
bn.at(1, REST * 10, answer.octave(-1), Bar(13))

# --- episode 1: suspensions over a circle of fifths ---------------------------------
fl.at(13, "G5.h~ G5.q Fs5.q | F5.h~ F5.q E5.q | F5.h~ F5.q E5.q |")
ob.at(13, "C5.h C5.h | B4.h~ B4.q Bb4.q | A4.h G4.h |")
vn.at(13, "E4.h D4.h | D4.h C4.h | C4.h Bb3.h |")
va.at(13, "C4.e A3.e E3.e A3.e Fs3.e A3.e C4.e A3.e | G3.e B3.e D3.e G3.e E3.e G3.e Bb3.e G3.e | "
          "F3.e A3.e C3.e F3.e E3.e G3.e E3.e C3.e |")
vc.at(13, "A2.h D3.h | G2.h C3.h | F2.h C3.h |")
bn.at(13, REST * 3)

# --- middle entries: F major, then C ------------------------------------------------
fl.at(16, subject_F, REST * 2)
ob.at(16, cs_F, "C5.q F5.q F5.q G5.q | G5.q F5.hd |")
vn.at(16, "C4.q D4.q C4.h | F4.q Eb4.q Ab3.q C4.q |",
          "G4.q A4.q A4.q C5.q | G4.q Bb4.q C5.q D5.q |")
va.at(16, REST * 4)
vc.at(16, "F2.q Bb2.q A2.q F2.q | Db3.q Eb3.q F3.q C3.q |", cs_C)
bn.at(16, REST * 2, answer_C)

# --- episode 2: back to the dominant -----------------------------------------------
ob.at(20, "E5.h~ E5.q D5.q | D5.h~ D5.h | Cs5.h E5.h |")
vn.at(20, "C5.h A4.h | Bb4.h B4.h | A4.h G4.h |")
va.at(20, "E4.e D4.e C4.e Bb3.e A3.e C4.e F4.e C4.e | D4.e C4.e Bb3.e A3.e Gs3.e B3.e E4.e D4.e | "
          "A3.e Cs4.e E4.e Cs4.e G3.e Cs4.e E4.e Cs4.e |")
vc.at(20, "C3.h F2.h | Bb2.h E2.h | A2.h A2.h |")
bn.at(20, REST * 3)
fl.at(20, REST * 3)

# --- mirror: the subject against its own inversion ------------------------------------
vc.at(23, subject.octave(-1))
vn.at(23, inversion.transpose(7))
ob.at(23, "F5.h D5.h | F5.q E5.h A5.q |")
va.at(23, "A3.w | F3.q Gs3.q G3.q E4.q |")
fl.at(23, REST * 2)
bn.at(23, REST * 2)

# --- stretto: entries three beats apart ---------------------------------------------
vc.at(25, subject.octave(-1), "R.w | R.w | A2.w |")
va.at(25, "R.hd", subject.unbarred(), "R.q |", "R.w | A3.w |")
ob.at(25, "R.w | R.h", subject.octave(1).unbarred(), "R.h |", "Cs5.w |")
bn.at(25, "R.w | R.w | R.q", subject.octave(-1).unbarred(), "R.hd |")
fl.at(25, "A5.w | F5.w | A5.h F5.h | D5.h E5.q D5.q | E5.w |")
vn.at(25, "F4.h E4.q F4.q | A4.h D5.h | F4.w | F4.h E4.q G4.q | E4.w |")

# --- the ground returns: chorale over a tonic pedal ---------------------------------
bn.at(30, ground, "D3.w@ |")
vc.at(30, "D2.w~ | D2.w~ | D2.w~ | D2.w | D2.w@ |")
fl.at(30, "F5.h E5.h | Fs5.h G5.h | G5.h E5.h | D5.h Cs5.h | D5.w@ |")
ob.at(30, "A4.h G4.h | A4.h F4.h | G4.h Bb4.h | A4.h G4.h | Fs4.w@ |")
vn.at(30, "D4.h E4.h | D4.h D4.h | D4.h D4.h | D4.h E4.h | D4.w@ |")
va.at(30, "A3.h A3.h | A3.h G3.h | G3.h D4.h | A3.h A3.h | A3.w@ |", Bar(35))

# --- dynamics and tempo -------------------------------------------------------------
va.mark(1, "mp", '"legato"')
vn.mark(3, "mp"); ob.mark(5, "mp"); fl.mark(7, "mp"); vc.mark(9, "mf"); bn.mark(11, "mf")
for p in (fl, ob, vn, va, vc):
    p.mark(13, "p")
for p in (fl, ob, vn, vc, bn):
    p.mark(16, "mp")
for p in (ob, vn, va, vc):
    p.mark(20, "p", "<")
for p in (ob, vn, va, vc):
    p.mark(23, "f")
for p in (fl, ob, vn, va, bn, vc):
    p.mark(25, "f")
    p.mark(30, "mf", ">")
    p.mark(34, "p")
score.rit(32, 35, to=50)
