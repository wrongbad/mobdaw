"""MusicXML exchange: export a score as MusicXML 4.0 (partwise) for notation
apps and DAWs.

Writing. Notes are split at barlines (and into printable values) with ties,
exactly as in the LilyPond export, whose helpers do the splitting. Staves
sharing a `group` (a piano's hands, an organ's manuals and pedal) are one
MusicXML part with several staves; parts sharing a `staff` are voices on it.
Markings are directions at their time within the measure, interleaved in the
first voice or displaced with <offset>. Loops are written out.

Reading (`read_musicxml`, `import_musicxml`, `load_musicxml`): a partwise
document, or a compressed .mxl, becomes an ingest.Source with exact times,
spelling, voices, staves, ties, articulations, dynamics, hairpins, pedal,
words, tempo, rehearsal marks, meters and key. What badmidi has no place for
(grace notes, lyrics, slurs, ornaments, percussion, repeats) is skipped and
counted in the report.
"""
from __future__ import annotations

import bisect
import io
import math
import os
import re
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from dataclasses import dataclass
from fractions import Fraction

from .core import (CRESC, DIM, DYNAMICS, HAIRPIN_END, PED, PED_UP, Mark, dyn, octave_of, pc_name, spelling,
                   text as words_mark, tuplet_space)
from .lilypond import NORMAL, _clef, _split
from .score import Part, Score

DOCTYPE = ('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
           '"http://www.musicxml.org/dtds/partwise.dtd">')
TYPES = {"1": "whole", "2": "half", "4": "quarter", "8": "eighth", "16": "16th", "32": "32nd"}
ARTICULATION = {">": "accent", "^": "strong-accent", "'": "staccato", "_": "tenuto"}
ACCIDENTAL = {2: "double-sharp", 1: "sharp", 0: "natural", -1: "flat", -2: "flat-flat"}
MODES = {"major": "major", "minor": "minor", "harmonic minor": "minor", "melodic minor": "minor",
         "dorian": "dorian", "phrygian": "phrygian", "lydian": "lydian",
         "mixolydian": "mixolydian", "locrian": "locrian"}
CLEFS = {"treble": ("G", 2, 0), "bass": ("F", 4, 0), "alto": ("C", 3, 0), "tenor": ("C", 4, 0),
         "treble_8": ("G", 2, -1), "treble^8": ("G", 2, 1), "bass_8": ("F", 4, -1), "bass^8": ("F", 4, 1)}
SHARP_ORDER = "FCGDAEB"
# direction ranks at one moment: hairpins end, then dynamics and words, then hairpins and pedal begin
STOP, WORDS, START, PEDAL = 0, 1, 2, 3


# --- the pieces of a voice -----------------------------------------------------


class _Piece:
    """One printable note, chord or rest of a voice in one bar: a length that
    is a single written value (under one tuplet ratio), its onset in the bar,
    and what ties and brackets it carries."""
    __slots__ = ("kind", "heads", "v", "onset", "type", "dots", "tup", "tie_start", "tie_stop",
                 "arts", "fermata", "tstart", "tstop", "acc", "midis")

    def __init__(self, kind, v, onset, ly=None, tup=None, heads=(), midis=()):
        self.kind, self.v, self.onset, self.tup = kind, v, onset, tup
        self.heads, self.midis = list(heads), tuple(midis)
        self.tie_start = self.tie_stop = self.fermata = self.tstart = self.tstop = False
        self.arts, self.acc = "", []
        self.type, self.dots = _written(ly, v) if ly else (None, 0)


def _written(ly: str, v: Fraction) -> tuple[str, int]:
    """(type, dots) of a LilyPond duration like '4.'; a length _split could not
    write as tied values (its '4*n/d' fallback) gets the nearest value below,
    the <duration> carrying the truth."""
    if "*" not in ly:
        return TYPES[ly.rstrip(".")], ly.count(".")
    best = max((d for d in NORMAL if d <= v), default=min(NORMAL))
    return _written(NORMAL[best], best)


def _head(p) -> tuple[str, int, int, int]:
    """(step, alter, octave, midi) of a pitch as it is spelled (inside `spelling`)."""
    name = p.spell or pc_name(p.pc)
    return name[0], name.count("#") - name.count("b"), octave_of(p.midi, name), p.midi


def _voice_pieces(score: Score, part: Part, starts: list[Fraction], primary: bool) -> list[list[_Piece]]:
    """The voice's pieces bar by bar, laid out as lilypond._voice does. Gaps
    are rests in a staff's first voice (a silent bar is a measure rest) and
    simply absent in the others, which get <forward> when written."""
    nbars, total = len(starts) - 1, starts[-1]
    timeline: list[tuple[Fraction, Fraction, object]] = []
    cur = Fraction(0)
    for t, n in part.events(merge_ties=False):
        if t > cur:
            timeline.append((cur, t - cur, None))
        timeline.append((t, n.dur, n))
        cur = max(cur, t + n.dur)
    if cur < total:
        timeline.append((cur, total - cur, None))

    bars: list[list[_Piece]] = [[] for _ in range(nbars)]
    for start, dur, note in timeline:
        s, left = start, dur
        while left > 0:
            b = bisect.bisect_right(starts, s) - 1
            if b >= nbars:
                break
            seg = min(left, starts[b + 1] - s)
            at = s - starts[b]
            if note is None:
                if primary and seg == starts[b + 1] - starts[b]:
                    bars[b].append(_Piece("mrest", seg, at))
                elif primary:
                    for v, ly, tup in _split(seg, None):
                        bars[b].append(_Piece("rest", v, at, ly, tup))
                        at += v
            else:
                pieces = _split(seg, note.tuplet)
                for i, (v, ly, tup) in enumerate(pieces):
                    first, last = s == start and i == 0, seg == left and i == len(pieces) - 1
                    if note.is_rest:
                        p = _Piece("rest", v, at, ly, tup)
                    else:
                        p = _Piece("note", v, at, ly, tup, [_head(q) for q in note.pitches],
                                   [q.midi for q in note.pitches])
                        p.tie_start = not last or note.tied
                        p.arts = "".join(c for c in note.art if c != "@" and first)
                    p.fermata = "@" in note.art and last
                    bars[b].append(p)
                    at += v
            s += seg
            left -= seg
    _resolve_ties(bars, starts)
    for bar in bars:
        _bracket_tuplets(bar)
    return bars


def _resolve_ties(bars: list[list[_Piece]], starts: list[Fraction]) -> None:
    """A tie needs a same-pitched note right after it: stop it there, and drop
    a start that has no partner (events() would not have merged it either)."""
    flat = [(starts[b] + p.onset, p) for b, bar in enumerate(bars) for p in bar]
    for i, (t, p) in enumerate(flat):
        if not p.tie_start:
            continue
        nxt = flat[i + 1][1] if i + 1 < len(flat) and flat[i + 1][0] == t + p.v else None
        if nxt is not None and nxt.kind == "note" and nxt.midis == p.midis:
            nxt.tie_stop = True
        else:
            p.tie_start = False


def _bracket_tuplets(bar: list[_Piece]) -> None:
    """Mark where tuplet brackets start and stop: one per beat's worth (or per
    n equal notes), never one across a whole run; same rule as the engraving."""
    run: list[_Piece] = []
    kind, held, first_len = None, Fraction(0), None

    def close():
        nonlocal run, held, first_len
        if run:
            run[0].tstart = True
            run[-1].tstop = True
        run, held, first_len = [], Fraction(0), None
    for p in bar:
        if p.tup is None:
            close()
            kind = None
            continue
        if p.tup != kind:
            close()
            kind = p.tup
        run.append(p)
        scale = Fraction(kind[0], kind[1])
        first_len = p.v * scale if first_len is None else first_len
        held += p.v
        if held.denominator == 1 or (held * scale == first_len * kind[0] and held * scale in NORMAL):
            close()
    close()


# --- directions ------------------------------------------------------------------


class _Dir:
    """A direction at a time: its direction-types (elements), the staff it is
    printed on, and a <sound tempo> if it changes the playback tempo."""
    __slots__ = ("t", "rank", "staff", "types", "tempo", "above")

    def __init__(self, t, rank, staff, types, tempo=None, above=False):
        self.t, self.rank, self.staff, self.types, self.tempo, self.above = t, rank, staff, types, tempo, above


def _dt(tag: str, text: str | None = None, **attrs) -> ET.Element:
    """A <direction-type> holding one <tag>."""
    dt = ET.Element("direction-type")
    ET.SubElement(dt, tag, attrs).text = text
    return dt


def _words(text: str, **attrs) -> ET.Element:
    return _dt("words", text, **{"font-style": "italic", **attrs})


def _dynamics_dt(level: str) -> ET.Element:
    dt = ET.Element("direction-type")
    ET.SubElement(ET.SubElement(dt, "dynamics"), level)
    return dt


def _dynamic_dirs(marks: list[tuple[Fraction, Mark]], total: Fraction, staff: int) -> list[_Dir]:
    """Dynamics, hairpins and words. A hairpin runs to the next dynamic, to an
    explicit end, to the next hairpin, or to the end of the piece (perform.py's
    reading); one cut off at its own moment by a dynamic is not written."""
    out: list[_Dir] = []
    pending: tuple[Fraction, str] | None = None

    def wedge(kind, t, rank):
        out.append(_Dir(t, rank, staff, [_dt("wedge", type=kind, number="1")]))

    def close(t):
        nonlocal pending
        t0, kind = pending
        pending = None
        if t > t0:
            wedge("crescendo" if kind == "cresc" else "diminuendo", t0, START)
            wedge("stop", t, STOP)
    by_time: dict[Fraction, list[Mark]] = {}
    for t, m in marks:
        by_time.setdefault(t, []).append(m)
    for t, ms in by_time.items():
        for m in ms:
            if m.kind == "dyn":
                if pending and pending[0] < t:
                    close(t)
                else:
                    pending = None
            elif m.kind in ("cresc", "dim"):
                if pending:
                    close(t)
                pending = (t, m.kind)
            elif m.kind == "end" and pending:
                close(t)
        dyns = [m.value for m in ms if m.kind == "dyn"]
        texts = [m.value for m in ms if m.kind == "text"]
        if len(dyns) == 1 and texts:           # "p dolce" is one direction
            out.append(_Dir(t, WORDS, staff, [_dynamics_dt(dyns[0])] + [_words(x) for x in texts]))
            continue
        out += [_Dir(t, WORDS, staff, [_dynamics_dt(d)]) for d in dyns]
        out += [_Dir(t, WORDS, staff, [_words(x)]) for x in texts]
    if pending:
        close(total)
    return out


def _pedal_dirs(marks: list[tuple[Fraction, Mark]], total: Fraction, staff: int) -> list[_Dir]:
    """ped = down (a change if already down), * = up; still down at the end is lifted there."""
    out, down = [], False

    def pedal(kind):
        return _dt("pedal", type=kind, line="yes", sign="yes")
    for t, m in marks:
        if m.kind == "ped":
            out.append(_Dir(t, PEDAL, staff, [pedal("change" if down else "start")]))
            down = True
        elif down:
            out.append(_Dir(t, PEDAL, staff, [pedal("stop")]))
            down = False
    if down:
        out.append(_Dir(total, PEDAL, staff, [pedal("stop")]))
    return out


def _metronome(bpm: float) -> ET.Element:
    dt = ET.Element("direction-type")
    met = ET.SubElement(dt, "metronome")
    ET.SubElement(met, "beat-unit").text = "quarter"
    ET.SubElement(met, "per-minute").text = _num(bpm)
    return dt


def _num(x) -> str:
    x = round(float(x), 3)
    return str(int(x)) if x == int(x) else str(x)


# --- the writer ------------------------------------------------------------------


class _Voice:
    __slots__ = ("part", "staff", "number", "primary", "bars", "channel")

    def __init__(self, part, staff, number, primary, bars):
        self.part, self.staff, self.number, self.primary, self.bars = part, staff, number, primary, bars
        self.channel = part.channel


class _XPart:
    """One MusicXML <part>: a group's staves, or a lone staff."""

    def __init__(self, pid: str, name: str, staves: list[tuple[str, list[Part]]]):
        self.id, self.name, self.staves = pid, name, staves
        self.parts = [p for _, ms in staves for p in ms]
        self.voices: list[_Voice] = []
        self.dirs: list[_Dir] = []
        self.instruments: dict[str, str] = {}      # MIDI channel key -> score-instrument id


def _staves(score: Score) -> list[tuple[str, list[Part]]]:
    staves: list[tuple[str, list[Part]]] = []
    for p in score.parts:
        for name, members in staves:
            if name == p.staff:
                members.append(p)
                break
        else:
            staves.append((p.staff, [p]))
    return staves


def _lcm(*ns: int) -> int:
    out = 1
    for n in ns:
        out = out * n // math.gcd(out, n)
    return out


def _key_alters(fifths: int) -> dict[str, int]:
    alters = dict.fromkeys("ABCDEFG", 0)
    for letter in (SHARP_ORDER[:fifths] if fifths > 0 else SHARP_ORDER[::-1][:-fifths]):
        alters[letter] = 1 if fifths > 0 else -1
    return alters


class _Writer:
    def __init__(self, score: Score):
        if not score.parts:
            raise ValueError("a score with no parts has nothing to write")
        self.score = score
        self.nbars = score.bars
        self.starts = score.barlines(self.nbars)
        self.total = self.starts[-1]
        self.fifths = score.key.signature
        self.alters = _key_alters(self.fifths)
        self.xparts = self._layout()
        for xp in self.xparts:
            self._voices(xp)
            self._directions(xp, first=xp is self.xparts[0])
        self.divisions = self._divisions()

    # layout: staves into parts, parts into voices ----------------------------

    def _layout(self) -> list[_XPart]:
        staves, out, done = _staves(self.score), [], set()
        for name, members in staves:
            group = members[0].group
            if group is None:
                out.append(_XPart(f"P{len(out) + 1}", name.title(), [(name, members)]))
            elif group not in done:
                done.add(group)
                out.append(_XPart(f"P{len(out) + 1}", group,
                                  [(n, ms) for n, ms in staves if ms[0].group == group]))
        return out

    def _voices(self, xp: _XPart) -> None:
        number = 0
        for si, (_, members) in enumerate(xp.staves, 1):
            for i, part in enumerate(members):
                number += 1
                xp.voices.append(_Voice(part, si, number, i == 0,
                                        _voice_pieces(self.score, part, self.starts, i == 0)))

    def _directions(self, xp: _XPart, first: bool) -> None:
        score, total, dirs = self.score, self.total, xp.dirs
        braced = [i for i, (_, ms) in enumerate(xp.staves, 1) if ms[0].brace]
        dyn_staff, ped_staff = (braced[0], braced[-1]) if braced else (1, len(xp.staves))
        seen, marks = set(), []
        for p in xp.parts:
            for t, m in p.marks(Mark):
                if (t, m) not in seen:
                    seen.add((t, m))
                    marks.append((t, m))
        marks.sort(key=lambda x: x[0])
        dirs += _dynamic_dirs([x for x in marks if x[1].kind in ("dyn", "cresc", "dim", "end", "text")],
                              total, dyn_staff)
        dirs += _pedal_dirs([x for x in marks if x[1].kind in ("ped", "pedup")], total, ped_staff)

        span = 0

        def spanned(t0, t1, text, staff, rank=START):
            """Words over a dashed line from t0 to t1."""
            nonlocal span
            span = span % 6 + 1
            dirs.append(_Dir(t0, rank, staff, [_words(text), _dt("dashes", type="start", number=str(span))], above=True))
            dirs.append(_Dir(t1, STOP, staff, [_dt("dashes", type="stop", number=str(span))], above=True))
        if first:
            for m in score.tempo_marks:
                if m.gradual:
                    if m.text:
                        spanned(m.start, m.end, m.text, 1)
                    if m.bpm:       # arrives at the new tempo, shown as its metronome mark
                        dirs.append(_Dir(m.end, WORDS, 1, [_metronome(m.bpm)], m.bpm, above=True))
                elif m.text or m.bpm:
                    types = ([_words(m.text, **{"font-style": "normal", "font-weight": "bold"})] if m.text else []) \
                        + ([_metronome(m.bpm)] if m.bpm else [])
                    dirs.append(_Dir(m.start, WORDS, 1, types, m.bpm, above=True))
            for sec in score.sections:
                if sec.bar <= self.nbars:
                    types = [_dt("rehearsal", sec.label, enclosure="square")]
                    types += [_words(sec.description)] if sec.description else []
                    dirs.append(_Dir(score.bar_start(sec.bar), WORDS, 1, types, above=True))
        for si, (_, members) in enumerate(xp.staves, 1):
            texts: dict[Fraction, list[str]] = {}
            for p in members:
                for t, text, _ in p.registrations:
                    if text not in texts.setdefault(t, []):
                        texts[t].append(text)
            for t, ts in sorted(texts.items()):
                dirs.append(_Dir(t, WORDS, si, [_words(" / ".join(ts))], above=True))
            for p in members:
                for d in p.drifts:
                    spanned(d.start, d.end, d.text, si)
        dirs.sort(key=lambda d: (d.t, d.rank))

    def _divisions(self) -> int:
        dens = [1]
        for xp in self.xparts:
            for v in xp.voices:
                for bar in v.bars:
                    for p in bar:
                        dens += [p.v.denominator, p.onset.denominator]
            dens += [(d.t - self.starts[self._bar_of(d.t)]).denominator for d in xp.dirs]
        dens += [(b - a).denominator for a, b in zip(self.starts, self.starts[1:])]
        return _lcm(*dens)

    def _bar_of(self, t: Fraction) -> int:
        return min(bisect.bisect_right(self.starts, t) - 1, self.nbars - 1)

    def _dur(self, x: Fraction) -> str:
        return str(int(x * self.divisions))

    # the document ----------------------------------------------------------

    def build(self) -> ET.Element:
        score = self.score
        root = ET.Element("score-partwise", version="4.0")
        if score.title:
            ET.SubElement(ET.SubElement(root, "work"), "work-title").text = score.title
        ident = ET.SubElement(root, "identification")
        if score.composer:
            ET.SubElement(ident, "creator", type="composer").text = score.composer
        ET.SubElement(ET.SubElement(ident, "encoding"), "software").text = "badmidi"
        plist = ET.SubElement(root, "part-list")
        channels = list(dict.fromkeys(p.channel for p in score.parts))
        for xp in self.xparts:
            self._score_part(plist, xp, channels)
        for xp in self.xparts:
            self._part(root, xp)
        return root

    def _score_part(self, plist: ET.Element, xp: _XPart, channels: list[str]) -> None:
        sp = ET.SubElement(plist, "score-part", id=xp.id)
        ET.SubElement(sp, "part-name").text = xp.name
        by_channel = {}
        for p in xp.parts:
            by_channel.setdefault(p.channel, p)
        free = [c for c in range(16) if c != 9]
        for i, (ch, p) in enumerate(by_channel.items(), 1):
            iid = f"{xp.id}-I{i}"
            inst = ET.SubElement(sp, "score-instrument", id=iid)
            ET.SubElement(inst, "instrument-name").text = (p.name if len(by_channel) > 1 else p.instrument).title()
            mi = ET.SubElement(sp, "midi-instrument", id=iid)
            k = channels.index(ch)
            ET.SubElement(mi, "midi-channel").text = str(free[k % len(free)] + 1)
            ET.SubElement(mi, "midi-program").text = str(p.program + 1)
            pan = p.pan if p.pan is not None else (64 if len(channels) == 1 else round(34 + 60 * k / (len(channels) - 1)))
            ET.SubElement(mi, "pan").text = str(max(-90, min(90, round((pan - 64) * 90 / 64))))
        xp.instruments = {ch: f"{xp.id}-I{i}" for i, ch in enumerate(by_channel, 1)}

    def _attributes(self, xp: _XPart, b: int, prev) -> tuple[ET.Element | None, object]:
        """The <attributes> of bar b: everything in bar 1, afterwards only a changed meter."""
        m = self.score.meter_at(b)
        if b > 1 and m == prev:
            return None, prev
        at = ET.Element("attributes")
        if b == 1:
            ET.SubElement(at, "divisions").text = str(self.divisions)
            key = ET.SubElement(at, "key")
            ET.SubElement(key, "fifths").text = str(self.fifths)
            ET.SubElement(key, "mode").text = MODES[self.score.key.mode]
        at.append(self._time(m))
        if b == 1:
            if len(xp.staves) > 1:
                ET.SubElement(at, "staves").text = str(len(xp.staves))
            for si, (_, members) in enumerate(xp.staves, 1):
                sign, line, shift = CLEFS.get(_clef(members).strip('"'), CLEFS["treble"])
                clef = ET.SubElement(at, "clef", number=str(si)) if len(xp.staves) > 1 else ET.SubElement(at, "clef")
                ET.SubElement(clef, "sign").text = sign
                ET.SubElement(clef, "line").text = str(line)
                if shift:
                    ET.SubElement(clef, "clef-octave-change").text = str(shift)
        return at, m

    @staticmethod
    def _time(m) -> ET.Element:
        """A free bar gets a hidden time signature of its own length when it
        has one (11 quarters -> 11/4), so every bar's durations add up to its
        time signature and nothing needs senza-misura; only a length no power
        of two can count (10/3 quarters) is senza-misura."""
        t = ET.Element("time")
        if m.free is not None:
            t.set("print-object", "no")
            den = next((d for d in (4, 8, 16, 32) if (m.free * d / 4).denominator == 1), None)
            if den is None:
                ET.SubElement(t, "senza-misura")
                return t
            num = int(m.free * den / 4)
        else:
            num, den = m.num, m.den
        ET.SubElement(t, "beats").text = "+".join(map(str, m.groups)) if m.free is None and m.explicit else str(num)
        ET.SubElement(t, "beat-type").text = str(den)
        return t

    def _part(self, root: ET.Element, xp: _XPart) -> None:
        part = ET.SubElement(root, "part", id=xp.id)
        multi = len(xp.staves) > 1
        by_bar: list[list[tuple[Fraction, _Dir]]] = [[] for _ in range(self.nbars)]
        for d in xp.dirs:
            b = self._bar_of(d.t)
            by_bar[b].append((d.t - self.starts[b], d))
        prev = None
        for b in range(1, self.nbars + 1):
            m = ET.SubElement(part, "measure", number=str(b))
            at, prev = self._attributes(xp, b, prev)
            if at is not None:
                m.append(at)
            barlen = self.starts[b] - self.starts[b - 1]
            self._accidentals(xp, b)
            first = True
            for v in xp.voices:
                slots = self._stream(xp, v, b, multi)
                if slots is None:
                    continue
                if not first:
                    back = ET.SubElement(m, "backup")
                    ET.SubElement(back, "duration").text = self._dur(barlen)
                els = self._with_directions(slots, by_bar[b - 1], barlen, multi) if first \
                    else [el for _, group in slots for el in group]
                m.extend(els)
                first = False
            if b == self.nbars:
                bl = ET.SubElement(m, "barline", location="right")
                ET.SubElement(bl, "bar-style").text = "light-heavy"

    # directions in the first voice -------------------------------------------

    def _with_directions(self, slots, dirs, barlen: Fraction, multi: bool) -> list[ET.Element]:
        """Flatten the first voice's (onset, elements) slots with each
        direction placed before the last slot starting at or before it, displaced
        by <offset> to its exact time; one at the barline's end follows the notes."""
        onsets = [o for o, _ in slots]
        before: dict[int | None, list[ET.Element]] = {}
        for rel, d in dirs:
            if rel >= barlen:
                key, off = None, 0
            else:
                key = bisect.bisect_right(onsets, rel) - 1
                off = rel - onsets[key]
            before.setdefault(key, []).append(self._direction(d, off, multi))
        out = []
        for i, (_, els) in enumerate(slots):
            out += before.get(i, []) + els
        return out + before.get(None, [])

    def _direction(self, d: _Dir, offset: Fraction, multi: bool) -> ET.Element:
        el = ET.Element("direction")
        el.set("placement", "above" if d.above else "below")
        for t in d.types:
            el.append(t)
        if offset:
            ET.SubElement(el, "offset", **({"sound": "yes"} if d.tempo else {})).text = self._dur(offset)
        if multi:
            ET.SubElement(el, "staff").text = str(d.staff)
        if d.tempo:
            ET.SubElement(el, "sound", tempo=_num(d.tempo))
        return el

    # notes ---------------------------------------------------------------------

    def _accidentals(self, xp: _XPart, b: int) -> None:
        """Decide which pitches of bar b print an accidental: those whose alter
        differs from the key signature as altered earlier in the bar, in that
        octave and staff. A note tied over the barline prints none."""
        for si in range(1, len(xp.staves) + 1):
            todo = [(p.onset, v.number, p) for v in xp.voices if v.staff == si
                    for p in v.bars[b - 1] if p.kind == "note"]
            state: dict[tuple[str, int], int] = {}
            for _, _, p in sorted(todo, key=lambda x: x[:2]):
                p.acc = []
                for step, alter, octave, _ in p.heads:
                    cur = state.get((step, octave), self.alters[step])
                    if p.tie_stop:
                        p.acc.append(None)
                        continue
                    p.acc.append(ACCIDENTAL.get(alter) if alter != cur else None)
                    state[(step, octave)] = alter

    def _stream(self, xp: _XPart, v: _Voice, b: int, multi: bool):
        """The voice's bar as (onset, [elements]) slots, ending at the bar's
        end; None for a secondary voice with nothing in the bar."""
        pieces = sorted(v.bars[b - 1], key=lambda p: p.onset)
        if not pieces and not v.primary:
            return None
        barlen = self.starts[b] - self.starts[b - 1]
        slots, cursor = [], Fraction(0)

        def forward(until):
            f = ET.Element("forward")
            ET.SubElement(f, "duration").text = self._dur(until - cursor)
            ET.SubElement(f, "voice").text = str(v.number)
            if multi:
                ET.SubElement(f, "staff").text = str(v.staff)
            slots.append((cursor, [f]))
        for p in pieces:
            if p.onset > cursor:
                forward(p.onset)
            slots.append((p.onset, self._note(xp, v, p, multi)))
            cursor = p.onset + p.v
        if cursor < barlen:
            forward(barlen)
        return slots

    def _note(self, xp: _XPart, v: _Voice, p: _Piece, multi: bool) -> list[ET.Element]:
        out = []
        for i in range(max(1, len(p.heads))):
            n = ET.Element("note")
            if i:
                ET.SubElement(n, "chord")
            if p.kind == "note":
                step, alter, octave, _ = p.heads[i]
                pitch = ET.SubElement(n, "pitch")
                ET.SubElement(pitch, "step").text = step
                if alter:
                    ET.SubElement(pitch, "alter").text = str(alter)
                ET.SubElement(pitch, "octave").text = str(octave)
            else:
                ET.SubElement(n, "rest", **({"measure": "yes"} if p.kind == "mrest" else {}))
            ET.SubElement(n, "duration").text = self._dur(p.v)
            if p.kind == "note":
                if p.tie_stop:
                    ET.SubElement(n, "tie", type="stop")
                if p.tie_start:
                    ET.SubElement(n, "tie", type="start")
            if len(xp.instruments) > 1:
                ET.SubElement(n, "instrument", id=xp.instruments[v.channel])
            ET.SubElement(n, "voice").text = str(v.number)
            if p.kind != "mrest":
                ET.SubElement(n, "type").text = p.type
                for _ in range(p.dots):
                    ET.SubElement(n, "dot")
            if p.kind == "note" and p.acc and p.acc[i]:
                ET.SubElement(n, "accidental").text = p.acc[i]
            if p.tup:
                tm = ET.SubElement(n, "time-modification")
                ET.SubElement(tm, "actual-notes").text = str(p.tup[0])
                ET.SubElement(tm, "normal-notes").text = str(p.tup[1])
            if multi:
                ET.SubElement(n, "staff").text = str(v.staff)
            notations = ET.Element("notations")
            if p.kind == "note":
                if p.tie_stop:
                    ET.SubElement(notations, "tied", type="stop")
                if p.tie_start:
                    ET.SubElement(notations, "tied", type="start")
            if i == 0:
                self._notations(notations, p)
            if len(notations):
                n.append(notations)
            out.append(n)
        return out

    @staticmethod
    def _notations(notations: ET.Element, p: _Piece) -> None:
        shown = "actual" if p.tup and p.tup[1] == tuplet_space(p.tup[0]) else "both"
        if p.tstop and p.tstart:
            ET.SubElement(notations, "tuplet", type="start", number="1", bracket="yes", **{"show-number": shown})
            ET.SubElement(notations, "tuplet", type="stop", number="1")
        elif p.tstart:
            ET.SubElement(notations, "tuplet", type="start", number="1", bracket="yes", **{"show-number": shown})
        elif p.tstop:
            ET.SubElement(notations, "tuplet", type="stop", number="1")
        if p.arts:
            arts = ET.SubElement(notations, "articulations")
            for c in p.arts:
                ET.SubElement(arts, ARTICULATION[c])
        if p.fermata:
            ET.SubElement(notations, "fermata", type="upright")


# --- public --------------------------------------------------------------------


def musicxml(score: Score) -> str:
    """The score as a MusicXML 4.0 partwise document."""
    with spelling(score.key):
        root = _Writer(score).build()
    ET.indent(root, space="  ")
    return ('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + DOCTYPE + "\n"
            + ET.tostring(root, encoding="unicode") + "\n")


def write_musicxml(score: Score, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(musicxml(score))


# --- reading ---------------------------------------------------------------------

_STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_UNIT = {"breve": Fraction(8), "whole": Fraction(4), "half": Fraction(2), "quarter": Fraction(1),
         "eighth": Fraction(1, 2), "16th": Fraction(1, 4), "32nd": Fraction(1, 8), "64th": Fraction(1, 16)}
_ARTICULATIONS = {tag: char for char, tag in ARTICULATION.items()} | {"staccatissimo": "'"}
# modes as steps round the circle of fifths from the major key with the same signature
_MODE_FIFTHS = {"major": 0, "minor": -3, "dorian": -2, "phrygian": -4, "lydian": 1, "mixolydian": -1,
                "locrian": -5, "ionian": 0, "aeolian": -3}
_SIMPLE_LABEL = re.compile(r"[A-Z]{1,2}\d?|\d+")
_IGNORED_NOTATIONS = {"slur": "slurs", "ornaments": "ornaments", "technical": "technical marks",
                      "arpeggiate": "arpeggios", "non-arpeggiate": "arpeggios", "glissando": "glissandi",
                      "slide": "glissandi"}


@dataclass
class _Sig:
    """A time signature as read: (numerator or "2+2+3", denominator), its length in quarters."""
    spec: tuple | None
    length: Fraction | None
    free: bool = False


@dataclass
class _Raw:
    """A pitched note of a measure, before absolute time is known."""
    t: Fraction
    dur: Fraction
    midi: int
    spell: str | None
    voice: int
    staff: int
    tie_start: bool
    tie_stop: bool
    art: str
    fermata: bool
    inst: str | None


def _tonic(fifths: int) -> str | int:
    """The tonic of the major key with this many sharps (flats if negative), by name;
    an int pitch class when it would need a double accidental."""
    letter, acc = "FCGDAEB"[(fifths + 1) % 7], (fifths + 1) // 7
    if abs(acc) > 1:
        return (_STEP[letter] + acc) % 12
    return letter + "#" * acc + "b" * -acc


def _key_of(el: ET.Element):
    from .scale import key as parse_key
    f = el.findtext("fifths")
    mode = (el.findtext("mode") or "major").strip().lower()
    if f is None or mode not in _MODE_FIFTHS:
        return None
    tonic = _tonic(int(f) - _MODE_FIFTHS[mode])
    mode = {"ionian": "major", "aeolian": "minor"}.get(mode, mode)
    if isinstance(tonic, int):
        from .scale import Scale
        return Scale(tonic, mode)
    return parse_key(f"{tonic} {mode}")


def _clef_name(c: ET.Element) -> str | None:
    sign, line = (c.findtext("sign") or "").strip(), int(c.findtext("line") or 0)
    shift = int(c.findtext("clef-octave-change") or 0)
    for name, spec in CLEFS.items():
        if spec == (sign, line, shift):
            return f'"{name}"' if "_" in name or "^" in name else name
    if sign == "percussion" or sign == "TAB":
        return None
    return {"G": "treble", "F": "bass", "C": "tenor" if line == 4 else "alto"}.get(sign)


def _meter_spec(length: Fraction, prefer: int | None) -> tuple[int, int]:
    """(num, den) for a bar of this many quarters that no time signature names
    (a pickup, a short or overfull bar): over the signature's denominator if it fits."""
    for den in ([prefer] if prefer else []) + [4, 8, 16, 32, 64]:
        if (length * den / 4).denominator == 1:
            return int(length * den / 4), den
    return round(length * 16), 64


def _quarter_bpm(m: ET.Element) -> float | None:
    """Quarter notes per minute from a <metronome> with a beat unit and a plain per-minute number."""
    unit, pm = _UNIT.get((m.findtext("beat-unit") or "").strip()), (m.findtext("per-minute") or "").strip()
    if unit is None or not re.fullmatch(r"\d+(\.\d+)?", pm):
        return None
    dots = len(m.findall("beat-unit-dot"))
    return round(float(pm) * float(unit) * (2 - 0.5 ** dots), 3)


def _direction(el: ET.Element, skipped: Counter) -> list[tuple]:
    """A <direction> as items: ("mark", Mark), ("marker", text), ("tempo", bpm, from_sound),
    ("tempo_text", text), ("dash", "start"|"stop", number, text), ("words", text, placement, tempo_like)."""
    items, words, rehearsal, metro, dashes = [], [], None, None, []
    tempo_like = 0      # 2: bold words, 1: plain words above the staff (tempo text if a tempo is there)
    for c in (c for dt in el.findall("direction-type") for c in dt):
        tag = c.tag
        if tag == "dynamics":
            for d in c:
                name = (d.text or "").strip() if d.tag == "other-dynamics" else d.tag
                if name:
                    items.append(("mark", dyn(name) if name in DYNAMICS else words_mark(name)))
        elif tag == "wedge":
            mark = {"crescendo": CRESC, "diminuendo": DIM, "stop": HAIRPIN_END}.get(c.get("type"))
            if mark:
                items.append(("mark", mark))
        elif tag == "pedal":
            mark = {"start": PED, "change": PED, "resume": PED, "stop": PED_UP, "discontinue": PED_UP}.get(c.get("type"))
            if mark:
                items.append(("mark", mark))
        elif tag == "words":
            s = " ".join((c.text or "").split()).replace('"', "'")
            if s:
                words.append(s)
                tempo_like = max(tempo_like, 2 if c.get("font-weight") == "bold" else int(
                    el.get("placement") == "above" and c.get("font-style") != "italic"))
        elif tag == "rehearsal":
            rehearsal = " ".join((c.text or "").split()) or rehearsal
        elif tag == "metronome":
            metro = _quarter_bpm(c)
        elif tag == "dashes":
            dashes.append((c.get("type"), c.get("number", "1")))
        elif tag in ("octave-shift", "segno", "coda", "harp-pedals", "percussion", "image", "accordion-registration"):
            skipped[f"{tag} directions"] += 1
    snd = el.find("sound")
    sound = float(snd.get("tempo")) if snd is not None and re.fullmatch(r"\d+(\.\d+)?", snd.get("tempo", "")) else None
    consumed = False
    if rehearsal is not None:
        label = " ".join(words) or ("" if _SIMPLE_LABEL.fullmatch(rehearsal) else rehearsal)
        items.append(("marker", label))
        consumed = True
    for kind, number in dashes:
        if kind in ("start", "stop"):
            items.append(("dash", kind, number, " ".join(words) if kind == "start" else ""))
            consumed |= kind == "start"
    if sound is not None or metro is not None:
        items.append(("tempo", sound if sound is not None else metro, sound is not None))
        if words and not consumed:
            items.append(("tempo_text", " ".join(words)))
            consumed = True
    if not consumed:
        items += [("words", w, el.get("placement"), tempo_like) for w in words]
    return items


class _Reader:
    def __init__(self, root: ET.Element):
        self.root = root
        self.skipped: Counter = Counter()
        self.notes: list[str] = []

    # one part: measures with relative times ---------------------------------

    def _part(self, el: ET.Element, info: dict) -> dict:
        """Walk a <part>, tracking the time in the measure through <backup>, <forward> and
        <chord/>. Returns {"measures": [...], "staves", "clefs", "key"}; each measure holds
        its pitched notes, its directions and its extent, all at times relative to its start."""
        skipped, div, shift = self.skipped, None, 0
        out = dict(measures=[], staves=1, clefs={}, key=None, keys=0)
        for mi, m in enumerate(el.findall("measure")):
            meas = dict(extent=Fraction(0), implicit=m.get("implicit") == "yes", time=None, notes=[], dirs=[])
            out["measures"].append(meas)
            pos = last_on = Fraction(0)

            def frac(x) -> Fraction:
                if div is None:
                    raise ValueError("notes before <divisions>")
                return Fraction(str(x).strip()) / div
            for c in m:
                tag = c.tag
                try:
                    if tag == "attributes":
                        if c.findtext("divisions"):
                            div = int(c.findtext("divisions"))
                        if c.find("staves") is not None:
                            out["staves"] = max(out["staves"], int(c.findtext("staves")))
                        for k in c.findall("key"):
                            out["keys"] += 1
                            out["key"] = out["key"] or _key_of(k)
                        for tm in c.findall("time"):
                            meas["time"] = self._time(tm)
                        for cl in c.findall("clef"):
                            out["clefs"].setdefault(int(cl.get("number", 1)), _clef_name(cl))
                        tr = c.find("transpose")
                        if tr is not None:
                            shift = int(tr.findtext("chromatic") or 0) + 12 * int(tr.findtext("octave-change") or 0)
                    elif tag == "note":
                        pos, last_on = self._note(c, meas, pos, last_on, frac, shift, out)
                    elif tag == "backup":
                        pos -= frac(c.findtext("duration"))
                    elif tag == "forward":
                        pos += frac(c.findtext("duration"))
                    elif tag == "direction":
                        off = frac(c.findtext("offset") or 0)
                        staff = int(c.findtext("staff") or 1)
                        meas["dirs"].append((pos + off, staff, _direction(c, skipped)))
                    elif tag == "sound" and c.get("tempo"):
                        meas["dirs"].append((pos, 1, [("tempo", float(c.get("tempo")), True)]))
                    elif tag == "barline":
                        skipped["repeat barlines (not unfolded)"] += c.find("repeat") is not None
                    elif tag in ("harmony", "figured-bass"):
                        skipped["chord symbols and figured bass"] += 1
                except (ValueError, TypeError, KeyError, ZeroDivisionError) as e:
                    raise ValueError(f"measure {m.get('number', mi + 1)}: <{tag}> can't be read ({e!r})") from e
                meas["extent"] = max(meas["extent"], pos)
        return out

    @staticmethod
    def _time(tm: ET.Element) -> _Sig:
        if tm.find("senza-misura") is not None:
            return _Sig(None, None, True)
        beats, types = [b.text.strip() for b in tm.findall("beats")], [b.text.strip() for b in tm.findall("beat-type")]
        length = sum(sum(int(x) for x in b.split("+")) * Fraction(4, int(t)) for b, t in zip(beats, types))
        if len(beats) == 1:
            groups = [int(x) for x in beats[0].split("+")]
            return _Sig((sum(groups) if len(groups) == 1 else beats[0], int(types[0])), length)
        return _Sig(None, length)           # composite signature: no single name, the bars are measured

    def _note(self, c, meas, pos, last_on, frac, shift, out):
        skipped = self.skipped
        chord = c.find("chord") is not None
        if c.find("grace") is not None:
            skipped["grace notes"] += 1
            return pos, last_on
        dur = frac(c.findtext("duration"))
        start = last_on if chord else pos
        if not chord:
            last_on, pos = pos, pos + dur
        if c.find("rest") is not None:
            return pos, last_on
        if c.find("cue") is not None:
            skipped["cue notes"] += 1
        elif c.find("unpitched") is not None:
            skipped["unpitched (percussion) notes"] += 1
        else:
            p = c.find("pitch")
            step, octave = p.findtext("step").strip(), int(p.findtext("octave"))
            alter = float(p.findtext("alter") or 0)
            a = round(alter)
            if a != alter:
                skipped["microtonal alterations (rounded)"] += 1
            midi = 12 * (octave + 1) + _STEP[step] + a
            spell = f"{step}{'#' * a}{'b' * -a}{octave}"
            if shift:
                midi, spell = midi + shift, None
            staff = int(c.findtext("staff") or 1)
            out["staves"] = max(out["staves"], staff)
            ties = {t.get("type") for t in c.findall("tie")} or {t.get("type") for t in c.findall("notations/tied")}
            art, fermata = "", False
            n = c.find("notations")
            if n is not None:
                for a_ in n.findall("articulations/*"):
                    ch = _ARTICULATIONS.get(a_.tag)
                    if ch and ch not in art:
                        art += ch
                fermata = n.find("fermata") is not None
                for ch_ in n:
                    if ch_.tag in _IGNORED_NOTATIONS and ch_.get("type") in (None, "start"):
                        skipped[_IGNORED_NOTATIONS[ch_.tag]] += 1
            skipped["lyrics"] += len(c.findall("lyric"))
            try:
                voice = int(c.findtext("voice") or 1)
            except ValueError:
                voice = 1
            inst = c.find("instrument")
            meas["notes"].append(_Raw(start, dur, midi, spell, voice, staff, "start" in ties, "stop" in ties,
                                      art, fermata, inst.get("id") if inst is not None else None))
        return pos, last_on

    # the whole score ---------------------------------------------------------

    def source(self, title: str = "") -> "Source":
        from .ingest import Source, SourceNote, SourceTrack
        root = self.root
        src = Source(title=(root.findtext("work/work-title") or root.findtext("movement-title") or title).strip(),
                     exact=True)
        infos = {}
        for sp in root.findall("part-list/score-part"):
            insts = {}
            for mi in sp.findall("midi-instrument"):
                prog, ch = (mi.findtext("midi-program") or "").strip(), (mi.findtext("midi-channel") or "").strip()
                insts[mi.get("id")] = (int(prog) - 1 if prog.isdigit() and 1 <= int(prog) <= 128 else None,
                                       int(ch) - 1 if ch.isdigit() and 1 <= int(ch) <= 16 else None)
            infos[sp.get("id")] = dict(name=(sp.findtext("part-name") or sp.findtext("part-abbreviation")
                                             or sp.get("id")).strip(), insts=insts)
        parts = []
        for el in root.findall("part"):
            info = infos.get(el.get("id"), dict(name=el.get("id") or f"part {len(parts) + 1}", insts={}))
            try:
                parts.append((info, self._part(el, info)))
            except ValueError as e:
                raise ValueError(f"part {info['name']!r}, {e}") from e
        if not parts:
            raise ValueError("no <part> in the score")

        # bar lengths: the signature's, unless the music fills more (or a pickup / short bar fills less)
        nmeas = max(len(p["measures"]) for _, p in parts)
        starts, sig, prev_spec = [Fraction(0)], None, None
        for i in range(nmeas):
            ms = [p["measures"][i] for _, p in parts if i < len(p["measures"])]
            sig = next((m["time"] for m in ms if m["time"]), sig)
            extent = max(m["extent"] for m in ms)
            natural = sig.length if sig and not sig.free else None
            if natural is None or extent > natural or (extent < natural and 0 < extent and i < nmeas - 1):
                length = extent or natural or Fraction(4)
            else:
                length = natural
            spec = sig.spec if sig and length == natural and sig.spec else \
                _meter_spec(length, sig.spec[1] if sig and sig.spec else None)
            if spec != prev_spec:
                src.meters.append((starts[-1], *spec))
                prev_spec = spec
            starts.append(starts[-1] + length)

        tempos: dict[Fraction, list[tuple[float, bool]]] = {}     # per moment, in document order
        plain: list[tuple] = []       # words: (t, text, tempo_like, part, track key)
        dashes: dict[tuple, list] = {}
        spans: list[tuple] = []       # (start, end, text, track key)
        marks: dict[tuple, list] = {}
        tracks: dict[tuple, SourceTrack] = {}
        for pi, (info, p) in enumerate(parts):
            src.key = src.key or p["key"]
            if p["keys"] > 1:
                self.notes.append(f"key changes in part {info['name']!r} ignored: badmidi has one key")
            default_inst = next(iter(info["insts"].values()), (None, None))
            heads: dict[tuple, SourceNote] = {}
            by_staff = {s: [] for s in range(1, p["staves"] + 1)}
            first_inst: dict[int, tuple] = {}
            for i, meas in enumerate(p["measures"]):
                for r in meas["notes"]:
                    n = SourceNote(starts[i] + r.t, r.dur, r.midi, spell=r.spell, voice=r.voice, art=r.art)
                    chain = (r.staff, r.voice, r.midi)      # a fermata on the end of a tie belongs to its first note
                    head = heads.get(chain) if r.tie_stop else None
                    if head is None:
                        n.art += "@" if r.fermata else ""
                    elif r.fermata and "@" not in head.art:
                        head.art += "@"
                    if r.tie_start:
                        n.tie = True
                        heads[chain] = head or n
                    else:
                        heads.pop(chain, None)
                    by_staff[r.staff].append(n)
                    first_inst.setdefault(r.staff, info["insts"].get(r.inst, default_inst))
                for t, staff, items in meas["dirs"]:
                    t += starts[i]
                    key = (pi, min(max(staff, 1), p["staves"]))
                    for it in items:
                        kind = it[0]
                        if kind == "mark":
                            marks.setdefault(key, []).append((t, it[1]))
                        elif kind == "marker":
                            src.markers.append((t, it[1]))
                        elif kind == "tempo":
                            tempos.setdefault(t, []).append(it[1:])
                        elif kind == "tempo_text":
                            src.tempo_texts.append((t, it[1]))
                        elif kind == "dash":
                            if it[1] == "start":
                                dashes[(pi, it[2])] = [t, it[3], key]
                            elif (pi, it[2]) in dashes:
                                t0, label, k = dashes.pop((pi, it[2]))
                                spans.append((t0, t, label, k))
                        else:
                            plain.append((t, it[1], it[3], pi, key))
            for dk in [dk for dk in dashes if dk[0] == pi]:      # a dashed span never closed: just its words
                t0, label, k = dashes.pop(dk)
                if label:
                    marks.setdefault(k, []).append((t0, words_mark(label)))
            for s in range(1, p["staves"] + 1):
                prog, ch = first_inst.get(s, default_inst)
                name = info["name"] if p["staves"] == 1 else f"{info['name']} {s}"
                tracks[(pi, s)] = SourceTrack(name, prog, by_staff[s], [], channel=ch, clef=p["clefs"].get(s),
                                              staff_group=info["name"] if p["staves"] > 1 else None)

        # ramps need a tempo where they end; words alongside a tempo are its text
        for t0, t1, label, k in spans:
            if tempos.get(t1) and label:        # the first tempo where it ends is the ramp's target
                to = tempos[t1][0][0]
                tempos[t1] = [x for x in tempos[t1] if x[0] != to]
                src.ramps.append((t0, t1, to, label))
            elif label:
                marks.setdefault(k, []).append((t0, words_mark(label)))
        for t, w, tempo_like, pi, k in plain:
            if pi == 0 and (tempo_like == 2 or tempo_like and t in tempos):
                src.tempo_texts.append((t, w))
            else:
                marks.setdefault(k, []).append((t, words_mark(w)))
        src.tempos = sorted((t, ([x for x in v if x[1]] or v)[-1][0]) for t, v in tempos.items() if v)   # <sound> wins
        if src.tempos and src.tempos[0][0] > 0:
            src.tempos.insert(0, (Fraction(0), 120.0))      # MusicXML's default
        src.tempo_texts = sorted(dict.fromkeys(src.tempo_texts))
        src.markers = sorted(dict.fromkeys(src.markers), key=lambda m: m[0])
        src.ramps.sort()
        for pi in range(len(parts)):
            own = {k: v for k, v in marks.items() if k[0] == pi}
            moments = {t for v in own.values() for t, m in v if m.kind in ("dyn", "cresc", "dim")}
            for k, v in own.items():
                v.sort(key=lambda x: x[0])          # stable: a moment keeps its document order
                tracks[k].marks = [(t, m) for t, m in v if not (m.kind == "end" and t in moments)]
        src.tracks = list(tracks.values())
        src.notes = [f"skipped: {n} {what}" for what, n in self.skipped.items() if n] + self.notes
        return src


def _root(data: bytes | str) -> ET.Element:
    if isinstance(data, str):
        data = re.sub(r"^\s*<\?xml[^>]*\?>", "", data).encode("utf-8")
    elif data[:2] == b"PK":
        data = _unzip(data)
    try:
        return ET.fromstring(data)
    except ET.ParseError as e:
        raise ValueError(f"not a MusicXML file ({e})") from e


def _unzip(data: bytes) -> bytes:
    """The score inside a compressed .mxl: the container's rootfile, else the first XML outside META-INF."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = z.namelist()
            path = None
            if "META-INF/container.xml" in names:
                rf = ET.fromstring(z.read("META-INF/container.xml")).find(".//rootfile")
                path = rf.get("full-path") if rf is not None else None
            if path not in names:
                path = next((n for n in names if n.lower().endswith((".musicxml", ".xml"))
                             and not n.startswith("META-INF/")), None)
            if path is None:
                raise ValueError("no score found inside the .mxl")
            if z.getinfo(path).file_size > 1 << 29:
                raise ValueError("the score inside the .mxl is implausibly large")
            return z.read(path)
    except (zipfile.BadZipFile, ET.ParseError) as e:
        raise ValueError(f"not a readable .mxl ({e})") from e


def read_musicxml(data: bytes | str, title: str = ""):
    """A partwise MusicXML document (text, bytes, or a compressed .mxl) as an
    ingest.Source, ready for build_score. `title` is used when the file names none.

    A multi-staff part becomes one SourceTrack per staff, sharing a staff_group (a
    piano is a braced pair); voices keep their numbers. Times are exact, so build_score
    only snaps rounding. Directions go to the track of their staff. Timewise
    documents are refused: export partwise. Only the first key signature is kept,
    and bars follow the music (a pickup or short bar gets a time signature of its length)."""
    root = _root(data)
    if root.tag == "score-timewise":
        raise ValueError("timewise MusicXML is not supported; export it partwise (score-partwise)")
    if root.tag != "score-partwise":
        raise ValueError(f"not a MusicXML score (root element <{root.tag}>)")
    return _Reader(root).source(title)


def import_musicxml(path: str, **kw):
    """A MusicXML file as (Score, ImportReport); keywords as for ingest.build_score."""
    from .ingest import build_score
    with open(path, "rb") as f:
        data = f.read()
    return build_score(read_musicxml(data, os.path.splitext(os.path.basename(path))[0]), **kw)


def load_musicxml(path: str, **kw) -> Score:
    """A MusicXML file as a Score: load_musicxml("song.musicxml", key="D minor")."""
    return import_musicxml(path, **kw)[0]
