"""Scores and parts: placing motifs at explicit bar/beat anchors."""
from __future__ import annotations

import bisect
from fractions import Fraction

from .core import Bar, Mark, Motif, Note, Pitch, as_pitch
from .scale import Scale, key as parse_key

# name: (General MIDI program, lowest pitch, highest pitch) -- sounding ranges.
INSTRUMENTS: dict[str, tuple[int, int, int]] = {
    "piano": (0, 21, 108), "harpsichord": (6, 29, 89), "celesta": (8, 60, 108),
    "glockenspiel": (9, 79, 108), "vibraphone": (11, 53, 89), "marimba": (12, 45, 96),
    "organ": (19, 36, 96), "pedal": (19, 36, 67), "drawbar organ": (16, 36, 96),
    "percussive organ": (17, 36, 96), "rock organ": (18, 36, 96), "reed organ": (20, 36, 96),
    "guitar": (24, 40, 83), "bass guitar": (33, 28, 67),
    "violin": (40, 55, 103), "viola": (41, 48, 88), "cello": (42, 36, 81),
    "contrabass": (43, 28, 67), "harp": (46, 24, 103), "strings": (48, 28, 103),
    "choir": (52, 40, 81), "soprano": (52, 60, 81), "alto": (52, 53, 74),
    "tenor": (52, 48, 69), "bass": (52, 40, 64),
    "trumpet": (56, 54, 86), "trombone": (57, 40, 77), "tuba": (58, 26, 65),
    "horn": (60, 35, 77), "oboe": (68, 58, 93), "english horn": (69, 52, 81),
    "bassoon": (70, 34, 76), "clarinet": (71, 50, 94), "piccolo": (72, 74, 108),
    "flute": (73, 60, 96), "recorder": (74, 72, 98),
}


def _exact(x) -> Fraction:
    return Fraction(x).limit_denominator(192) if isinstance(x, float) else Fraction(x)


class Meter:
    """A time signature: Meter(3, 4); Meter(7, 8, groups=(2, 2, 3)); or from
    text, Meter.parse("3/4"), Meter.parse("2+2+3/8"). A free (unmetered) bar
    has a length in quarter notes and no time signature: Meter.free(11).

    groups are how the beats gather into pulses. They default to threes for
    compound meters (6/8, 9/8, 12/8, 6/4) and to single beats otherwise.
    """

    def __init__(self, num: int, den: int, groups: tuple[int, ...] | None = None,
                 free: Fraction | None = None):
        if free is None and (num < 1 or den < 1 or den & (den - 1)):
            raise ValueError(f"bad meter {num}/{den}: the denominator must be a power of two")
        if groups is not None and sum(groups) != num:
            raise ValueError(f"meter groups {'+'.join(map(str, groups))} don't add up to {num}")
        self.num, self.den, self.free = num, den, free
        self.explicit = groups is not None
        if groups is None:
            groups = (3,) * (num // 3) if self.compound else (1,) * num
        self.groups = tuple(groups)

    @classmethod
    def parse(cls, spec) -> "Meter":
        if isinstance(spec, Meter):
            return spec
        if isinstance(spec, str):
            top, _, den = spec.replace(" ", "").partition("/")
            groups = tuple(int(g) for g in top.split("+"))
            return cls(sum(groups), int(den), groups if len(groups) > 1 else None)
        if len(spec) == 3:
            return cls(spec[0], spec[1], tuple(spec[2]))
        return cls(*spec)

    @classmethod
    def unmetered(cls, length) -> "Meter":
        length = _exact(length)
        if length <= 0:
            raise ValueError("a free bar needs a positive length in quarter notes")
        return cls(0, 4, (), free=length)

    @property
    def compound(self) -> bool:
        return self.free is None and self.num in (6, 9, 12) and self.den >= 4

    @property
    def bar_len(self) -> Fraction:
        return self.free if self.free is not None else Fraction(4 * self.num, self.den)

    @property
    def beat_len(self) -> Fraction:
        return Fraction(1) if self.free is not None else Fraction(4, self.den)

    @property
    def beats(self) -> int:
        """Beats in the bar (quarter notes in a free bar)."""
        return self.num if self.free is None else int(-(-self.free // 1))

    def pulses(self) -> list[Fraction]:
        """Offsets of the pulses (group starts) within the bar."""
        out, at = [], 0
        for g in self.groups:
            out.append(at * self.beat_len)
            at += g
        return out or [Fraction(0)]

    def strong(self) -> list[Fraction]:
        """Accented offsets: the downbeat, and the other pulses in additive,
        compound or half-note meters; beat 3 of a four-beat bar."""
        p = self.pulses()
        if self.free is not None:
            return [Fraction(0)]
        if self.explicit or self.compound or self.beat_len >= 2:
            return p
        if len(p) == 4:
            return [p[0], p[2]]
        return [p[0]]

    @property
    def text(self) -> str:
        if self.free is not None:
            return "free"
        top = "+".join(map(str, self.groups)) if self.explicit else str(self.num)
        return f"{top}/{self.den}"

    def __eq__(self, other) -> bool:
        return isinstance(other, Meter) and (self.num, self.den, self.groups, self.free, self.explicit) == \
            (other.num, other.den, other.groups, other.free, other.explicit)

    def __hash__(self) -> int:
        return hash((self.num, self.den, self.groups, self.free))

    def __repr__(self) -> str:
        return f"Meter.unmetered({self.free})" if self.free is not None else f"Meter.parse({self.text!r})"


class Part:
    """One instrument's line. Place material at explicit anchors:

        vln.at(5, theme)             # bar 5, beat 1
        vln.at(5, theme, beat=3)     # bar 5, beat 3
        vln.then(answer)             # straight after whatever was placed last
        vln.mark(9, "<")             # a marking with no notes: bar 9, beat 1

    Engraving: parts sharing a `staff` are printed as voices on one staff;
    parts sharing a `group` (a piano's hands, an organ's manuals and pedal)
    are bracketed together and share dynamics and pedal marks. Braced
    staves (brace=True) go inside the group's brace; an organ's pedal staff
    sits below it.

    Performance only: `balance` is a velocity offset (bring out a melody);
    `couplers` are octave offsets that sound with every note ((0, -12) is an
    organ pedal with a 16' stop); parts with the same `channel` share a MIDI
    channel (a piano's hands), otherwise each part gets its own.
    """

    def __init__(self, score: "Score", name: str, instrument: str | None = None,
                 program: int | None = None, range: tuple | None = None,
                 group: str | None = None, staff: str | None = None, clef: str | None = None,
                 brace: bool = True, balance: int = 0, couplers: tuple[int, ...] = (0,),
                 channel: str | None = None, pan: int | None = None):
        inst = instrument or (name if name in INSTRUMENTS else "piano")
        if inst not in INSTRUMENTS:
            raise ValueError(f"unknown instrument {inst!r}; known: {', '.join(INSTRUMENTS)}")
        prog, lo, hi = INSTRUMENTS[inst]
        self.score = score
        self.name = name
        self.instrument = inst
        self.program = prog if program is None else program
        self.range: tuple[Pitch, Pitch] = (as_pitch(range[0]), as_pitch(range[1])) if range else (Pitch(lo), Pitch(hi))
        self.group = group
        self.staff = staff or name
        self.clef = clef
        self.brace = brace
        self.balance = balance
        self.couplers = couplers
        self.channel = channel or name
        self.registrations: list[tuple[Fraction, str, int | None]] = []
        self.drifts: list[Drift] = []
        self.pan = pan
        self.placements: list[tuple[Fraction, Motif]] = []
        self._last_end = Fraction(0)

    def at(self, bar: int, *material, beat=1) -> "Part":
        return self._place(self.score.time(bar, beat), material)

    def then(self, *material) -> "Part":
        return self._place(self._last_end, material)

    def loop(self, bar: int, *material, times: int = 2, beat=1) -> "Part":
        """Place `material` `times` times in a row, starting at bar N. It plays
        and shows (melody, grid, lens, check) fully expanded; the engraving
        prints it once inside a repeat marked x8 when every part agrees on
        the span, and writes it out otherwise (check says which).

            p.loop(5, "E4.e F4.e G4.e A4.e | ", times=8)
        """
        body = Motif(*material)
        if times < 2:
            raise ValueError("loop() needs times >= 2; use at() to place something once")
        if not body.dur:
            raise ValueError("loop() needs material with some length")
        if any(isinstance(it, Bar) and it.number is not None for it in body.items):
            raise ValueError("loop() material can't contain numbered anchors (|N): they name one bar, "
                             "and the material is played several times")
        t = self.score.time(bar, beat)
        self.score.loops.append(Loop(self, t, body.dur, times))
        return self._place(t, [body] * times)

    def clear(self, first_bar: int, last_bar: int | None = None) -> "Part":
        """Remove this part's notes and markings from the start of first_bar
        to the end of last_bar (default: just first_bar), so a passage of an
        imported or generated part can be replaced:

            vla.clear(17, 24).at(17, new_passage)

        A note that starts earlier is shortened to end where the span starts
        (its tie dropped); one that sounds on past the span keeps the part
        that falls after it, so the music outside is unchanged. Loops of this
        part that overlap the span are forgotten (they're no longer true).
        Barline anchors in the part's earlier placements are not kept."""
        last_bar = first_bar if last_bar is None else last_bar
        if last_bar < first_bar:
            raise ValueError(f"clear() needs last_bar >= first_bar (got {first_bar}-{last_bar})")
        a, b = self.score.bar_start(first_bar), self.score.bar_start(last_bar + 1)
        items: list[tuple[Fraction, int, Note | Mark]] = []   # marks sort before notes at the same time
        for t, mk in self.marks(Mark):
            if not a <= t < b:
                items.append((t, 0, mk))
        for t, n in self.events(merge_ties=False):
            end = t + n.dur
            if end <= a or t >= b:
                items.append((t, 1, n.with_tied(False) if end == a and n.tied else n))
                continue
            if t < a:
                items.append((t, 1, Note(n.pitches, a - t, False, n.art.replace("@", ""))))
            if end > b:
                tail = n.with_dur(end - b)
                items.append((b, 1, Note(tail.pitches, tail.dur, n.tied, "@" if "@" in n.art else "", tail.tuplet)))
        items.sort(key=lambda x: (x[0], x[1]))
        runs: list[tuple[Fraction, list]] = []
        end = None
        for t, _, it in items:
            if end is None or t != end:
                runs.append((t, []))
                end = t
            runs[-1][1].append(it)
            if isinstance(it, Note):
                end += it.dur
        self.placements = [(t, Motif(*its)) for t, its in runs]
        old = self._last_end
        self._last_end = a if a < old <= b else old
        self.score.loops = [lp for lp in self.score.loops
                            if lp.part is not self or lp.end <= a or lp.start >= b]
        return self

    def _place(self, t: Fraction, material) -> "Part":
        # one placement per argument: check() treats a motif that enters
        # mid-bar on its own terms (see views._enters_mid_bar)
        for m in material:
            motif = Motif(m)
            self.placements.append((t, motif))
            t += motif.dur
        self._last_end = t
        return self

    def voice(self, name: str, **kw) -> "Part":
        """Another line on this part's staff, with the same instrument, group,
        range and MIDI channel: rh.voice("alto"). A part holds one line, so
        this is how a staff gets two voices that overlap. Keywords override."""
        opts = dict(program=self.program, range=self.range, group=self.group, staff=self.staff,
                    brace=self.brace, couplers=self.couplers, channel=self.channel, pan=self.pan)
        opts.update(kw)
        return self.score.part(name, self.instrument, **opts)

    def registration(self, bar: int, text: str, program: int | str | None = None, beat=1) -> "Part":
        """A registration change, printed above the staff ("Sw.: Flutes 8' 4'").
        program (a GM number or an instrument name) is what it sounds like."""
        if isinstance(program, str):
            program = INSTRUMENTS[program][0]
        self.registrations.append((self.score.time(bar, beat), text, program))
        self.registrations.sort(key=lambda r: r[0])
        return self

    def drift(self, start, end, ahead=Fraction(1, 4), text: str | None = None) -> "Part":
        """Playback only: between `start` and `end` (a bar or (bar, beat), as
        in score.rit) this part gradually gets `ahead` quarter notes ahead of
        its written time (negative: behind), then stays that far off until
        another drift moves it again. The score, its views and the engraving's
        rhythms are unchanged; the staff gets `text` over a dashed line.

            b.drift(9, 41, ahead=Fraction(1, 4))        # a sixteenth ahead by bar 41
            b.drift(41, 49, ahead=-Fraction(1, 4))      # and back again

        A sustained tempo ratio r over the span is ahead = (r - 1) * length."""
        s0, s1 = self.score.pos(start), self.score.pos(end)
        if s1 <= s0:
            raise ValueError("drift() needs an end after its start")
        d = Drift(s0, s1, _exact(ahead), text)
        self.drifts.append(d)
        try:
            from .perform import warp
            warp(self)
        except ValueError:
            self.drifts.remove(d)
            raise
        return self

    def mark(self, bar: int, *marks, beat=1) -> "Part":
        """Place markings (dynamics, hairpins, pedal, text) at a position
        without any notes, e.g. part.mark(12, "<", beat=3)."""
        motif = Motif(*marks)
        if motif.notes:
            raise ValueError("mark() takes markings only; use at() for notes")
        self.placements.append((self.score.time(bar, beat), motif))
        return self

    @property
    def end(self) -> Fraction:
        return max((s + m.dur for s, m in self.placements), default=Fraction(0))

    def events(self, merge_ties: bool = True) -> list[tuple[Fraction, Note]]:
        """(start time, note) for every note and rest, sorted by time.

        With merge_ties, a tied note and the same-pitched note right after it
        become one event, which is how it sounds."""
        out = []
        for start, motif in self.placements:
            t = start
            for it in motif.items:
                if isinstance(it, Note):
                    out.append((t, it))
                    t += it.dur
        out.sort(key=lambda e: e[0])
        if not merge_ties:
            return out
        merged: list[tuple[Fraction, Note]] = []
        for t, n in out:
            if merged:
                pt, pn = merged[-1]
                if pn.tied and pt + pn.dur == t and pn.pitches == n.pitches:
                    art = pn.art + ("@" if "@" in n.art else "")
                    merged[-1] = (pt, Note(n.pitches, pn.dur + n.dur, n.tied, art))
                    continue
            merged.append((t, n))
        return merged

    def marks(self, kind: type | None = None) -> list[tuple[Fraction, Bar | Mark]]:
        """(time, item) for every bar anchor and marking, sorted by time
        (stable, so marks at the same moment keep their written order)."""
        out = []
        for start, motif in self.placements:
            t = start
            for it in motif.items:
                if isinstance(it, Note):
                    t += it.dur
                elif kind is None or isinstance(it, kind):
                    out.append((t, it))
        out.sort(key=lambda e: e[0])
        return out

    def __repr__(self) -> str:
        return f"Part({self.name!r}, {self.instrument!r})"


class Drift:
    """A span over which a part's playback gets `ahead` quarter notes ahead
    of (or, negative, behind) the written time. See Part.drift."""
    __slots__ = ("start", "end", "ahead", "text")

    def __init__(self, start: Fraction, end: Fraction, ahead: Fraction, text: str | None = None):
        self.start, self.end, self.ahead = start, end, ahead
        self.text = text or f"gradually {'accel.' if ahead > 0 else 'rit.'} (to {ahead_name(ahead)})"

    def __repr__(self) -> str:
        return f"Drift({self.start}, {self.end}, {self.ahead})"


def ahead_name(ahead: Fraction) -> str:
    """'1/16 ahead': the offset as a note value (a quarter is 1/4)."""
    v = abs(ahead) / 4
    return f"{v.numerator}/{v.denominator}" + (" ahead" if ahead > 0 else " behind")


class Loop:
    """A passage placed `times` times in a row by Part.loop(): where it
    starts, how long one pass is. Only a statement of intent; the notes are
    ordinary placements."""
    __slots__ = ("part", "start", "body", "times")

    def __init__(self, part: Part, start: Fraction, body: Fraction, times: int):
        self.part, self.start, self.body, self.times = part, start, body, times

    @property
    def end(self) -> Fraction:
        return self.start + self.body * self.times


class Section:
    """A named stretch of the piece starting at a bar: a rehearsal mark."""
    __slots__ = ("bar", "label", "description")

    def __init__(self, bar: int, label: str, description: str | None = None):
        self.bar, self.label, self.description = bar, label, description

    def __repr__(self) -> str:
        return f"Section({self.bar}, {self.label!r})"


class TempoMark:
    """A tempo indication at a point (text and/or metronome mark), or a
    gradual change over a span (rit./accel. to a target tempo)."""

    def __init__(self, start: Fraction, text: str | None = None, bpm: float | None = None,
                 end: Fraction | None = None):
        self.start, self.text, self.bpm, self.end = start, text, bpm, end

    @property
    def gradual(self) -> bool:
        return self.end is not None

    def __repr__(self) -> str:
        return f"TempoMark({self.start}, {self.text!r}, {self.bpm}, end={self.end})"


class Score:
    """A piece: meter, tempo, key, and an ordered list of parts (top to bottom).

    tempo is the starting metronome mark in quarter notes per minute;
    tempo_text the printed indication ("Allegro agitato"). Later tempo
    changes go through tempo_mark(), rit() and accel().
    """

    def __init__(self, title: str = "", meter=(4, 4),
                 tempo: float = 100, key: str | Scale = "C major",
                 tempo_text: str | None = None, composer: str | None = None):
        self.title = title
        self.composer = composer
        first = Meter.parse(meter)
        self.meter = (first.num, first.den)     # the opening time signature
        self._meters: dict[int, Meter] = {1: first}
        self._free: dict[int, Meter] = {}
        self._starts: list[Fraction] = [Fraction(0)]   # bar -> start time, extended on demand
        self.tempo = tempo
        self.key = parse_key(key)
        self.parts: list[Part] = []
        self.tempo_marks: list[TempoMark] = [TempoMark(Fraction(0), tempo_text, tempo)]
        self.loops: list[Loop] = []
        self.sections: list[Section] = []

    def part(self, name: str, instrument: str | None = None, **kw) -> Part:
        if any(p.name == name for p in self.parts):
            raise ValueError(f"duplicate part name {name!r}")
        p = Part(self, name, instrument, **kw)
        self.parts.append(p)
        return p

    def ordered_parts(self) -> list[Part]:
        """Parts top to bottom as printed: by staff, in order of each staff's
        first appearance; parts sharing a staff stay in creation order."""
        staves = list(dict.fromkeys(p.staff for p in self.parts))
        return [p for st in staves for p in self.parts if p.staff == st]

    def piano(self, upper: str = "rh", lower: str = "lh", name: str = "Piano") -> tuple[Part, Part]:
        """A grand staff: right hand (treble) and left hand (bass), one MIDI channel."""
        return (self.part(upper, "piano", group=name, clef="treble", channel=name),
                self.part(lower, "piano", group=name, clef="bass", channel=name))

    def organ(self, upper: str = "rh", lower: str = "lh", pedal: str = "pedal",
              name: str = "Organ") -> tuple[Part, Part, Part]:
        """Two manual staves in a brace and a pedal staff below, with a 16'
        stop on the pedal. Add more voices with
        score.part("alto", "organ", group="Organ", staff="rh")."""
        return (self.part(upper, "organ", group=name, clef="treble"),
                self.part(lower, "organ", group=name, clef="bass"),
                self.part(pedal, "pedal", group=name, clef="bass", brace=False, couplers=(0, -12)))

    # --- tempo --------------------------------------------------------------

    def pos(self, at) -> Fraction:
        """A position given as a bar number or a (bar, beat) tuple."""
        return self.time(*at) if isinstance(at, tuple) else self.time(at)

    def tempo_mark(self, at, text: str | None = None, bpm: float | None = None) -> "Score":
        """score.tempo_mark(20, "Più mosso", 144); score.tempo_mark((31, 3), "a tempo", 132)"""
        self.tempo_marks.append(TempoMark(self.pos(at), text, bpm))
        self.tempo_marks.sort(key=lambda m: m.start)
        return self

    def rit(self, start, end, to: float, text: str = "rit.") -> "Score":
        """Gradually slow from `start` to `end` (bar or (bar, beat)), arriving at `to`."""
        self.tempo_marks.append(TempoMark(self.pos(start), text, to, self.pos(end)))
        self.tempo_marks.sort(key=lambda m: m.start)
        return self

    def accel(self, start, end, to: float, text: str = "accel.") -> "Score":
        return self.rit(start, end, to, text)

    # --- form ---------------------------------------------------------------

    def section(self, bar: int, label: str, description: str | None = None) -> "Score":
        """A rehearsal mark at bar N: score.section(33, "B", "the pattern thins").
        Sections run to the next one (the last to the end); views take
        --section B or B-C instead of --bars, and form() lists them."""
        label = str(label)
        if bar < 1:
            raise ValueError(f"bars are numbered from 1 (got {bar})")
        if any(s.label == label for s in self.sections):
            raise ValueError(f"duplicate section label {label!r}")
        if any(s.bar == bar for s in self.sections):
            raise ValueError(f"bar {bar} already starts a section")
        self.sections.append(Section(bar, label, description))
        self.sections.sort(key=lambda s: s.bar)
        return self

    def section_bars(self, spec: str) -> tuple[int, int]:
        """(first bar, last bar) of a section label "B" or a span "B-C"."""
        names = {s.label: i for i, s in enumerate(self.sections)}
        a, b = (spec, spec) if spec in names else (spec.partition("-")[0], spec.partition("-")[2] or spec)
        if a not in names or b not in names or names[a] > names[b]:
            known = ", ".join(s.label for s in self.sections) or "none defined"
            raise ValueError(f"no section {spec!r} (sections: {known})")
        i = names[b] + 1
        last = self.sections[i].bar - 1 if i < len(self.sections) else self.bars
        return self.sections[names[a]].bar, last

    def __getitem__(self, name: str) -> Part:
        for p in self.parts:
            if p.name == name:
                return p
        raise KeyError(name)

    # --- meter ------------------------------------------------------

    def meter_change(self, bar: int, meter) -> "Score":
        """A new time signature from bar N on: (3, 4), "3/4", "2+2+3/8"."""
        self._meters[bar] = Meter.parse(meter)
        self._starts = [Fraction(0)]
        return self

    def free_bar(self, bar: int, length) -> "Score":
        """Bar N is unmetered: no time signature, `length` quarter notes long
        (a cadenza, an unmeasured prelude). The meter resumes after it.
        Long free bars may break across lines at any beat."""
        self._free[bar] = Meter.unmetered(length)
        self._starts = [Fraction(0)]
        return self

    def meter_at(self, bar: int) -> Meter:
        if bar in self._free:
            return self._free[bar]
        return self._meters[max(b for b in self._meters if b <= max(bar, 1))]

    # --- time ---------------------------------------------------------------

    @property
    def bar_len(self) -> Fraction:
        """Length of a bar in the opening meter (see meter_at for the others)."""
        return self.meter_at(1).bar_len

    @property
    def beat_len(self) -> Fraction:
        return self.meter_at(1).beat_len

    def bar_start(self, bar: int) -> Fraction:
        """Absolute time of the start of bar N."""
        while len(self._starts) < bar:
            n = len(self._starts)                  # bar n's start is known; add bar n+1's
            self._starts.append(self._starts[-1] + self.meter_at(n).bar_len)
        return self._starts[bar - 1]

    def time(self, bar: int, beat=1) -> Fraction:
        """Absolute time (in quarter notes) of bar N, beat B (both 1-based).
        In a free bar a beat is a quarter note."""
        beat = _exact(beat)
        if bar < 1 or beat < 1:
            raise ValueError(f"bars and beats are numbered from 1 (got bar {bar}, beat {beat})")
        m = self.meter_at(bar)
        if (beat - 1) * m.beat_len >= m.bar_len:
            raise ValueError(f"beat {beat} is past the end of bar {bar} ({m.text})")
        return self.bar_start(bar) + (beat - 1) * m.beat_len

    def position(self, t: Fraction) -> tuple[int, Fraction]:
        """Inverse of time(): (bar, beat) for an absolute time."""
        while self._starts[-1] <= t:
            self.bar_start(len(self._starts) + 1)
        bar = bisect.bisect_right(self._starts, t)
        return bar, (t - self._starts[bar - 1]) / self.meter_at(bar).beat_len + 1

    def is_barline(self, t: Fraction) -> bool:
        return t == self.bar_start(self.position(t)[0])

    def barlines(self, nbars: int) -> list[Fraction]:
        """Start times of bars 1..nbars+1 (the last is where bar nbars ends)."""
        self.bar_start(nbars + 1)
        return self._starts[:nbars + 1]

    def metric_level(self, t: Fraction) -> int:
        """3 downbeat, 2 other strong beat, 1 other pulse, 0 other beat, -1 between beats."""
        bar, _ = self.position(t)
        m, off = self.meter_at(bar), t - self.bar_start(bar)
        if off == 0:
            return 3
        if off in m.strong():
            return 2
        if off in m.pulses():
            return 1
        return 0 if off % m.beat_len == 0 else -1

    def meter_changes(self, nbars: int) -> list[tuple[int, Meter]]:
        """(bar, meter) for bar 1 and every bar whose meter differs from the
        bar before it, up to nbars."""
        out: list[tuple[int, Meter]] = []
        for b in range(1, nbars + 1):
            m = self.meter_at(b)
            if not out or m != out[-1][1]:
                out.append((b, m))
        return out

    def where(self, t: Fraction) -> str:
        from .views import fmt_pos
        return fmt_pos(self, t)

    @property
    def end(self) -> Fraction:
        return max((p.end for p in self.parts), default=Fraction(0))

    @property
    def bars(self) -> int:
        bar, beat = self.position(self.end)
        return max(1, bar - 1 if beat == 1 else bar)

    def seconds(self, t: Fraction) -> float:
        from .perform import tempo_map, seconds_at
        return seconds_at(tempo_map(self), t)

    # --- output -------------------------------------------------------------

    def melody(self, **kw) -> str:
        from .views import melody
        return melody(self, **kw)

    def grid(self, **kw) -> str:
        from .views import grid
        return grid(self, **kw)

    def observe(self, parts=None):
        """What the voices are doing: analysis.observe()."""
        from .analysis import observe
        return observe(self, parts)

    def check(self, **kw) -> str:
        from .views import check
        return check(self, **kw)

    def write_midi(self, path: str) -> None:
        from .midi import write_midi
        write_midi(self, path)

    def render_wav(self, path: str, soundfont: str | None = None) -> None:
        from .render import render_wav
        render_wav(self, path, soundfont)

    def lens(self, **kw) -> str:
        from .views import lens
        return lens(self, **kw)

    def form(self, **kw) -> str:
        from .views import form
        return form(self, **kw)

    def lilypond(self) -> str:
        from .lilypond import lilypond
        return lilypond(self)

    def engrave(self, path: str, fmt: str = "pdf") -> str:
        from .lilypond import engrave
        return engrave(self, path, fmt)

    def __repr__(self) -> str:
        return f"Score({self.title!r}, {len(self.parts)} parts, {self.bars} bars)"
