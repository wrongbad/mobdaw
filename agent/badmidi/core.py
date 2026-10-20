"""Core values: pitches, chords, notes, rests, bar anchors and motifs.

All time is measured in quarter notes, as exact Fractions, so durations
never drift from floating point error.
"""
from __future__ import annotations

import re
from contextlib import contextmanager
from fractions import Fraction
from typing import Callable, Iterable, NamedTuple

SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
LETTERS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

_names: list[str] = SHARP_NAMES


@contextmanager
def spelling(how):
    """Spell computed pitches inside the block: True = flats, False = sharps,
    or a key (anything with .names, a 12-entry pitch-class -> name table)."""
    global _names
    table = how.names if hasattr(how, "names") else (FLAT_NAMES if how else SHARP_NAMES)
    old, _names = _names, table
    try:
        yield
    finally:
        _names = old


def pc_name(pc: int, flats: bool | None = None) -> str:
    if flats is None:
        return _names[pc % 12]
    return (FLAT_NAMES if flats else SHARP_NAMES)[pc % 12]


def octave_of(midi: int, name: str) -> int:
    """Octave number for a pitch spelled `name`: B#3 is MIDI 60, Cb4 is 59."""
    alter = name.count("#") - name.count("b")
    return (midi - alter - LETTERS[name[0]]) // 12 - 1


# Durations in quarter notes. Suffix "d" = dotted, "3" = triplet. Any other
# tuplet is spelled the same way (see duration()): e5, s7, q5:3.
DURATIONS: dict[str, Fraction] = {
    "w": Fraction(4), "h": Fraction(2), "q": Fraction(1), "e": Fraction(1, 2),
    "s": Fraction(1, 4), "t": Fraction(1, 8),
    "wd": Fraction(6), "hd": Fraction(3), "qd": Fraction(3, 2), "ed": Fraction(3, 4), "sd": Fraction(3, 8),
    "h3": Fraction(4, 3), "q3": Fraction(2, 3), "e3": Fraction(1, 3), "s3": Fraction(1, 6),
}
DURATION_CODES = {v: k for k, v in DURATIONS.items()}
BASE_VALUES = {k: DURATIONS[k] for k in "whqest"}
_CODE = re.compile(r"([whqest])(d?)(?:(\d+)(?::(\d+))?)?")


def tuplet_space(n: int) -> int:
    """How many notes an n-tuplet takes the place of, by default: the power
    of two below n (3 in the time of 2, 5 or 7 in the time of 4, 9 of 8).
    A power of two itself (a duplet in 6/8) needs its ratio spelled: q2:3."""
    return 1 << (n.bit_length() - 1)


def duration(code: str) -> Fraction:
    """A duration code in quarter notes: q, qd (dotted), e3 (triplet eighth),
    s5 (quintuplet sixteenth: five in the time of four), e7 (seven in the
    time of four), q5:3 (five in the time of three), q2:3 (a duplet in 6/8)."""
    return _duration(code)[0]


WRITTEN = {d for k, d in DURATIONS.items() if "3" not in k}     # plain and dotted values


def _tuplet_ok(dur: Fraction, tuplet) -> bool:
    """Is dur one plain or dotted value under this tuplet ratio?"""
    return tuplet is not None and dur * Fraction(tuplet[0], tuplet[1]) in WRITTEN


def _duration(code: str) -> tuple[Fraction, tuple[int, int] | None]:
    """(length, tuplet ratio as written or None)."""
    if code in DURATIONS:
        m = _CODE.fullmatch(code)
        return DURATIONS[code], ((int(m[3]), tuplet_space(int(m[3]))) if m and m[3] else None)
    m = _CODE.fullmatch(code)
    if not m:
        raise ValueError(f"unknown duration .{code}; e.g. q qd e3 s5 e7 q5:3")
    base, dot, n, space = m.groups()
    d = BASE_VALUES[base] * (Fraction(3, 2) if dot else 1)
    if n is None:
        return d, None
    n = int(n)
    if not space and n & (n - 1) == 0:
        raise ValueError(f"bad tuplet .{code}: say what {n} notes take the time of, e.g. .{base}{dot}{n}:3")
    space = int(space) if space else tuplet_space(n)
    if n < 2 or space < 1 or n == space:
        raise ValueError(f"bad tuplet .{code}: {n} in the time of {space}")
    return d * Fraction(space, n), (n, space)


_TUPLET_CODES: dict[Fraction, str] = {}
_TUPLET_RATIOS: dict[Fraction, tuple[int, int]] = {}
for _n in (3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15):      # first spelling wins: s3 before e6
    for _b in "whqest":
        _TUPLET_CODES.setdefault(duration(f"{_b}{_n}"), f"{_b}{_n}")
        _TUPLET_RATIOS.setdefault(duration(f"{_b}{_n}"), (_n, tuplet_space(_n)))
# then explicit ratios (q5:3). Notes squeezed into more than their space (12:11)
# come before notes stretched (6:11), so a length with no tuplet of its own is
# written as the compressed ratio: s12:11, not t6:11.
for _squeeze in (True, False):
    for _n in range(2, 16):
        for _sp in range(1, 16):
            if (_n > _sp) == _squeeze and _n != _sp:
                for _b in "whqest":
                    _d = duration(f"{_b}{_n}:{_sp}")
                    _TUPLET_CODES.setdefault(_d, f"{_b}{_n}:{_sp}")
                    _TUPLET_RATIOS.setdefault(_d, (_n, _sp))


def derived_tuplet(d: Fraction) -> tuple[int, int] | None:
    """The tuplet ratio a length is written with when it has none of its own
    (the one dur_suffix prints): 11/48 -> (12, 11); None for plain values."""
    return _TUPLET_RATIOS.get(Fraction(d))


def as_duration(x) -> Fraction:
    """Coerce a number of quarter notes to an exact positive Fraction."""
    if isinstance(x, bool):
        raise TypeError(f"duration must be a number of quarter notes, got {x!r}")
    if isinstance(x, Fraction):
        d = x
    elif isinstance(x, int):
        d = Fraction(x)
    elif isinstance(x, float):
        d = Fraction(x).limit_denominator(192)
    else:
        raise TypeError(f"duration must be a number of quarter notes, got {x!r}")
    if d <= 0:
        raise ValueError(f"duration must be positive, got {x!r}")
    return d


def fmt_number(x: Fraction) -> str:
    """3 -> '3', 5/2 -> '2.5', 5/3 -> '(5/3)'."""
    x = Fraction(x)
    if x.denominator == 1:
        return str(x.numerator)
    if x.denominator & (x.denominator - 1) == 0:  # power of two: exact decimal
        return f"{float(x):g}"
    return f"({x.numerator}/{x.denominator})"


def dur_suffix(d: Fraction) -> str:
    code = DURATION_CODES.get(d) or _TUPLET_CODES.get(d)
    return f".{code}" if code else f"*{fmt_number(d)}"


class _Durational:
    """Mixin: anything that becomes a Note once given a duration.

    E4.q, E4.qd (dotted), E4.e3 (triplet), or E4 * 1.5 (in quarter notes).
    """
    __slots__ = ()

    def _with_dur(self, d: Fraction) -> "Note":
        raise NotImplementedError

    def __mul__(self, beats) -> "Note":
        return self._with_dur(as_duration(beats))

    __rmul__ = __mul__

    w = property(lambda self: self._with_dur(DURATIONS["w"]))
    h = property(lambda self: self._with_dur(DURATIONS["h"]))
    q = property(lambda self: self._with_dur(DURATIONS["q"]))
    e = property(lambda self: self._with_dur(DURATIONS["e"]))
    s = property(lambda self: self._with_dur(DURATIONS["s"]))
    t = property(lambda self: self._with_dur(DURATIONS["t"]))
    wd = property(lambda self: self._with_dur(DURATIONS["wd"]))
    hd = property(lambda self: self._with_dur(DURATIONS["hd"]))
    qd = property(lambda self: self._with_dur(DURATIONS["qd"]))
    ed = property(lambda self: self._with_dur(DURATIONS["ed"]))
    sd = property(lambda self: self._with_dur(DURATIONS["sd"]))
    h3 = property(lambda self: self._with_dur(DURATIONS["h3"]))
    q3 = property(lambda self: self._with_dur(DURATIONS["q3"]))
    e3 = property(lambda self: self._with_dur(DURATIONS["e3"]))
    s3 = property(lambda self: self._with_dur(DURATIONS["s3"]))

    def __getattr__(self, name: str):
        # every other duration code: E4.s5, E4.e7, (C4 & E4).q5
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            d, tup = _duration(name)
            n = self._with_dur(d)
            return Note(n.pitches, n.dur, n.tied, n.art, tup)
        except ValueError:
            raise AttributeError(f"{type(self).__name__} has no attribute or duration code {name!r}") from None


class Pitch(_Durational):
    """A MIDI pitch. E4 + 7 -> B4; B4 - E4 -> 7; E4 & G4 -> Chord.

    spell remembers how a pitch was written ("Bb", "B#"), so it prints the
    same way back. Computed pitches (transpositions etc.) have no spelling
    of their own and are spelled by the key of the score being shown.
    """
    __slots__ = ("midi", "spell")

    def __init__(self, midi: int, spell: str | None = None):
        if not 0 <= midi <= 127:
            raise ValueError(f"pitch out of MIDI range: {midi}")
        self.midi = int(midi)
        self.spell = spell

    @classmethod
    def parse(cls, text: str) -> "Pitch":
        m = re.fullmatch(r"([A-Ga-g])([#sb]*)(-?\d)", text.strip())
        if not m:
            raise ValueError(f"can't parse pitch {text!r} (expected e.g. 'E4', 'F#3', 'Bb2')")
        letter, acc, octave = m.groups()
        sharps = acc.count("#") + acc.count("s")
        pc = LETTERS[letter.upper()] + sharps - acc.count("b")
        spell = letter.upper() + "#" * sharps + "b" * acc.count("b") if acc else None
        return cls(12 * (int(octave) + 1) + pc, spell)

    @property
    def pc(self) -> int:
        return self.midi % 12

    @property
    def octave(self) -> int:
        return self.midi // 12 - 1

    @property
    def name(self) -> str:
        n = self.spell or pc_name(self.pc)
        return f"{n}{octave_of(self.midi, n)}"

    def __repr__(self) -> str:
        return self.name.replace("#", "s")  # valid Python name: Fs4, Bb3

    def __str__(self) -> str:
        return self.name

    def __add__(self, semitones: int) -> "Pitch":
        if isinstance(semitones, int) and not isinstance(semitones, bool):
            # whole octaves keep the written spelling: D#4 + 12 is D#5, not Eb5
            return Pitch(self.midi + semitones, self.spell if semitones % 12 == 0 else None)
        return NotImplemented

    __radd__ = __add__

    def __sub__(self, other):
        if isinstance(other, Pitch):
            return self.midi - other.midi
        if isinstance(other, int):
            return Pitch(self.midi - other)
        return NotImplemented

    def __and__(self, other) -> "Chord":
        return Chord(self, other)

    def __eq__(self, other) -> bool:
        return isinstance(other, Pitch) and other.midi == self.midi

    def __hash__(self) -> int:
        return hash(self.midi)

    def __lt__(self, other: "Pitch") -> bool:
        return self.midi < other.midi

    def __le__(self, other: "Pitch") -> bool:
        return self.midi <= other.midi

    def __gt__(self, other: "Pitch") -> bool:
        return self.midi > other.midi

    def __ge__(self, other: "Pitch") -> bool:
        return self.midi >= other.midi

    def _with_dur(self, d: Fraction) -> "Note":
        return Note((self,), d)


def as_pitch(x) -> Pitch:
    if isinstance(x, Pitch):
        return x
    if isinstance(x, int) and not isinstance(x, bool):
        return Pitch(x)
    if isinstance(x, str):
        return Pitch.parse(x)
    raise TypeError(f"expected a pitch, got {x!r}")


class Chord(_Durational):
    """Simultaneous pitches without a duration yet: (C4 & E4 & G4).h"""
    __slots__ = ("pitches",)

    def __init__(self, *pitches):
        ps: set[Pitch] = set()
        for p in pitches:
            ps.update(p.pitches if isinstance(p, Chord) else (as_pitch(p),))
        self.pitches = tuple(sorted(ps))

    def __and__(self, other) -> "Chord":
        return Chord(self, other)

    __rand__ = __and__

    def __add__(self, semitones: int) -> "Chord":
        return Chord(*(p + semitones for p in self.pitches))

    def __repr__(self) -> str:
        return "(" + " & ".join(map(repr, self.pitches)) + ")"

    def _with_dur(self, d: Fraction) -> "Note":
        return Note(self.pitches, d)


# Articulation suffixes, in canonical order.
ARTICULATIONS = {">": "accent", "^": "marcato", "'": "staccato", "_": "tenuto", "@": "fermata"}


class Note:
    """Pitches sounding for a duration. No pitches = rest; several = chord.

    tied=True ties the note into the next one if it has the same pitches
    (written E4.h.tie in Python, E4.h~ in strings): it sounds as one note.
    art holds articulation suffixes (see ARTICULATIONS): E4.q> is accented.
    tuplet is the ratio it was written with, (5, 3) for .q5:3, so it prints
    and engraves that way. It is notation only: two notes of the same length
    are equal whatever their tuplet.
    """
    __slots__ = ("pitches", "dur", "tied", "art", "tuplet")

    def __init__(self, pitches: Iterable = (), dur=1, tied: bool = False, art: str = "", tuplet=None):
        self.pitches: tuple[Pitch, ...] = tuple(sorted({as_pitch(p) for p in pitches}))
        self.dur: Fraction = as_duration(dur)
        self.tied = bool(tied) and bool(self.pitches)
        bad = set(art) - set(ARTICULATIONS)
        if bad:
            raise ValueError(f"unknown articulation {''.join(sorted(bad))!r}; known: {' '.join(ARTICULATIONS)}")
        if not self.pitches and set(art) - {"@"}:
            raise ValueError("a rest can only take a fermata (@)")
        self.art = "".join(c for c in ARTICULATIONS if c in art)
        self.tuplet = tuple(tuplet) if _tuplet_ok(self.dur, tuplet) else None

    @property
    def is_rest(self) -> bool:
        return not self.pitches

    @property
    def pitch(self) -> Pitch:
        if len(self.pitches) != 1:
            raise ValueError(f"{self!r} is not a single pitch")
        return self.pitches[0]

    @property
    def dot(self) -> "Note":
        return Note(self.pitches, self.dur * Fraction(3, 2), self.tied, self.art, self.tuplet)

    @property
    def tie(self) -> "Note":
        return Note(self.pitches, self.dur, True, self.art, self.tuplet)

    def articulate(self, art: str) -> "Note":
        return Note(self.pitches, self.dur, self.tied, self.art + art, self.tuplet)

    accent = property(lambda self: self.articulate(">"))
    marcato = property(lambda self: self.articulate("^"))
    staccato = property(lambda self: self.articulate("'"))
    tenuto = property(lambda self: self.articulate("_"))
    fermata = property(lambda self: self.articulate("@"))

    def with_dur(self, dur) -> "Note":
        """Same note, new length; keeps its tuplet if the new length still needs one."""
        keep = self.tuplet if as_duration(dur) not in WRITTEN else None
        return Note(self.pitches, dur, self.tied, self.art, keep)

    def with_tied(self, tied: bool) -> "Note":
        return Note(self.pitches, self.dur, tied, self.art, self.tuplet)

    def map_pitches(self, fn: Callable[[Pitch], Pitch]) -> "Note":
        return Note(tuple(fn(p) for p in self.pitches), self.dur, self.tied, self.art, self.tuplet)

    def __add__(self, other) -> "Motif":
        return Motif(self, other)

    def __radd__(self, other) -> "Motif":
        return Motif(other, self)

    def __eq__(self, other) -> bool:
        return isinstance(other, Note) and self._key() == other._key()

    def __hash__(self) -> int:
        return hash(self._key())

    def _key(self):
        return self.pitches, self.dur, self.tied, self.art

    def suffix(self) -> str:
        """The duration part of the token: '.q', '.e5', '.q5:3', '*0.3'."""
        if self.tuplet:
            n, space = self.tuplet
            written = DURATION_CODES[self.dur * Fraction(n, space)]
            return f".{written}{n}" + (f":{space}" if space != tuplet_space(n) else "")
        return dur_suffix(self.dur)

    def head(self) -> str:
        """The pitch part of the token: 'E4', '[C4 E4 G4]', 'R'."""
        if self.is_rest:
            return "R"
        if len(self.pitches) == 1:
            return repr(self.pitches[0])
        return "[" + " ".join(map(repr, self.pitches)) + "]"

    def __repr__(self) -> str:
        """The string-notation token: E4.q, [C4 E4 G4].h, R.e, E4.h~, E4.q>"""
        return self.head() + self.suffix() + self.art + ("~" if self.tied else "")


class _Rest(_Durational):
    """R.q, R.h, R * 3 ..."""
    __slots__ = ()

    def _with_dur(self, d: Fraction) -> Note:
        return Note((), d)

    def __repr__(self) -> str:
        return "R"


R = _Rest()


class Bar:
    """An anchor inside a motif asserting "a barline falls here".

    Bar(14) additionally asserts it is the start of bar 14. `badmidi check`
    reports any anchor that doesn't land where it claims, so counting errors
    stay local instead of silently shifting everything after them.
    """
    __slots__ = ("number",)

    def __init__(self, number: int | None = None):
        self.number = number

    def __eq__(self, other) -> bool:
        return isinstance(other, Bar) and other.number == self.number

    def __hash__(self) -> int:
        return hash(("Bar", self.number))

    def __repr__(self) -> str:
        return "BAR" if self.number is None else f"Bar({self.number})"

    @property
    def token(self) -> str:
        """String-notation form: '|' or '|14'."""
        return "|" if self.number is None else f"|{self.number}"


BAR = Bar()


DYNAMICS = ("ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fp", "rfz")


class Mark:
    """A marking at a point in the music, as on a printed score.

        dynamic    p  ff  sfz ...      Mark("dyn", "p")      dyn("p")
        hairpin    <  >  (end: !)      CRESC, DIM, HAIRPIN_END
        pedal      ped  *              PED (down, or change if down), PED_UP
        text       "con fuoco"         text("con fuoco")

    A hairpin runs until the next dynamic (its target) or an explicit !.
    """
    __slots__ = ("kind", "value")
    TOKENS = {"cresc": "<", "dim": ">", "end": "!", "ped": "ped", "pedup": "*"}

    def __init__(self, kind: str, value: str | None = None):
        if kind == "dyn" and value not in DYNAMICS:
            raise ValueError(f"unknown dynamic {value!r}; known: {' '.join(DYNAMICS)}")
        if kind not in self.TOKENS and kind not in ("dyn", "text"):
            raise ValueError(f"unknown mark kind {kind!r}")
        self.kind, self.value = kind, value

    @property
    def token(self) -> str:
        if self.kind == "dyn":
            return self.value
        if self.kind == "text":
            return f'"{self.value}"'
        return self.TOKENS[self.kind]

    def __eq__(self, other) -> bool:
        return isinstance(other, Mark) and (other.kind, other.value) == (self.kind, self.value)

    def __hash__(self) -> int:
        return hash((self.kind, self.value))

    def __repr__(self) -> str:
        return self.token


def dyn(level: str) -> Mark:
    return Mark("dyn", level)


def text(words: str) -> Mark:
    return Mark("text", words)


CRESC, DIM, HAIRPIN_END = Mark("cresc"), Mark("dim"), Mark("end")
PED, PED_UP = Mark("ped"), Mark("pedup")


def _offset(x) -> Fraction:
    """A non-negative length in quarter notes (0 allowed)."""
    return as_duration(x) if x else Fraction(0)


class Event(NamedTuple):
    """A note and the markings written just before it (they belong to its
    onset): what restructuring moves around together. `for note, marks in
    m.events()` unpacks it."""
    note: Note
    marks: tuple = ()


class Motif:
    """An immutable sequence of notes (and bar anchors). Every transformation
    returns a new Motif, so ideas can be named and developed like values:

        theme  = M(E4.q, G4.e, A4.e, B4.h)
        answer = theme.invert(around=A4).transpose(5)
    """
    __slots__ = ("items",)

    def __init__(self, *items):
        out: list[Note | Bar] = []
        for it in items:
            self._flatten(it, out)
        self.items: tuple[Note | Bar, ...] = tuple(out)

    @staticmethod
    def _flatten(it, out: list) -> None:
        if isinstance(it, Motif):
            out.extend(it.items)
        elif isinstance(it, (Note, Bar, Mark)):
            out.append(it)
        elif isinstance(it, str):
            out.extend(parse(it))
        elif isinstance(it, (list, tuple)):
            for x in it:
                Motif._flatten(x, out)
        elif isinstance(it, (Pitch, Chord, _Rest)):
            raise TypeError(f"{it!r} has no duration; write {it!r}.q, {it!r}.h, or {it!r} * beats")
        else:
            raise TypeError(f"can't put {it!r} in a motif")

    # --- inspection ---------------------------------------------------------

    @property
    def notes(self) -> list[Note]:
        return [n for n in self.items if isinstance(n, Note)]

    @property
    def dur(self) -> Fraction:
        return sum((n.dur for n in self.notes), Fraction(0))

    @property
    def pitches(self) -> list[Pitch]:
        """Every sounding pitch in order (chords contribute all their pitches)."""
        return [p for n in self.notes for p in n.pitches]

    @property
    def durations(self) -> list[Fraction]:
        return [n.dur for n in self.notes]

    def __len__(self) -> int:
        return len(self.notes)

    def __iter__(self):
        return iter(self.notes)

    def __getitem__(self, i):
        if isinstance(i, slice):
            return Motif(*self.notes[i])
        return self.notes[i]

    def __eq__(self, other) -> bool:
        return isinstance(other, Motif) and other.items == self.items

    def __hash__(self) -> int:
        return hash(self.items)

    def __repr__(self) -> str:
        return f"M({self.text()!r})"

    def text(self) -> str:
        """The motif in string notation; M(m.text()) == m."""
        return " ".join(repr(it) if isinstance(it, Note) else it.token for it in self.items)

    # --- assembly -----------------------------------------------------------

    def __add__(self, other) -> "Motif":
        return Motif(self, other)

    def __radd__(self, other) -> "Motif":
        return Motif(other, self)

    def __mul__(self, n: int) -> "Motif":
        if not isinstance(n, int):
            return NotImplemented
        return Motif(*([self] * n))

    __rmul__ = __mul__

    # --- transformations ----------------------------------------------------

    def map(self, fn: Callable[[Note], Note]) -> "Motif":
        return Motif(*(fn(it) if isinstance(it, Note) else it for it in self.items))

    def map_pitches(self, fn: Callable[[Pitch], Pitch]) -> "Motif":
        return self.map(lambda n: n.map_pitches(fn))

    def map_timed(self, fn: Callable[[Note, int, Fraction], Note]) -> "Motif":
        """Like map, but fn(note, i, t) also gets the note's index (rests
        count) and its onset in quarter notes from the start of the motif.
        Bars and markings stay where they are."""
        timed = iter(enumerate(self.timed()))

        def go(n: Note) -> Note:
            i, (t, _) = next(timed)
            return fn(n, i, t)
        return self.map(go)

    def timed(self) -> list[tuple[Fraction, Note]]:
        """(onset, note) for every note and rest; onset in quarter notes from the start."""
        out, t = [], Fraction(0)
        for n in self.notes:
            out.append((t, n))
            t += n.dur
        return out

    def pipe(self, fn: Callable, *args, **kw):
        """fn(self, *args, **kw): your own transformations chain like the
        built-ins: theme.pipe(additive, 3).pipe(rebar_it).transpose(5)."""
        return fn(self, *args, **kw)

    # --- restructuring ----------------------------------------------------

    def events(self) -> list[Event]:
        """The notes as Events (note, marks written just before it), barlines
        dropped. Marks after the last note are not in the list; restructure()
        keeps them at the end."""
        out, pending = [], []
        for it in self.items:
            if isinstance(it, Mark):
                pending.append(it)
            elif isinstance(it, Note):
                out.append(Event(it, tuple(pending)))
                pending = []
        return out

    @property
    def tail(self) -> tuple[Mark, ...]:
        """Markings after the last note (a final pedal lift, a hairpin end)."""
        out = []
        for it in self.items:
            if isinstance(it, Note):
                out = []
            elif isinstance(it, Mark):
                out.append(it)
        return tuple(out)

    @classmethod
    def from_events(cls, events: Iterable, tail: Iterable[Mark] = ()) -> "Motif":
        """Build a motif from Events (or bare Notes), each marking its note's
        onset. The result has no barlines: rebar() or expect() puts them back.
        A tie that no longer meets a note of the same pitch is dropped."""
        evs = [e if isinstance(e, Event) else Event(e) for e in events]
        items: list = []
        for i, (note, marks) in enumerate(evs):
            if note.tied and i + 1 < len(evs) and evs[i + 1].note.pitches != note.pitches:
                note = note.with_tied(False)
            items.extend(marks)
            items.append(note)
        return cls(*items, *tail)

    def restructure(self, fn: Callable[[list[Event]], Iterable]) -> "Motif":
        """Reorder, drop, repeat or insert notes with fn(events) -> events;
        each note keeps its markings, and marks after the last note stay at
        the end. Barlines are dropped (rebar() them):

            m.restructure(lambda evs: evs[::2])
            m.restructure(lambda evs: [e for e in evs if not e.note.is_rest])"""
        return Motif.from_events(fn(self.events()), self.tail)

    def rotate(self, n: int = 1) -> "Motif":
        """Start n notes in (negative: n back from the end); the notes before
        move to the end. Markings travel with their notes; barlines are
        dropped. A note's tie into the next stays only where they still meet."""
        evs = self.events()
        if not evs:
            return self
        k = n % len(evs)
        if k and evs[k - 1].note.tied:       # its follower is now elsewhere
            evs[k - 1] = evs[k - 1]._replace(note=evs[k - 1].note.with_tied(False))
        return Motif.from_events(evs[k:] + evs[:k], self.tail)

    def rebar(self, meter=(4, 4), start=0) -> "Motif":
        """Put barlines back: replace any anchors with a plain | every bar,
        splitting notes that cross one into tied pieces (rests into rests).
        `start` is how far into the bar the motif begins, in quarter notes
        (3 for a pickup on beat 4 of 4/4). Ends with | if it ends on a barline.
        Markings stay with the onset they were written at; a split note keeps
        its articulations on the first piece and a fermata on the last."""
        from .score import Meter
        m = Meter.parse(meter)
        if m.free is not None:
            raise ValueError("rebar() needs a metered bar, not a free one")
        bar_len, start = m.bar_len, _offset(start)
        if not 0 <= start < bar_len:
            raise ValueError(f"start must be inside the bar: 0 <= start < {fmt_number(bar_len)} quarters")
        out: list = []
        pending: list = []
        room = bar_len - start

        def settle():
            nonlocal room
            if room == 0:
                out.append(BAR)
                room = bar_len
        for it in self.items:
            if isinstance(it, Mark):
                pending.append(it)
            elif isinstance(it, Note):
                settle()
                out.extend(pending)
                pending = []
                sizes = []
                left = it.dur
                while left > room:
                    sizes.append(room)
                    left -= room
                    room = bar_len
                sizes.append(left)
                room -= left
                for i, d in enumerate(sizes):
                    if len(sizes) == 1:
                        out.append(it)
                        break
                    last = i == len(sizes) - 1
                    art = (it.art.replace("@", "") if i == 0 else "") + ("@" if last and "@" in it.art else "")
                    out.append(Note(it.pitches, d, not it.is_rest and (not last or it.tied), art,
                                    it.tuplet if d not in WRITTEN else None))
                    if not last:
                        out.append(BAR)
        settle()
        out.extend(pending)
        return Motif(*out)

    def expect(self, bars: int | None = None, meter=(4, 4), start=0, dur=None) -> "Motif":
        """Raise NotationError now if the motif isn't the length (or its
        barlines aren't where) you meant; returns the motif otherwise, so it
        chains. The message is the one check gives:

            gen(5).expect(bars=2, meter="3/4")    # bars 1-2 of 3/4, from `start`
            gen(5).expect(dur=6)                  # six quarter notes

        Barlines in the motif are checked against the meter too."""
        from .score import Meter, Score
        from . import views
        mt = Meter.parse(meter)
        score = Score(meter=mt)
        if dur is None and bars is None:
            raise ValueError("expect() needs bars= or dur=")
        if any(isinstance(it, Bar) for it in self.items):
            beat = 1 + _offset(start) / mt.beat_len
            score.part("m").at(1, self, beat=beat)
            errors = [msg for lv, _, _, msg in views._issues(score) if lv == "ERROR"]
            if errors:
                raise NotationError(errors[0])
        have = self.dur
        if dur is not None:
            want, what = as_duration(dur), f"{fmt_number(as_duration(dur))} quarters"
        else:
            want, what = bars * mt.bar_len - _offset(start), f"{bars} bar{'s' if bars != 1 else ''} of {mt.text}"
        if have != want:
            off = have - want
            raise NotationError(
                f"motif has {views._beats(score, have, 1)}, expected {views._beats(score, want, 1)} ({what}): "
                f"{views._amount(abs(off))} too {'long' if off > 0 else 'short'}")
        return self

    def transpose(self, n: int, scale=None) -> "Motif":
        """Shift by n semitones, or by n scale steps if a scale/key is given.

        A chromatic transposition is spelled as one interval for the whole
        motif, whichever needs fewer accidentals: C D E up 6 is F# G# A#
        (an augmented fourth), not Gb Ab Bb."""
        if scale is None:
            return self._respelled(lambda p: Pitch(p.midi + n), _letter_shifts(n))
        return self.map_pitches(lambda p: scale.step(p, n))

    def octave(self, n: int = 1) -> "Motif":
        return self.transpose(12 * n)

    def double(self, *intervals: int) -> "Motif":
        """Add each pitch again at the given intervals: double(-12) for octaves
        below, double(12, 24) for two octaves above."""
        return self.map(lambda n: n if n.is_rest else
                        Note(n.pitches + tuple(p + i for p in n.pitches for i in intervals), n.dur, n.tied, n.art))

    def invert(self, around=None, scale=None) -> "Motif":
        """Mirror pitches around a pitch (default: the first pitch).
        Chromatic by default; diatonic if a scale/key is given."""
        if around is None:
            if not self.pitches:
                return self
            around = self.pitches[0]
        axis = as_pitch(around)
        if scale is None:   # letters mirror around the axis's letter too
            al = _LETTER_ORDER.index(_spelled(axis)[0]) + 7 * axis.octave
            return self._respelled(lambda p: Pitch(2 * axis.midi - p.midi),
                                   [lambda name, p: 2 * al - (_LETTER_ORDER.index(name[0]) + 7 * octave_of(p.midi, name))])
        ai, _ = scale.index(axis)

        def flip(p: Pitch) -> Pitch:
            i, alter = scale.index(p)
            return scale.at(2 * ai - i, -alter)
        return self.map_pitches(flip)

    def retrograde(self) -> "Motif":
        """Reverse the notes. Dynamics, hairpins, pedal and text marks are
        dropped: they don't have a meaningful reverse."""
        # A tie joins a note to the one after it, so after reversing, each
        # note takes the tie flag of the note that now follows it.
        notes = self.notes
        ties = [n.tied for n in notes]
        flags = iter([ties[i - 1] if i > 0 else False for i in range(len(notes) - 1, -1, -1)])
        return Motif(*(it.with_tied(next(flags)) if isinstance(it, Note) else it
                       for it in reversed(self.items) if not isinstance(it, Mark)))

    def augment(self, factor=2) -> "Motif":
        f = Fraction(factor) if not isinstance(factor, float) else as_duration(factor)
        return self.map(lambda n: n.with_dur(n.dur * f))

    def diminish(self, factor=2) -> "Motif":
        f = Fraction(factor) if not isinstance(factor, float) else as_duration(factor)
        return self.map(lambda n: n.with_dur(n.dur / f))

    def unbarred(self) -> "Motif":
        """The same music without its barline anchors (| and |N)."""
        return Motif(*(it for it in self.items if not isinstance(it, Bar)))

    def fragment(self, start: int, stop: int | None = None) -> "Motif":
        """Notes start..stop (Python slice semantics: stop excluded)."""
        return self[start:stop]

    def sequence(self, intervals: Iterable[int], scale=None) -> "Motif":
        """The motif followed by copies of itself, each shifted from the
        previous one by the next interval (semitones, or scale steps)."""
        out, cur = [self], self
        for iv in intervals:
            cur = cur.transpose(iv, scale)
            out.append(cur)
        return Motif(*out)

    def rhythm(self, *durs) -> "Motif":
        """Keep the pitches, replace the durations (cycled if fewer given).
        Accepts numbers of quarter notes or another Motif to borrow from."""
        if len(durs) == 1 and isinstance(durs[0], Motif):
            durs = tuple(durs[0].durations)
        if not durs:
            raise ValueError("rhythm() needs at least one duration")
        it = iter(range(len(self.notes)))
        return self.map(lambda n: n.with_dur(durs[next(it) % len(durs)]))

    def with_pitches(self, *pitches) -> "Motif":
        """Keep the rhythm, replace the pitches of non-rest notes (cycled)."""
        if len(pitches) == 1 and isinstance(pitches[0], Motif):
            pitches = tuple(pitches[0].pitches)
        ps = [as_pitch(p) for p in pitches]
        if not ps:
            raise ValueError("with_pitches() needs at least one pitch")
        counter = iter(range(len(self.notes)))
        return self.map(lambda n: n if n.is_rest else Note((ps[next(counter) % len(ps)],), n.dur, n.tied))


    def _respelled(self, move, shifts) -> "Motif":
        """Apply `move` to every pitch, spelling the results by the letter
        shift (from `shifts`) that needs the fewest accidentals overall."""
        pitches = {id(p): p for p in self.pitches}.values()
        best = None
        for shift in shifts:
            names = {}
            for p in pitches:
                name = _spelled(p)
                k = shift(name, p) if callable(shift) else _LETTER_ORDER.index(name[0]) + shift
                names[id(p)] = _name_at(move(p).midi, k)
            if None in names.values():
                continue
            cost = sum(n.count("#") + n.count("b") for n in names.values())
            if best is None or cost < best[0]:
                best = (cost, names)
        names = best[1] if best else {}
        return self.map_pitches(lambda p: Pitch(move(p).midi, names.get(id(p))))


M = Motif
_LETTER_ORDER = "CDEFGAB"


def _spelled(p: Pitch) -> str:
    """A pitch's letter name: as written, or as the current spelling gives it."""
    return p.spell or pc_name(p.pc)


def _name_at(midi: int, letter_index: int) -> str | None:
    """Spell `midi` with the letter at this index (C=0, D=1 ...), or None if
    that needs more than a double sharp or flat."""
    letter = _LETTER_ORDER[letter_index % 7]
    alter = (midi - LETTERS[letter] + 6) % 12 - 6
    if abs(alter) > 2:
        return None
    return letter + ("#" * alter if alter > 0 else "b" * -alter)


def _letter_shifts(semitones: int) -> list[int]:
    """The letter steps an interval of this many semitones can be spelled
    with: 7 -> [4] (a fifth); 6 -> [3, 4] (augmented fourth or diminished fifth)."""
    exact = Fraction(semitones * 7, 12)
    lo = exact.numerator // exact.denominator
    return [lo] if exact.denominator == 1 else sorted({lo, lo + 1}, key=lambda k: abs(k - exact))


def isorhythm(color, talea, notes: int | None = None) -> Motif:
    """A repeating rhythm (talea) laid over a repeating pitch series (color),
    each cycling at its own length, as in a medieval motet or a minimalist
    phase piece. A rest in the talea passes without using up a pitch.

        isorhythm("C4 D4 F4 G4 A4", [1, 0.5, 0.5, 2])       # 5 pitches over 4 durations
        isorhythm(theme, M("C4.q R.e C4.e C4.h"), notes=12)

    color: pitches, chords, a string of pitch names, or a Motif (its pitches,
    chords kept together). talea: numbers of quarter notes, or a Motif or
    string (its durations, rests and articulations). By default it runs until
    both cycles end together; notes= sets how many sounding notes to make."""
    if isinstance(color, str) and not _NOTE.search(color):
        color = color.split()                                  # bare pitch names
    if isinstance(color, (str, Motif)):
        pitches = [n.pitches for n in Motif(color).notes if not n.is_rest]
    else:
        pitches = [c.pitches if isinstance(c, (Chord, Note)) else (as_pitch(c),) for c in color]
    if isinstance(talea, (str, Motif)):
        steps = [(n.dur, n.is_rest, n.art) for n in Motif(talea).notes]
    else:
        steps = [(as_duration(d), False, "") for d in talea]
    sounding = sum(1 for _, rest, _ in steps if not rest)
    if not pitches or not sounding:
        raise ValueError("isorhythm needs at least one pitch and one sounding duration")
    if notes is None:
        from math import lcm
        notes = lcm(len(pitches), sounding)
    out, k, i = [], 0, 0
    while k < notes:
        dur, rest, art = steps[i % len(steps)]
        out.append(Note((), dur) if rest else Note(pitches[k % len(pitches)], dur, art=art))
        k += not rest
        i += 1
    return Motif(*out)


# --- string notation ---------------------------------------------------------
#
#   M("E4.q G4.e A4.e B4.h | [C4 E4 G4].h R.q Fs4.e Bb3.e |5 E4*1.5 E4.h~ | E4.q")
#
# A note token is exactly what the views print: PITCH or [PITCH ...] or R,
# then a duration (.q .ed .e3 ... or *1.5 or *(5/3)), then articulations
# (> ^ ' _ @), then an optional ~ tie. Octaves and durations are always
# explicit; nothing carries over from the previous token, so one mistake
# can't shift the notes after it.
#   |  |14           checked barline; start of bar 14
#   p ff sfz ...     dynamics
#   <  >  !          crescendo / diminuendo hairpin; explicit hairpin end
#   ped  *           pedal down (or change); pedal up
#   "con fuoco"      expression text


class NotationError(ValueError):
    pass


_TOKEN = re.compile(r'"[^"]*"|\|\d*|\[[^\]]*\][^\s|\[]*|[^\s|\[]+')
_MARK_TOKENS = {v: k for k, v in Mark.TOKENS.items()}
_NOTE = re.compile(r"""
    (?P<head> R | \[(?P<chord>[^\]]*)\] | [A-Ga-g][#sb]*-?\d )
    (?: \.(?P<code>[a-z0-9:]+) | \*(?P<num> \d+(?:\.\d+)? | \(\d+/\d+\) | \d+/\d+ ) )
    (?P<art>[>^'_@]*)
    (?P<tie>~)?
    """, re.X)


def parse(source: str) -> list[Note | Bar | Mark]:
    """Parse string notation into notes, bar anchors and marks."""
    out: list[Note | Bar | Mark] = []
    bar = 1
    for m in _TOKEN.finditer(source):
        tok = m.group()
        if tok.startswith("|"):
            out.append(Bar(int(tok[1:])) if len(tok) > 1 else BAR)
            bar += 1
        elif tok.startswith('"'):
            out.append(Mark("text", tok[1:-1]))
        elif tok in DYNAMICS:
            out.append(Mark("dyn", tok))
        elif tok in _MARK_TOKENS:
            out.append(Mark(_MARK_TOKENS[tok]))
        else:
            try:
                out.append(_parse_note(tok))
            except (ValueError, TypeError) as e:
                caret = " " * m.start() + "^" * len(tok)
                raise NotationError(f"{e}\n  in bar {bar} of this string:\n    {source}\n    {caret}") from None
    return out


def _parse_note(tok: str) -> Note:
    m = _NOTE.fullmatch(tok)
    if not m:
        raise NotationError(f"can't read {tok!r}: expected e.g. E4.q, Fs4.e, [C4 E4 G4].h, R.q or E4*1.5")
    tup = None
    if m["code"] is not None:
        try:
            dur, tup = _duration(m["code"])
        except ValueError as e:
            raise NotationError(f"{e} (in {tok!r})") from None
    else:
        dur = as_duration(Fraction(m["num"].strip("()")))
    if m["head"] == "R":
        if m["tie"]:
            raise NotationError(f"a rest can't be tied: {tok!r}")
        return Note((), dur, art=m["art"], tuplet=tup)
    if m["chord"] is not None:
        names = m["chord"].split()
        if not names:
            raise NotationError(f"empty chord in {tok!r}")
        pitches = [Pitch.parse(n) for n in names]
    else:
        pitches = [Pitch.parse(m["head"])]
    return Note(pitches, dur, bool(m["tie"]), m["art"], tup)
