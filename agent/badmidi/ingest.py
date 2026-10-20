"""Importing human music: a format-neutral Source and build_score().

A reader (MIDI today, MusicXML or a DAW adapter later) turns a file into a
`Source`: tracks of notes at exact times in quarter notes, plus meters,
tempos, key and markers. `build_score` turns that into a badmidi Score that
passes `check`: it quantizes performed timing, separates overlapping notes
into voices, ties notes across barlines, picks instruments and a key, and
places everything phrase by phrase at explicit bar anchors, ready to be
studied with the usual views or transformed like any composed material.
It describes what it did in an ImportReport.
"""
from __future__ import annotations

import math
import os
import re
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from fractions import Fraction

from .core import LETTERS, Mark, Motif, Note, Pitch, duration
from .scale import Scale, key as parse_key
from .score import INSTRUMENTS, Meter, Score

# --- the interchange format ----------------------------------------------------


@dataclass
class SourceNote:
    onset: Fraction
    dur: Fraction
    midi: int
    velocity: int = 80
    spell: str | None = None    # "F#4" / "Bb3" when the format knows the spelling
    voice: int | None = None    # when the format knows it
    tie: bool = False           # tied into the next note of the same pitch
    art: str = ""               # badmidi articulation characters: > ^ ' _ @


@dataclass
class SourceTrack:
    name: str
    program: int | None
    notes: list[SourceNote] = field(default_factory=list)
    marks: list[tuple[Fraction, Mark]] = field(default_factory=list)   # dynamics, hairpins, pedal, text
    staff_group: str | None = None      # tracks sharing a staff_group become a braced group (piano rh/lh)
    channel: int | None = None          # MIDI channel if known (9 = GM drums)
    clef: str | None = None             # badmidi clef name when the format says: "treble", '"treble_8"', ...


@dataclass
class Source:
    """What a file says, in quarter notes (exact Fractions)."""
    title: str = ""
    tracks: list[SourceTrack] = field(default_factory=list)
    meters: list[tuple[Fraction, int | str, int]] = field(default_factory=list)   # (time, num, den); num "2+2+3" is additive
    tempos: list[tuple[Fraction, float]] = field(default_factory=list)      # (time, quarter notes per minute)
    key: Scale | None = None
    markers: list[tuple[Fraction, str]] = field(default_factory=list)       # rehearsal marks / sections
    tempo_texts: list[tuple[Fraction, str]] = field(default_factory=list)   # "Allegro agitato" at a time
    ramps: list[tuple[Fraction, Fraction, float, str]] = field(default_factory=list)   # rit./accel.: start, end, to_bpm, text
    notes: list[str] = field(default_factory=list)      # what the reader skipped or could not keep, for the report
    exact: bool = False     # times are notated (MusicXML), not performed: auto-quantizing only cleans rounding


# --- the report ------------------------------------------------------------------


@dataclass
class ImportReport:
    """What build_score decided, one fact per line in str(report)."""
    parts: list[tuple[str, list[str]]] = field(default_factory=list)   # (track name, part names)
    lines: dict[str, int] = field(default_factory=dict)                # track name -> voices it split into
    key: str = ""
    key_source: str = ""                  # "from file", "given" or "estimated"
    quantize: str = "auto"
    notes_total: int = 0
    notes_moved: int = 0
    max_move: Fraction = Fraction(0)      # largest movement, in quarter notes
    dropped: dict[str, int] = field(default_factory=dict)
    lengthened: int = 0                   # notes that snapped to zero length, given one grid step
    skipped: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def max_move_text(self) -> str:
        for limit, name in ((Fraction(1, 8), "a 32nd"), (Fraction(1, 4), "a sixteenth"),
                            (Fraction(1, 2), "an eighth"), (Fraction(1), "a quarter")):
            if self.max_move <= limit:
                return name
        return f"{float(self.max_move):g} quarters"

    def __str__(self) -> str:
        out = []
        for track, names in self.parts:
            n = self.lines.get(track, 1)
            more = f" (overlapping notes split into {n} lines)" if n > 1 else ""
            out.append(f"{track} -> {', '.join(names)}{more}")
        if self.key:
            out.append(f"key: {self.key} ({self.key_source})")
        if self.notes_moved:
            out.append(f"quantize: {self.notes_moved} of {self.notes_total} notes moved, "
                       f"at most {self.max_move_text}")
        else:
            out.append(f"quantize: all {self.notes_total} notes already on the grid")
        out += [f"dropped: {n} {what}" for what, n in self.dropped.items() if n]
        if self.lengthened:
            out.append(f"lengthened: {self.lengthened} notes shorter than the grid")
        out += [f"skipped: {s}" for s in self.skipped]
        out += self.notes
        return "\n".join(out)


# --- quantizing ----------------------------------------------------------------


# Positions notation really writes: halves to 32nds, triplets, quintuplets,
# septuplets (within a tick: 1/7 is not a whole number of ticks) and halves.
_DENOMINATORS = (1, 2, 3, 4, 5, 6, 7, 8, 10, 12)
_TICK = Fraction(1, 960)


def _on_grid(t: Fraction) -> Fraction | None:
    """t as an exact position on one of those grids, tolerating one tick of
    rounding in the file; None if it sits between grid points."""
    for d in _DENOMINATORS:
        c = Fraction(round(t * d), d)
        if abs(t - c) <= _TICK:
            return c
    return None


def _fine(t: Fraction) -> bool:
    return _on_grid(t) is not None


def _nearest(t: Fraction, g: Fraction) -> Fraction:
    return round(t / g) * g


class _Quantizer:
    """Snaps times to a grid. "auto" leaves times already on a notated grid
    (see _on_grid: 32nds, triplets, quintuplets, sextuplets) alone and moves the rest, beat by beat, to the
    sixteenth grid or the eighth-triplet grid, whichever sits closer to
    everything in that beat. A duration code (s, e, e3, s3) or a number of
    quarters forces one grid; "none" never moves anything."""

    def __init__(self, mode, times):
        self.mode, self.fixed, self.beat_grid = mode, None, {}
        if mode == "auto":
            by_beat = defaultdict(list)
            for t in times:
                by_beat[math.floor(t)].append(t)
            for b, ts in by_beat.items():
                if all(_fine(t) for t in ts):
                    continue
                err = {g: sum(abs(t - _nearest(t, g)) for t in ts) for g in (Fraction(1, 4), Fraction(1, 3))}
                self.beat_grid[b] = Fraction(1, 3) if err[Fraction(1, 3)] < err[Fraction(1, 4)] else Fraction(1, 4)
        elif mode not in ("none", "notated"):
            self.fixed = duration(mode) if isinstance(mode, str) else Fraction(mode)
            if self.fixed <= 0:
                raise ValueError("quantize grid must be positive")

    def step(self, t: Fraction) -> Fraction:
        """The smallest step of the grid in force at t."""
        return self.fixed or self.beat_grid.get(math.floor(t), Fraction(1, 4))

    def __call__(self, t: Fraction) -> Fraction:
        if self.fixed:
            return _nearest(t, self.fixed)
        if self.mode == "none":
            return t
        c = _on_grid(t)
        if c is not None:
            return c
        if self.mode == "notated":      # off every grid but exact (a 12:11 tuplet): leave it
            return t
        return _nearest(t, self.beat_grid[math.floor(t)])


# --- key -----------------------------------------------------------------------

_KS_MAJOR = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
_KS_MINOR = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
_MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
_MINOR_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]


def _correlation(a, b) -> float:
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    den = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return num / den if den else 0.0


def estimate_key(weights: list[float]) -> Scale:
    """Krumhansl-Schmuckler: the major or minor key whose profile best
    correlates with a 12-entry (duration-weighted) pitch-class histogram."""
    if not any(weights):
        return parse_key("C major")
    best = max(((_correlation([weights[(tonic + i) % 12] for i in range(12)], prof), tonic, minor)
                for minor, prof in ((False, _KS_MAJOR), (True, _KS_MINOR)) for tonic in range(12)),
               key=lambda x: x[0])
    _, tonic, minor = best
    return parse_key(f"{(_MINOR_NAMES if minor else _MAJOR_NAMES)[tonic]} {'minor' if minor else 'major'}")


# --- instruments and names -----------------------------------------------------


def instrument_for(program: int | None, name: str = "") -> str:
    """The INSTRUMENTS entry for a GM program: the track's own name if it is
    one with that program, else the first with exactly that program, else the first in the same family of eight, else piano. With no
    program, a track named like an instrument gets it."""
    if program is None:
        return name if name in INSTRUMENTS else "piano"
    if name in INSTRUMENTS and INSTRUMENTS[name][0] == program:    # "alto" over "choir"
        return name
    for inst, (prog, _, _) in INSTRUMENTS.items():
        if prog == program:
            return inst
    return next((inst for inst, (prog, _, _) in INSTRUMENTS.items() if prog // 8 == program // 8), "piano")


def _clean_name(name: str) -> str:
    return " ".join(re.sub(r"[^\w .'-]", " ", name).lower().split())


def _unique(name: str, taken: set[str]) -> str:
    out, k = name, 2
    while out in taken:
        out, k = f"{name} {k}", k + 1
    taken.add(out)
    return out


def _pitch(n: "_N") -> Pitch:
    """The pitch, spelled as the source spelled it when that agrees with the key number."""
    m = re.fullmatch(r"([A-Ga-g])([#sb]{0,2})(-?\d+)?", n.spell or "")
    if m:
        letter, acc = m[1].upper(), m[2].replace("s", "#")
        if (LETTERS[letter] + acc.count("#") - acc.count("b")) % 12 == n.midi % 12:
            return Pitch(n.midi, letter + acc)
    return Pitch(n.midi)


# --- notes in flight -----------------------------------------------------------


class _N:
    """A note being cleaned up: exact times, then quantized times."""
    __slots__ = ("onset", "end", "midi", "spell", "voice", "tie", "art")

    def __init__(self, s: SourceNote):
        self.onset, self.end = Fraction(s.onset), Fraction(s.onset) + Fraction(s.dur)
        self.midi, self.spell, self.voice, self.tie, self.art = s.midi, s.spell, s.voice, s.tie, s.art


def _merge_ties(notes: list[_N]) -> list[_N]:
    """A note tied into the next one of its pitch becomes one longer note."""
    out, open_ = [], {}
    for n in sorted(notes, key=lambda n: (n.onset, n.midi)):
        prev = open_.pop(n.midi, None)
        if prev is not None and prev.end == n.onset:
            prev.end, prev.tie = n.end, n.tie
            n = prev
        else:
            out.append(n)
        if n.tie:
            open_[n.midi] = n
    return out


@dataclass
class _Item:
    """A chord (or single note): notes with the same onset, length and voice."""
    onset: Fraction
    end: Fraction
    notes: list
    voice: int | None

    @property
    def art(self) -> str:
        return "".join(sorted({c for n in self.notes for c in n.art}))

    @property
    def mean(self) -> float:
        return sum(n.midi for n in self.notes) / len(self.notes)


def _lines(items: list[_Item]) -> list[list[_Item]]:
    """Share items out between monophonic lines. With voices known, each voice
    is a line (more lines for the voice if it overlaps itself). Otherwise
    each item goes to the lowest line that is free and whose last pitch is
    within an octave, else the nearest-pitched free line, else a new line."""
    voices = sorted({i.voice for i in items if i.voice is not None})
    lines: list[dict] = []
    for it in sorted(items, key=lambda i: (i.onset, -max(n.midi for n in i.notes))):
        if voices:
            v = it.voice if it.voice is not None else voices[0]
            free = [l for l in lines if l["voice"] == v and l["end"] <= it.onset]
            line = free[0] if free else None
            tag = v
        else:
            free = [l for l in lines if l["end"] <= it.onset]
            near = [l for l in free if abs(l["pitch"] - it.mean) <= 12]
            line = near[0] if near else min(free, key=lambda l: abs(l["pitch"] - it.mean), default=None)
            tag = None
        if line is None:
            line = dict(voice=tag, end=it.onset, pitch=it.mean, items=[])
            lines.append(line)
        line["items"].append(it)
        line["end"], line["pitch"] = it.end, it.mean
    if voices:
        lines.sort(key=lambda l: l["voice"])
    return [l["items"] for l in lines]


# --- build_score ---------------------------------------------------------------


def build_score(src: Source, quantize="auto", key=None, phrase: int = 4) -> tuple[Score, ImportReport]:
    """A Score from a Source, plus a report of what was decided.

    quantize: "auto" (leave 32nd and sixteenth-triplet timing alone, snap the
        rest per beat to sixteenths or eighth triplets), "none" (error on the
        first off-grid note), or a grid: a duration code ("s", "e", "e3",
        "s3") or a number of quarters.
    key: a key name or Scale; a key given here wins over the file's, which
        wins over an estimate (Krumhansl-Schmuckler).
    phrase: bars per placement (part.at call) in the finished score."""
    exact = src.exact and quantize == "auto"
    rep = ImportReport(quantize="notated times" if exact else str(quantize), notes=list(src.notes))
    tracks: list[tuple[SourceTrack, list[_N]]] = []
    for tr in src.tracks:
        if tr.channel == 9:
            rep.skipped.append(f"drum track {tr.name!r} ({len(tr.notes)} notes)")
        elif tr.notes:
            ns = _merge_ties([_N(s) for s in tr.notes if s.dur > 0 and 0 <= s.midi < 128])
            tracks.append((tr, ns))

    # key
    weights = [0.0] * 12
    for _, ns in tracks:
        for n in ns:
            weights[n.midi % 12] += float(n.end - n.onset)
    if key is not None:
        scale, rep.key_source = parse_key(key), "given"
    elif src.key is not None:
        scale, rep.key_source = src.key, "from file"
    else:
        scale, rep.key_source = estimate_key(weights), "estimated"
    rep.key = scale.name

    # meter, tempo
    meters = sorted(src.meters, key=lambda m: m[0])
    first = meters[0] if meters else (Fraction(0), 4, 4)
    tempos = sorted(src.tempos, key=lambda m: m[0])
    texts = sorted(src.tempo_texts)
    score = Score(src.title, meter=Meter.parse(f"{first[1]}/{first[2]}"), key=scale,
                  tempo=(tempos[0][1] if src.exact else round(tempos[0][1])) if tempos else 100,
                  tempo_text=next((x for t, x in texts if t == 0), None))
    for t, num, den in meters[1:] if first[0] == 0 else meters:
        bar, beat = score.position(t)
        if beat != 1:
            bar += 1
            rep.notes.append(f"meter {num}/{den} at {score.where(t)} is not on a barline; moved to bar {bar}")
        if Meter.parse(f"{num}/{den}") != score.meter_at(bar):
            score.meter_change(bar, f"{num}/{den}")
    _tempo_changes(score, tempos, rep, src.ramps if src.exact else None)
    for t0, t1, to, label in src.ramps:
        score.rit(score.position(t0), score.position(t1), to=to, text=label or None)
    for t, label in texts:
        if t == 0:
            continue
        mark = next((m for m in score.tempo_marks if m.start == t and not m.gradual and not m.text), None)
        if mark:
            mark.text = label
        else:
            score.tempo_mark(score.position(t), label)
    labels = iter(chr(65 + i) if i < 26 else f"S{i + 1}" for i in range(10_000))
    for t, text in sorted(src.markers):
        bar, _ = score.position(t)
        if t - score.bar_start(bar) > score.bar_start(bar + 1) - t:
            bar += 1
        if not any(s.bar == bar for s in score.sections):
            score.section(bar, next(labels), text)

    # quantize
    marks_of = {id(tr): [(t, m) for t, m in tr.marks] for tr, _ in tracks}
    times = [t for ns in (ns for _, ns in tracks) for n in ns for t in (n.onset, n.end)]
    times += [t for ms in marks_of.values() for t, _ in ms]
    snap = _Quantizer("notated" if exact else quantize, times)
    if quantize == "none" and not src.exact:
        off = min(((n.onset if not _fine(n.onset) else n.end, n) for _, ns in tracks for n in ns
                   if not (_fine(n.onset) and _fine(n.end))), key=lambda x: x[0], default=None)
        if off:
            t, n = off
            raise ValueError(f"note {Pitch(n.midi).name} at {score.where(t)} is off the grid "
                             f"(quantize='none'); use quantize='auto' or a grid such as 's'")
    for tr, ns in tracks:
        kept = []
        for n in ns:
            on, end = snap(n.onset), snap(n.end)
            rep.notes_total += 1
            if end <= on:
                end = on + snap.step(on)
                rep.lengthened += 1
            move = max(abs(on - n.onset), abs(end - n.end))
            if move > _TICK:
                rep.notes_moved += 1
                rep.max_move = max(rep.max_move, move)
            n.onset, n.end = on, end
            kept.append(n)
        ns[:] = kept
        by_pitch = defaultdict(list)
        for n in sorted(ns, key=lambda n: (n.onset, -n.end)):
            by_pitch[n.midi].append(n)
        for same in by_pitch.values():                    # a note can't overlap itself
            prev = None
            for n in same:
                if prev and n.onset < prev.end:
                    if n.onset == prev.onset:
                        n.end = n.onset
                        rep.dropped["duplicate notes"] = rep.dropped.get("duplicate notes", 0) + 1
                        continue
                    prev.end = n.onset
                prev = n
        ns[:] = [n for n in ns if n.end > n.onset]
        marks_of[id(tr)] = [(snap(t), m) for t, m in marks_of[id(tr)]]

    # lines
    built = []     # (track, [[(onset, Note)...] per line], marks)
    end_t = Fraction(0)
    for tr, ns in tracks:
        chords = defaultdict(list)
        for n in ns:
            chords[(n.onset, n.end, n.voice)].append(n)
        items = [_Item(on, end, sorted(g, key=lambda n: n.midi), v) for (on, end, v), g in chords.items()]
        lines = _lines(items)
        if lines:
            end_t = max(end_t, *(i.end for l in lines for i in l))
            built.append((tr, lines))
    bar, beat = score.position(end_t)
    nbars = max(1, bar - 1 if beat == 1 else bar)

    taken: set[str] = set()
    for i, (tr, lines) in enumerate(built, 1):
        name = _unique(_clean_name(tr.name) or f"track {i}", taken)
        inst = instrument_for(tr.program, name)
        main_pitches = [n.midi for it in lines[0] for n in it.notes]
        clef = tr.clef or (("bass" if statistics.median(main_pitches) < 60 else "treble") if tr.staff_group else None)
        rng = None
        if tr.program is not None and INSTRUMENTS[inst][0] != tr.program:
            # a stand-in for an instrument badmidi doesn't know: don't warn about the player's own notes
            played = [n.midi for line in lines for it in line for n in it.notes]
            _, lo, hi = INSTRUMENTS[inst]
            rng = (Pitch(min(lo, *played)), Pitch(max(hi, *played)))
        main = score.part(name, inst, program=tr.program, group=tr.staff_group, clef=clef,
                          channel=tr.staff_group, range=rng)
        parts = [main] + [main.voice(_unique(f"{name} {k}", taken)) for k in range(2, len(lines) + 1)]
        for k, (part, line) in enumerate(zip(parts, lines)):
            _place(score, part, line, marks_of[id(tr)] if k == 0 else [], nbars, phrase)
        rep.parts.append((tr.name or name, [p.name for p in parts]))
        rep.lines[tr.name or name] = len(parts)
    return score, rep


def _tempo_changes(score: Score, tempos: list[tuple[Fraction, float]], rep: ImportReport,
                   ramps: list | None = None) -> None:
    """Tempo events as tempo marks; a run of three or more small steps two beats
    or less apart, all one way, is a ramp and becomes one rit. or accel. A
    notated source (ramps is a list) says where its ramps are, so each change is just a mark,
    unless it repeats the tempo a ramp arrived at."""
    if not tempos:
        return
    if ramps is not None:
        last, arrivals = tempos[0][1], sorted((e, to) for _, e, to, _ in ramps)
        for t, bpm in tempos[1:]:
            while arrivals and arrivals[0][0] <= t:
                last = arrivals.pop(0)[1]
            if bpm != last:
                score.tempo_mark(score.position(t), bpm=bpm)
                last = bpm
        return
    steps, last = [], round(tempos[0][1])
    for t, bpm in tempos[1:]:
        if abs(round(bpm) - last) >= 1:
            steps.append((_nearest(t, Fraction(1, 16)), round(bpm), round(bpm) - last))
            last = round(bpm)
    i = 0
    while i < len(steps):
        j = i
        while (j + 1 < len(steps) and steps[j + 1][0] - steps[j][0] <= 2
               and (steps[j + 1][2] > 0) == (steps[i][2] > 0)):
            j += 1
        if j - i >= 2:
            ramp = score.accel if steps[i][2] > 0 else score.rit
            ramp(score.position(steps[i][0]), score.position(steps[j][0]), to=steps[j][1])
            rep.notes.append(f"tempo: {j - i + 1} steps from {score.where(steps[i][0])} read as "
                             f"{'accel.' if steps[i][2] > 0 else 'rit.'} to {steps[j][1]}")
        else:
            for t, bpm, _ in steps[i:j + 1]:
                score.tempo_mark(score.position(t), bpm=bpm)
        i = j + 1


def _place(score: Score, part, line: list[_Item], marks: list[tuple[Fraction, Mark]],
           nbars: int, phrase: int) -> None:
    """Put a line on its part, phrase by phrase. It is laid on the part at
    exact times first so views._bar_cells can split notes at barlines (tying
    them) and write the tokens; each phrase's tokens are then placed with bar
    anchors. Marks sit in time like notes, so a note or gap a mark falls
    inside is cut there (tied, or as explicit rests) to keep the mark at its
    own moment."""
    from .views import _bar_cells
    starts = score.barlines(nbars)
    mt = sorted({t for t, _ in marks})

    def rests(a: Fraction, b: Fraction) -> None:
        cuts = [a] + sorted({x for x in mt + starts if a < x < b}) + [b]
        if len(cuts) > 2 and any(a < x < b for x in mt):
            for x, y in zip(cuts, cuts[1:]):
                part._place(x, [Motif(Note((), y - x))])
    at = Fraction(0)
    for it in line:
        rests(at, it.onset)
        cuts = [it.onset] + [x for x in mt if it.onset < x < it.end] + [it.end]
        pitches = [_pitch(n) for n in it.notes]
        for x, y in zip(cuts, cuts[1:]):
            part._place(x, [Motif(Note(pitches, y - x, tied=y != it.end, art=it.art if x == it.onset else ""))])
        at = it.end
    if marks:
        rests(at, starts[-1])
    for t, m in marks:
        part._place(t, [Motif(m)])
    cells = _bar_cells(score, part, nbars)
    part.placements, part._last_end = [], Fraction(0)
    for first in range(1, nbars + 1, phrase):
        chunk = cells[first - 1:first - 1 + phrase]
        if all(tok.startswith("R") for cell in chunk for tok in cell):
            continue
        part.at(first, " | ".join(" ".join(cell) for cell in chunk) + f" |{first + len(chunk)}")


def score_from_source(src: Source, **kw) -> Score:
    """build_score without the report."""
    return build_score(src, **kw)[0]


def import_midi(path: str, **kw) -> tuple[Score, ImportReport]:
    """A MIDI file as a Score and its report; keywords as for build_score."""
    from .midi import read_midi
    with open(path, "rb") as f:
        data = f.read()
    return build_score(read_midi(data, os.path.splitext(os.path.basename(path))[0]), **kw)


def load_midi(path: str, **kw) -> Score:
    """A MIDI file as a Score: load_midi("tune.mid", key="D minor")."""
    return import_midi(path, **kw)[0]
