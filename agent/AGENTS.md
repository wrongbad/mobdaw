# AGENTS.md: composing with badmidi

Everything you need to write, check, hear and engrave a piece without reading
the source. The README says what the project is for; this file says how to
use it.

## Setup

```
python -m badmidi piece.py check          # works from the repo root without installing
pip install -e .                          # optional: gives the `badmidi` command
python -m unittest discover tests         # the suite; engraves and verifies every example
```

Pure stdlib Python ≥ 3.10. `pdf`/`png` need `lilypond`; `wav` needs
`fluidsynth` and a General MIDI soundfont (MuseScore's is found
automatically, or set `BADMIDI_SOUNDFONT=/path/to/font.sf2`).

## The loop

A piece is a Python file that builds a `Score` named `score`.

1. Write or edit `piece.py`.
2. `badmidi piece.py check`: fix every ERROR. Errors are about notation, not
   taste: miscounted bars, wrong bar anchors, overlapping notes in one part.
   Fix the first error in a part first; the rest are often the same miscount.
3. `badmidi piece.py grid --bars 9-16` (or `--section B`): read the harmony. Every row is an
   onset, labelled with chord symbol, roman numeral and set class.
4. `badmidi piece.py lens --bars 9-16`: read the counterpoint: each
   dissonance named by how it moves, plus parallels and crossings. It's a
   description, not a list of things to fix. Decide for yourself.
5. `badmidi piece.py pdf`: engraves and proves it. LilyPond's own MIDI of
   the engraving must match the score note for note, and any LilyPond warning
   fails the run. If it says "verified", the PDF is right and you don't need
   to look at it. (`png` writes page images if you want to look anyway.) The
   LilyPond source is left as `piece.ly` only when something fails, for
   debugging; `badmidi piece.py ly` prints it any time.
6. `badmidi piece.py wav` and `midi`.

You can't hear the audio, so do your listening through `grid` and `lens`.
When you report on a piece, say which checks you ran, and say that the audio
is unheard.

## Skeleton

```python
"""Title -- for instrument(s).

    1-8    what happens in these bars
    9-16   ...
"""
from badmidi import *

K = key("D minor")
score = Score("Title", composer="badmidi", meter=(4, 4), key=K, tempo=72,
              tempo_text="Andante")
rh, lh = score.piano()                     # or score.part("violin"), score.organ(), ...

# --- material: name the ideas, develop them by transformation ---------------
theme = M("D4.q F4.q A4.h | G4.q F4.e E4.e D4.h |")
answer = theme.transpose(4, scale=K)

# --- placement: every passage at an explicit bar ------------------------------
rh.at(1, theme, answer, Bar(5))
lh.at(1, "D3.w | A2.w | D3.w | A2.w |5")

# --- markings, tempo -----------------------------------------------------------
rh.mark(1, "p", '"dolce"')
score.rit(7, 9, to=60)
```

Read the examples in `examples/` for full pieces (see the end of this file).

## Notation: one spelling for Python and strings

A token in a string is spelled exactly like the Python value and like the
views print it, so view output can be pasted back as input.

| Python | string | meaning |
|---|---|---|
| `C4`, `Fs4`, `Bb3` | same, or `F#4` | pitch; C4 = middle C; `s`/`#` sharp, `b` flat |
| `E4.q` | `E4.q` | `w h q e s t` = whole … 32nd |
| `E4.qd` | `E4.qd` | dotted |
| `E4.e3` | `E4.e3` | triplet eighth |
| `E4.s5`, `E4.e7` | same | any tuplet: n in the time of the power of two below n |
| | `E4.q5:3`, `E4.q2:3` | explicit ratio (5 in 3; a duplet in 6/8); printed and engraved as written |
| `E4 * 1.5` | `E4*1.5`, `E4*(5/3)` | any length in quarter notes; one that is a tuplet of a plain value prints as that tuplet (`E4.s12:11` for 11/48), and engraves as a bracket (`\tuplet 12/11`) |
| `R.q`, `R * 3` | `R.q`, `R*3` | rest |
| `(C4 & E4 & G4).h` | `[C4 E4 G4].h` | chord |
| `E4.h.tie` | `E4.h~` | tie into the next note of the same pitch |
| `E4.q.accent` … | `E4.q>` `^` `'` `_` `@` | accent, marcato, staccato, tenuto, fermata |
| `BAR`, `Bar(14)` | `\|`, `\|14` | checked barline; "this is the start of bar 14" |
| `E4 + 7`, `B4 - E4` | | pitch + semitones; interval in semitones |

Each token is complete in itself: its own octave and duration, nothing
carried over from the previous one. Whitespace is free, so you can line
voices up bar by bar (`examples/chorale.py`). A parse error names the token
and the bar of the string it's in. Use strings for note-level passages and
Python values for ideas you'll transform; they mix freely:
`vla.at(5, "E4.w |", answer.octave(-1), "|7")`.

**Put `|` in every string and `|N` at section ends.** That is how `check`
catches a miscounted bar, which is the most common mistake. In practice it
happens all the time, especially with dotted values and tuplets.

## Markings

Markings sit in time like notes. Write them inline (they travel with the
motif) or place them with `mark()`:

```python
rh.at(19, 'p "cantabile" C5.hd Eb5.q | Ab5.h < G5.q F5.q | F5.h f Eb5.q Db5.q |')
lh.at(19, "ped Ab1.e Eb2.e ... | ped ... | *")
rh.mark(27, '"cresc. poco a poco"', "<")      # bar 27, beat 1
rh.mark(6, ">", beat=3)
```

| string | Python | |
|---|---|---|
| `ppp` … `fff`, `sf` `sfz` `fp` `rfz` | `dyn("p")` | dynamics |
| `<` `>` | `CRESC`, `DIM` | hairpin, running to the next dynamic (or to the end) |
| `!` | `HAIRPIN_END` | end a hairpin with no new dynamic |
| `ped` `*` | `PED`, `PED_UP` | pedal down (or change); up |
| `"con fuoco"` | `text("con fuoco")` | expression text; next to a dynamic it prints as "p dolce" |

Parts in one group (a piano's hands, an accordion's manuals) share dynamics
and pedal, so mark them on one part only.

Registration (organ stops, accordion reeds) is printed above the staff and
can switch the playback program: `rh.registration(17, "Gt.: + Mixture", "rock organ")`;
leave out the program to keep the current sound.

## Score, parts, time

```python
score = Score(title, meter=(4, 4), tempo=100, key="C major", tempo_text=None, composer=None)
p = score.part("violin")                       # instrument taken from the name
p = score.part("melody", "flute")              # or given
p = score.part("rh", "reed organ", group="Accordion", clef="treble", range=(E3, A6))
rh, lh = score.piano()                         # grand staff, one MIDI channel
alto = rh.voice("alto")                        # a second line on rh's staff, same instrument and channel
rh, lh, ped = score.organ()                    # two manuals + pedal with a 16' coupler
```

Part keywords:
- `group`: braced together, sharing dynamics and pedal.
- `staff`: share a staff as voices.
- `clef`: `"treble"`, `"bass"`, `'"treble_8"'`.
- `range`: overrides the instrument's range for warnings.
- `balance`: a velocity offset, to bring out a line.
- `couplers=(0, -12)`: extra octaves in playback.
- `channel`: share a MIDI channel.
- `pan`.

Instruments:
- **keyboards:** piano, harpsichord, celesta, organ, pedal, drawbar organ, percussive organ, rock organ, reed organ
- **pitched percussion:** glockenspiel, vibraphone, marimba
- **plucked:** guitar, bass guitar, harp
- **strings:** violin, viola, cello, contrabass, strings
- **voices:** choir, soprano, alto, tenor, bass
- **brass:** trumpet, trombone, tuba, horn
- **woodwinds:** oboe, english horn, bassoon, clarinet, piccolo, flute, recorder

For anything else, use the nearest sound and set `range=` (the fantasia's
free-bass accordion is a reed organ with accordion ranges).

Placing music:

```python
p.at(5, theme)                    # bar 5, beat 1
p.at(5, theme, beat=3)            # beat 3 (beats are the meter's: eighths in 7/8)
p.at(5, a, b, "E4.w |", Bar(9))   # several arguments run on, one after another
p.then(answer)                    # straight after the last placement
```

Each argument to `at()`/`then()` is checked on its own. A motif that starts
mid-bar (a stretto entry, a canon at the half bar) keeps its own barlines,
checked as whole bars from where it starts, so this is fine if `answer` is
two whole bars: `bass.at(17, answer, "E2.h | Fs2.h G2.h |", beat=3)`.
Numbered anchors (`|23`, `Bar(23)`) are always absolute. To drop a motif's
barlines entirely: `m.unbarred()`.

A part is one line: its notes can't overlap. For two voices on one staff
(a fugue in the right hand, a held note under a moving one) give the second
voice its own part with `rh.voice("alto")`.

Loops (minimalism, ostinati) play fully expanded and engrave as a repeat:

```python
p.loop(5, "E4.e F4.e G4.e A4.e B4.e A4.e | ", times=8)   # bars 5-12; also takes Motifs and several arguments
p.loop(13, rot, times=4).then("E4.w |")                  # chains like at()
```

Every view and `check` see all `times` passes; a loop of one bar at bar 5
with `times=8` occupies bars 5-12, and the engraving prints it once as
`\repeat volta 8` with "×8" above the top staff. Bar numbers in the
engraving keep counting every pass (the bar after it is printed as 13), so
they always match the views. LilyPond's MIDI is verified with the repeats
unfolded. A loop is engraved as a repeat only when it is true to every
staff, otherwise the whole span is written out and `check` says why (a NOTE,
not an error):
- one pass starts and ends on barlines, in a single meter, no free bars;
- **every part** is the same in each pass (or silent): parts may play
  different things, each repeating, but a part that carries on with something
  else, or loops a different span, makes the others' loops written out;
- no tempo change, section, registration, drift or marking (other than at the first
  beat of the span) falls inside it;
- loops don't overlap (the earlier one wins).

Material can't contain numbered anchors (`|N`), since they name one bar.
Several parts looping the same span: give each the same `bar` and `times`.

Sections are rehearsal marks and a handle for the views:

```python
score.section(9, "B", "the second marimba slips")   # engraved as a boxed B with the text above
```

A section runs to the next one. `--section B` or `--section B-C` replaces
`--bars` in `melody`, `grid`, `lens` and `form` (in Python:
`score.melody(section="B")`). Labels in the views print as `9 [B]`.

Tempo and meter are score-level:

```python
score.tempo_mark(19, "poco meno mosso", 88)
score.rit(45, 47, to=66)                   # also accel(); a position is a bar or (bar, beat)
score.meter_change(9, "3/4")               # also (3, 4), "6/8"
score.meter_change(13, "2+2+3/8")          # additive: printed 2+2+3 over 8, grouped that way
score.free_bar(20, 11)                     # unmetered bar of 11 quarters; then the meter resumes
```

Per-part drift is playback only, for phasing, tempo canons and independent
layers (Reich, Nancarrow, Ives):

```python
b.drift(9, 41, ahead=Fraction(1, 4))       # b sounds up to a sixteenth ahead of its written time by bar 41
b.drift(41, 49, ahead=-Fraction(1, 4))     # ...and back; negative is behind
b.drift((9, 3), 41, ahead=.5, text="gradually pushing")   # positions as in rit(); own text
```

Over the span `b` gets `ahead` quarters ahead (a linear ramp, so a steady
tempo ratio r is `(r - 1) * length`), then stays that far off until another
drift moves it. Only the MIDI/wav timing of that part (notes, its pedal and
registration changes) warps; the score, `melody`/`grid`/`lens`/`check` and the
engraved rhythms stay in written time, and LilyPond verification still
compares the written rhythm. The staff prints the text ("gradually accel. (to
1/16 ahead)") over a dashed line, and `check` notes each span. A drift that
would make a part play backwards is an error at call time. `voice()` parts
drift separately.

Time is in quarter notes, as exact `Fraction`s.
- `score.time(bar, beat)` gives the time of a bar and beat, and `score.position(t)` gives `(bar, beat)` back.
- `score.where(t)` formats a time as `"12:3"`.
- `score.bar_start(bar)` and `score.meter_at(bar)` give each bar's start and meter.
- `score.metric_level(t)`: 3 is a downbeat, 2 another strong beat, 1 a pulse, 0 a beat, -1 between beats.

Strong beats are:
- the downbeat
- beat 3 of a four-beat bar
- every group start in additive and compound meters
- every beat in half-note meters

## Motifs

`M(...)` takes strings, notes, motifs and lists, flattened. `a + b`
concatenates; `m * 3` repeats; `m[0]`, `m[:2]` index notes; `m.text()` and
`repr(m)` give string notation back; `m.dur`, `m.pitches`, `m.notes`.

| transformation | |
|---|---|
| `transpose(n)` / `transpose(n, scale=K)` | semitones (spelled as one interval) / scale steps (alterations kept) |
| `octave(n)` | n octaves (keeps written spelling) |
| `invert(around=A4)` / `invert(around=E4, scale=K)` | chromatic / diatonic mirror |
| `unbarred()` | the same music without its barline anchors |
| `retrograde()` | reversed (drops dynamics, hairpins, pedal, text) |
| `augment(2)`, `diminish(2)` | scale durations |
| `fragment(0, 2)` | notes 0..1 |
| `sequence([-1, -1], scale=K)` | the motif, then copies each shifted from the last |
| `double(-12)`, `double(12, 24)` | add the pitches again at intervals |
| `rhythm(1, .5, .5)` / `rhythm(other)` | new durations, same pitches (cycled) |
| `with_pitches(E4, G4)` / `with_pitches(other)` | new pitches, same rhythm (cycled) |
| `map(fn)`, `map_pitches(fn)` | per-note: fn(note) -> note |
| `map_timed(fn)` | fn(note, i, t) -> note: index (rests count) and onset in quarters |
| `rotate(n)` | start n notes in, the rest to the end; markings travel; unbarred |
| `events()`, `Motif.from_events(evs, tail)`, `restructure(fn)` | notes as `Event(note, marks)`; reorder/drop/insert with marks travelling; unbarred |
| `timed()` | `[(onset, note)]` |
| `pipe(fn, *args)` | `fn(m, *args)`, so your transforms chain |
| `rebar(meter, start=0)` | put `\|` back every bar, splitting notes with ties |
| `expect(bars=N, meter=..)` / `expect(dur=..)` | raise now, with check's message, if the length or barlines are off; else returns the motif |

```python
isorhythm("C4 D4 F4 G4 A4", [1, .5, .5, 2])    # color over talea, until both cycles end together
isorhythm(theme, M("C4.q R.e C4.e C4.h"), notes=12)   # a rest in the talea uses up no pitch
```

Keys: `key("E minor")`, `key("Bb major")`, `key("D dorian")`, `key("F#m")`
(also phrygian, lydian, mixolydian, locrian, harmonic/melodic minor).

**Spelling.** Pitches you write keep your spelling, and transformations
spell the way a musician would:
- A chromatic `transpose(n)` spells the whole motif as one interval, whichever
  needs fewer accidentals: C G A F up 6 is F# C# D# B (an augmented fourth),
  not Gb Db Eb Cb.
- `invert()` mirrors letter names around the axis.
- Diatonic steps are spelled as the scale spells them.
- Octave shifts keep your spelling.

Only bare arithmetic (`E4 + 7`) and chords named by pitch class fall back to
the score's key.

A chromatic inversion around a point between two notes: invert around a
note, then transpose, e.g. `invert(around=A4).transpose(-9)` mirrors C↔A.

## Writing your own transformations

The built-ins are a few generic moves; process ideas (additive, phase,
beat-building) are yours to write.
- A transform is a function `Motif -> Motif` (extra arguments after it).
  Chain with `pipe`: `cell.pipe(additive).pipe(shift, 3).transpose(5)`.
- Per-note work: `map`, `map_timed`. Reordering, dropping, inserting:
  `restructure` or `events()` / `Motif.from_events`. A mark written before a
  note (dynamic, hairpin, pedal, text, and the articulations on the note)
  belongs to that note's onset and travels with it; marks after the last note
  stay at the end. Restructured material is unbarred.
- Put barlines back with `rebar(meter)` and assert the length with
  `expect(bars=N)`, so `check` still catches a miscount in generated music.
- Keep shared ideas in an `ideas.py` next to your pieces and import it
  (`from ideas import additive`); run `badmidi` from that directory.

```python
# phase blocks: the cell rotated one note further each time
blocks = [cell.rotate(k).rebar("12/16") * 4 for k in range(12)]

# Glass additive process: 1, 1-2, 1-2-3, ... of the cell
def additive(cell):
    return M(*(cell[:n] for n in range(1, len(cell) + 1))).rebar("4/4")

# Reich beat-building: rests gradually replaced by notes, in the order you choose
def build(cell, order, n):
    on = set(order[:n])
    return cell.map_timed(lambda note, i, t: note if i in on else R * note.dur)
stages = [build(cell, [0, 4, 8, 2, 6, 10, 1, 5, 9, 3, 7, 11], n).rebar("12/16") * 4
          for n in range(1, 13)]
```

## Views

`badmidi piece.py VIEW [--bars 5-8] [--parts rh,lh]`

- **melody** (default): one line per part, bars in aligned columns, markings
  inline, bars labelled where the meter changes (and `[B]` where a section
  starts). Every row is valid string notation. `--collapse` replaces a run
  of bars identical to the one before (in every shown part) with
  `bars 12-19: same as 11`.
- **grid**: time down, parts across. `|` means still sounding, `.` silent;
  `--step e` adds a fixed grid. Each row ends with chord symbol, roman numeral
  (when the chord is tonal) and set class:
  `E+  II+  3-12 (048) augmented`. `--collapse` folds a bar whose rows repeat
  the bar before into one line, `-- bars 12-19: same as 11 ---`.
- **form**: one row per section (or per `--every 8` bars; 8 is the default
  when there are no sections): bars, parts playing (`all`, or which), onsets
  per beat, lowest-highest pitch, the pitch classes in play with their set
  class, dynamics in force (all parts, in time order), and what changed since
  the row above (`+m2`, `pcs +Gs -D`, `density 2.0->1.2`, `register lo +7`,
  `dyn p->f`). Use it first on a long piece.
- **check**: notation only. Errors: bar anchors, overlaps. Warnings: ranges,
  stray pedal lifts. Notes: an incomplete last bar, a hairpin that runs to the
  end, a loop that is engraved written out rather than as a repeat.
- **lens**: what the voices are doing (below). `--kinds susp,parallel` filters.
  Bars with exactly the observations of the bar before are folded into
  `-- bars 12-19: same as 11` by default; `--all` lists every one.
- **pdf / png / ly**: engraving (see the loop).
- **midi / wav / musicxml / all**. `musicxml` is for handing a score to a
  notation app (MuseScore, Dorico, Sibelius).

In Python these are `score.melody()`, `score.grid()`, `score.form()`,
`score.check()` and `score.lens()` (keywords `bars=(5, 8)`, `section="B"`,
`collapse=True/False`), and `score.observe()` returns the lens as `Observation`
objects with `.t`, `.where`, `.kind` and `.detail`.

## The lens

The lens describes and never prescribes. It names dissonances (seconds,
sevenths, tritones, a fourth above the bass) by how the dissonant note
moves:

| kind | |
|---|---|
| passing / neighbour | stepped into and out of, onward / back |
| appoggiatura | leapt into, stepped out of |
| escape tone | stepped into, leapt out of |
| anticipation | stepped into, then repeated |
| free dissonance | leapt into and out of |
| unresolved | nothing follows (a rest, the end) |
| suspension `m7->M6` | held into a strong beat, then down a step, with the figures |
| retardation | held, then up a step |
| held dissonance | held into a strong beat and not moved by step |
| accented … | the above, on a strong beat |
| parallel fifths / octaves, voices cross | the top of a part against the bottom of each part below it |

Use it to see what you made: whether the canon really lands its
suspensions, where the bass and soprano move in fifths, whether a
"dissonant" passage is all passing motion. Then choose. It applies no
style's rules and has no idea which ones you want.

Pitch-class sets work on pitches or integers:

```python
prime_form([C4, E4, Gs4])        # (0, 4, 8)   Rahn's algorithm
set_label([0, 4, 7, 6, 10, 1])   # '6-30 (013679) Petrushka'   Forte number, prime form, nickname
interval_vector([0, 1, 4, 6])    # (1, 1, 1, 1, 1, 1)
normal_order([9, 0, 4])          # (9, 0, 4)
```

## Stretto search

```python
found = stretti(subject, intervals=(12, 7, 5, -12), offsets=None, scale=None,
                meter=(4, 4), follower=None)
print(found)              # every offset × interval, with what the lens sees in the overlap
calm = [s for s in found if not s.count("parallel") and s.count("free") == 0]
calm[0].place(soprano, alto, 17)       # subject at bar 17 in the soprano, the copy in the alto
```

- offsets are in quarter notes; by default every beat while the voices overlap.
- with `scale=`, intervals are scale steps.
- `follower=lambda m: m.invert(scale=K)` searches for stretti of the inversion,
  and any transformation works.
- each result has `.offset`, `.interval`, `.leader`, `.follower`,
  `.observations`, `.summary()`, `.count(kind)` and `.place(a, b, bar, beat)`.

## Working with someone else's music

Often the music isn't yours: a person hands you a MIDI file from their DAW or
a MusicXML export from their notation app and asks for something ("add a
harmony part", "make section C more consonant"). There are two ways in.

**Import to a piece** when the Python becomes the working copy:

```
badmidi import song.mid -o song.py        # also .musicxml / .xml / .mxl
badmidi song.py check
```

The result is an ordinary piece file: a docstring with the importer's report,
`Score(...)`, the parts, and every part's music as bar-anchored strings, four
bars per `at()` (`--phrase 8` for more). Fill in the bar map in the docstring
once you know the form, name sections with `score.section()`, and pull ideas
out into named motifs as you understand them.

**Load at runtime** when the person's file stays the source of truth (they
keep editing it in their DAW and re-export it), and your work layers on top:

```python
from badmidi import *

score = load_midi("song.mid", key="D minor")      # or load_musicxml("song.musicxml")
mel = score["melody"]
harm = score.part("harmony", "viola")
harm.at(1, "...")                                 # a new part against theirs
mel.clear(17, 24).at(17, "...")                   # replace bars 17-24 of their part
```

`import_midi(path)` / `import_musicxml(path)` return `(score, report)`.
Every view works on the files directly too: `badmidi song.mid grid --bars 9-16`.

What the importer decides, and reports:
- **Quantizing** (`--quantize`, `quantize=`): `auto` (default) keeps any time
  already on a notated grid (32nds, triplets, quintuplets, sextuplets,
  septuplets) and snaps played timing per beat to sixteenths or eighth
  triplets. `none` refuses off-grid notes; `s`, `e3`, ... force one grid. The
  report says how many notes moved and by at most how much. A note too short
  for the grid is lengthened to one step, never dropped.
- **Voices**: a track's notes that start and end together are a chord;
  anything else overlapping goes to another line, `"piano 2"`, on the same
  staff (as `voice()` would). MusicXML voices and staves are kept as written.
- **Key**: `key=` if given, else the file's key signature, else an estimate
  (the report says which). Pitches are spelled by the key unless the file
  spells them (MusicXML).
- **Instruments**: by General MIDI program; an instrument badmidi doesn't
  know gets the nearest sound of its family, with its range widened to the
  notes it plays. Drum tracks are skipped.
- **Tempo**: tempo events become `tempo_mark`s; a run of small steps in one
  direction becomes one `rit`/`accel`. Markers become sections A, B, ...
- MIDI says nothing of dynamics, articulation, spelling or additive meter
  groupings; MusicXML does, and they come through.

Hand the result back as `badmidi piece.py musicxml` (for a notation app) or
`midi` (for a DAW). Say what changed, by bar and part.

`to_source(score)` turns any Score into piece source (it's what `import`
writes); `Source`, `SourceTrack` and `SourceNote` are the format-neutral
input `build_score(src)` takes, for feeding music from anywhere else.

### Recipes

**Add a harmony part.** `form` for the shape, `grid` over the melody to see
what's implied (the chord column is the existing harmony; empty rows are
yours to decide), write the new part, then
`lens --parts melody,harmony` to see how the two lines meet, and `grid` again
for the result.

**Make section C more consonant.** `form` (is C where they think it is? if
not, ask), `grid --section C` and `lens --section C` to find what makes it
dissonant (set classes, sevenths and seconds named by how they move). Change
those notes, in the piece or by `clear()` and re-placing in layered mode,
then rerun `grid`/`lens` on the same bars and report before and after in
their terms ("bars 33-34: the free sevenths in the alto now resolve down").

**Revise one part only.** `melody --parts viola --bars 17-24` gives the bars as
pasteable strings; edit them, place them back at the same bar, and check that
the other parts are untouched (`melody --parts` the rest, before and after).

## Things that bite

- **Miscounting a bar** is the usual error, and no tool can prevent it. Put
  `|` in every string and `|N` at section ends, and `check` reports each
  miscount once with the fix:
  "bar 5 has 8 beats, expected 7 beats: an eighth (.e) too long (the barline
  written at 6:2 should be at 6:1)". Beats are the meter's own (eighths in
  7/8), and a free bar's beats are quarters.
- `retrograde()` drops dynamics, hairpins, pedal and text, because they have
  no meaningful reverse. Put them back with `mark()`.
- **Restructuring drops barlines.** `rotate`, `restructure` and `from_events`
  return unbarred music (an old `|` would sit in the wrong place); finish with
  `rebar(meter)` or `expect(bars=N)`. A tie whose partner moved away is dropped.
- **Drift is heard, not seen.** `check` notes it, but `grid` and `lens` show
  written time, where the drifting part still lines up with the others.
- `invert(around=...)` needs a pitch for its axis. To mirror around the point
  between two notes, invert around one and transpose (see Spelling).

- **A loop engraves as a repeat only if every part agrees on the span.** One
  part carrying on with something else while another loops, a dynamic or
  tempo change in the middle of the span, or a pass that isn't whole bars
  gives written-out engraving. That is a `check` note, not an error; the
  piece plays and shows identically either way. Put markings at the first beat
  of a loop, or between loops.
- `loop()` counts bars in full: `loop(5, one_bar, times=8)` ends at bar 12,
  and the next thing goes at bar 13. A `|N` anchor inside the material is
  rejected.
- Bar numbers in a collapsed view still name the real bars: "bars 12-19:
  same as 11" means those bars repeat bar 11's content.
- **Imported MIDI is a guess at the notation.** Read the report: notes moved
  by quantizing, an estimated key, a track split into several lines. A
  played performance without a tempo map comes out in whatever bars the DAW
  assumed; an upbeat sits in bar 1 after rests. Fix the reading before
  composing against it.
- `clear()` rebuilds the part's remaining music without its `|` anchors, so
  `check` can no longer catch a miscount in what was already there (what you
  place afterwards is checked as usual).

## Adding an example

Examples in `examples/` are part of the test suite. Each must define
`score`, pass `check` with no errors, engrave and verify, and survive a
round trip through the melody view. Start it with a docstring that lists
what happens in which bars, and the commands worth running. Only the `.py`
goes in git: `.pdf`, `.mid` and `.wav` are git-ignored and regenerated on
demand; delete any `png` pages you made to look at. Run
`python -m unittest discover tests`.

| example | shows |
|---|---|
| `chorale.py` | four voices lined up bar by bar in strings; read it with `grid` |
| `round.py` | one motif at staggered entries; an augmented canon voice |
| `theme_and_answer.py` | a quartet developed from one four-note idea by transformation |
| `prelude.py` | piano: figuration functions, pedal, dynamics, tempo changes |
| `funk_chaconne.py` | organ: a ground bass sequenced into variations, a fugue, registration |
| `hexachord_fantasia.py` | free-bass accordion: cantus firmus, canon at the 7th, a tritone-answer ricercar with stretto entries mid-bar, divisions on a ground, set-class harmony |
| `bent_chaconne.py` | violin and two cellos: a ground drifting against itself by isorhythm, a 7/8 variation, a mirror variation by inversion, a mensuration canon of the ground, a free-bar cadenza |
| `phase_study.py` | two marimbas in 12/16: sections, `loop()` engraved as ×n repeats, a 12:11 tuplet slip bar, then a passage in unison on the page with a playback `drift` out and back; try `form`, `lens`, `grid --collapse` |
| `wandering_ricercar.py` | clarinet, tenor and baritone sax: modal imitation chosen with `stretti`, generated fauxbourdon in several modes, a galliard on chromatic-mediant chords, additive meters and hemiola throughout |
| `chromatic_fugue.py` | six-voice fugue for winds and strings: a lament-tetrachord subject, tonal answer, a countersubject in two shapes |
| `ember_chaconne.py` | string quartet: a descending-tetrachord ground varied eight times, built up to a climax and a Picardy close |
| `mirror_chaconne.py` | string quartet: a chromatic ground read upright, inverted, backwards and against itself; invertible counterpoint |
| `woven_chaconne.py` | string quartet: a fixed harmony woven from interlocking rhythms (hemiola and other cross-rhythms) |

## Where things live

```
badmidi/core.py      Pitch, Chord, Note, R, Bar, Mark, Event, Motif and its transformations
                     (restructure, rotate, rebar, expect),
                     the string parser, duration codes, isorhythm
badmidi/scale.py     key(), Scale: diatonic steps, signatures, spelling, degrees
badmidi/notes.py     C0..G9 constants
badmidi/score.py     Score, Part (incl. drift), Meter, the instrument table, time and meter maps
badmidi/views.py     melody, grid, form, check, lens; chord naming
badmidi/analysis.py  observe() (the lens), pitch-class sets, stretti()
badmidi/perform.py   markings -> playback: dynamics, hairpins, accents, tempo map, pedal, per-part drift clock
badmidi/midi.py      Standard MIDI File writer and reader (read_midi -> Source)
badmidi/ingest.py    Source/SourceTrack/SourceNote, build_score: quantize, voices, key, instruments; load_midi
badmidi/musicxml.py  MusicXML writer and reader (load_musicxml)
badmidi/source.py    to_source: any Score -> piece source (what `badmidi import` writes)
badmidi/lilypond.py  LilyPond export, rendering, and verification against LilyPond's MIDI
badmidi/loops.py     which Part.loop() spans can be engraved as repeats
badmidi/render.py    wav through fluidsynth
badmidi/cli.py       the badmidi command
```

What's printed and what's played are separate. Changing `perform.py`
(velocities, ramps, staccato length, fermata holds, pedal timing) never
changes the score.
