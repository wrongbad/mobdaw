# badmidi

**Music as code, for composers who work in text, human or AI.**

badmidi lets you write music as a Python program. A theme is a value; an
inversion, a sequence or a canon is a function applied to it. The score
comes back to you as text you can read, grep and reason about. Out the other
end come sheet music that is *proven* to match what you wrote, MIDI, and
audio.

```python
from badmidi import *

theme  = M("E4.q G4.e A4.e B4.h")
answer = theme.invert(around=A4).transpose(5)
bridge = theme.augment(2).fragment(0, 2).sequence([-1, -1], scale=key("E minor"))

score = Score("Sketch", meter=(4, 4), tempo=80, key="E minor")
score.part("violin").at(1, theme, answer, Bar(3), bridge)
score.part("cello").at(3, theme.octave(-2))
score.part("viola").at(5, "B3.h [E4 G4].h | Fs4.w~ | Fs4.h R.h |8")
```

```
badmidi sketch.py            # the score as text, one line per part
badmidi sketch.py grid       # the harmony, moment by moment
badmidi sketch.py lens       # what the voices are doing
badmidi sketch.py pdf        # sheet music, verified note for note
badmidi sketch.py wav        # audio
```

## Why

Most music software assumes you can see and hear: you drag notes, look at
the page, listen back. badmidi assumes you read and write. Everything you
need to judge a piece is available as text, so a language model can compose
seriously, and so can a person who likes to think in code.

- **Ideas are values.** Name a motif and develop it: transpose by scale
  step, invert, augment, fragment, sequence, overlay a talea on a color.
  Development is visible in the source, not buried in a piano roll.
- **Nothing drifts.** Every passage is placed at an explicit bar, every
  barline you write is checked, and time is exact fractions. A miscounted
  bar is reported once, where it happens, and doesn't shift the rest of the
  piece.
- **The score reads back as text.** A melody view (paste it straight back in
  as input), a harmony grid that names every sonority as chord, roman
  numeral *and* set class, and a lens that names what the counterpoint is
  doing.
- **The engraving is proven, not eyeballed.** LilyPond renders the PDF and
  also writes MIDI from the same source. Every note in it has to match your
  score, or the run fails and names the note.
- **No house style.** The tools describe and never prescribe. The lens calls
  a suspension a suspension and parallel fifths parallel fifths, and leaves
  the verdict to you. Renaissance modality, tonal harmony, set-class
  writing and additive rhythm all sit in one piece without anyone
  complaining.

## What's in the box

- **Notation**: one spelling shared by Python values and strings
  (`E4.q`, `[C4 E4 G4].h`, `Fs4.e3`, `D5.s5`). Ties, articulations, any tuplet,
  dynamics, hairpins, pedal and expression text, placed in time like on the
  page.
- **Time**: meter changes, additive meters (`2+2+3/8`), unmetered bars for
  cadenzas, tempo marks, rit. and accel.
- **Development**: transposition (chromatic or diatonic), inversion,
  retrograde, augmentation, sequence, doubling, rhythm and pitch swaps,
  isorhythm.
- **Analysis**: chord symbols, roman numerals, Forte set classes, and a lens
  that names passing notes, appoggiaturas, suspensions with their figures,
  parallels and crossings. Plus a stretto finder that lays a subject against
  itself at every offset and interval and describes each overlap.
- **Output**: LilyPond PDF/PNG (8va signs, grand staves, organ and accordion
  layouts, registrations, tuplet brackets), Standard MIDI, and audio through
  FluidSynth. Playback is a separate layer that turns markings into velocity
  curves, tempo maps and pedalling without touching the printed score.
- **Listening** (optional `badmidi[audio]`): `badmidi listen` hears the chords and strum rhythm of a recorded track in a
  mobdaw project, `pull --listen` puts them in the piece as read-only parts, and `bass.line` drafts a bass part against
  them (roots, root-fifth, pulse, walk). See AGENTS.md, "Making a part for a recording".
- **Collaboration**: import MIDI or MusicXML (quantized, voiced, spelled,
  with a report of every guess) as an editable piece or load it live and
  layer on top; export MusicXML back to a notation app.

Pure-stdlib Python. LilyPond for sheet music, FluidSynth and a General MIDI
soundfont for audio.

## Examples

`examples/` holds finished pieces, each with its PDF and MIDI:

- a Bach-style chorale
- a round
- a string-quartet sketch
- a stormy piano prelude
- a funk chaconne and fugue for organ
- a hexachord fantasia for free-bass accordion that runs from Renaissance
  cantus firmus to a ricercar answered at the tritone

## Getting started

```
python -m badmidi examples/prelude.py grid --bars 1-8
python -m unittest discover tests
```

**[AGENTS.md](AGENTS.md)** is the working manual: the composing loop, the
notation, every API, the views, and the mistakes to watch for. Start there
to write a piece.
