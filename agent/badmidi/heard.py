"""What a recording says, as data a piece can hold: chord spans and the rhythm of a heard part, in score time.

`badmidi.audio.listen` makes these from audio; `badmidi pull --listen` writes them into the piece as `HEARD = {...}`, so
`bass.line(HEARD["guitar"])` and plain Python can read them. No numpy here: a piece loads without the audio extra.
Times are quarter notes from the start of the piece (Fractions), the same as `Part.events()`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction
from typing import NamedTuple

from .core import Motif, Note, Pitch
from .score import INSTRUMENTS, Part, Score

# chord quality -> intervals above the root (mirrors badmidi.audio.hear.QUALITIES, a test keeps them equal)
TONES: dict[str, tuple[int, ...]] = {
    "maj": (0, 4, 7), "min": (0, 3, 7), "7": (0, 4, 7, 10), "maj7": (0, 4, 7, 11), "m7": (0, 3, 7, 10),
    "sus2": (0, 2, 7), "sus4": (0, 5, 7), "dim": (0, 3, 6), "5": (0, 7),
}


def _num(x) -> str:
    x = Fraction(x)
    return str(x.numerator) if x.denominator == 1 else f"Fraction({x.numerator}, {x.denominator})"


def is_unsure(conf: float, alt_conf: float, alt: str | bool = True) -> bool:
    """Is a heard chord one to ask about? There is a rival (`alt`: another root or family, e.g. G against Em, Am against A5; not
    Am against Am7) and either the chord's own confidence is under 0.5 or the rival is more than half as likely. The chart's
    `<- unsure` and the chat reply of `examples/bass_for_take.py` both use this."""
    return bool(alt) and (conf < 0.5 or alt_conf > 0.5 * conf)


class HeardChord(NamedTuple):
    """A chord heard from `start` to `end` (quarters). `bass` is the pitch class the bass plays under it (an inversion if
    it is not the root); `conf` 0..1 is how much better it fits than any chord of another root or family; `alt` is that best
    rival (empty if none) and `alt_conf` its confidence in the same terms (`is_unsure()` compares them); `implied` is 'm' for a
    power chord that the key reads as minor; `src` is 'melody' for a chord guessed from a melody's notes (not heard). quality
    'N' is no chord."""
    start: Fraction
    end: Fraction
    symbol: str
    root: int
    bass: int
    quality: str
    conf: float = 1.0
    alt: str = ""
    alt_conf: float = 0.0
    implied: str = ""
    src: str = ""

    @property
    def dur(self) -> Fraction:
        return self.end - self.start

    @property
    def silent(self) -> bool:
        return self.quality == "N"

    def is_unsure(self) -> bool:
        return is_unsure(self.conf, self.alt_conf, self.alt)

    def tones(self) -> list[int]:
        """Pitch classes of the chord, root first (a power chord is root and fifth)."""
        return [] if self.silent else [(self.root + i) % 12 for i in TONES[self.quality]]

    def third(self) -> int | None:
        """The pitch class of the chord's third (or its sus 2nd/4th); a power chord's is read from `implied`."""
        iv = (3 if self.implied == "m" else 4,) if self.quality == "5" else tuple(i for i in TONES.get(self.quality, ()) if i in (2, 3, 4, 5))
        return None if self.silent or not iv else (self.root + iv[0]) % 12

    def fifth(self) -> int | None:
        return None if self.silent else (self.root + (6 if self.quality == "dim" else 7)) % 12

    def __repr__(self) -> str:
        extra = "".join(f', {k}="{v}"' for k, v in (("alt", self.alt), ("implied", self.implied), ("src", self.src)) if v)
        if self.alt:
            extra = extra.replace(f'alt="{self.alt}"', f'alt="{self.alt}", alt_conf={self.alt_conf:.2f}', 1)
        return f'HeardChord({_num(self.start)}, {_num(self.end)}, "{self.symbol}", {self.root}, {self.bass}, "{self.quality}", {self.conf:.2f}{extra})'


class HeardNote(NamedTuple):
    """A note heard from `start` to `end` (quarters, quantized), MIDI `pitch` (tuning-shifted), `vel` 1..127, `conf` 0..1;
    `raw` is where it was heard before quantizing, in quarters (a float)."""
    start: Fraction
    end: Fraction
    pitch: int
    vel: int = 90
    conf: float = 1.0
    raw: float = 0.0

    @property
    def dur(self) -> Fraction:
        return self.end - self.start

    def __repr__(self) -> str:
        return f"HeardNote({_num(self.start)}, {_num(self.end)}, {self.pitch}, {self.vel}, {self.conf:.2f}, {self.raw:.3f})"


@dataclass
class Rhythm:
    """Onset strength (0..1) per slot of every bar: `bars` maps a bar's start (quarters) to its slot list; a slot is `slot`
    quarters (a 16th = 1/4 in 4/4), a beat is `beat` quarters."""
    slot: Fraction
    beat: Fraction
    bars: dict[Fraction, list[float]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.slot, self.beat = Fraction(self.slot), Fraction(self.beat)
        self.bars = {Fraction(k): [float(x) for x in v] for k, v in sorted(self.bars.items())}

    def bar_spans(self) -> list[tuple[Fraction, Fraction]]:
        return [(a, a + len(v) * self.slot) for a, v in self.bars.items()]

    def at(self, t) -> float:
        """The strength of the slot starting exactly at t (0 where there is none)."""
        for a, v in self.bars.items():
            k = (Fraction(t) - a) / self.slot
            if k.denominator == 1 and 0 <= k < len(v):
                return v[int(k)]
        return 0.0

    def onsets(self, start, end, min: float = 0.5) -> list[tuple[Fraction, float]]:
        """(time, strength) of every slot in [start, end) at least `min` strong."""
        return [(a + i * self.slot, x) for a, v in self.bars.items() for i, x in enumerate(v)
                if x >= min and start <= a + i * self.slot < end]

    def source(self, ind: str = "") -> str:
        rows = "".join(f"\n{ind}    {_num(a)}: [{', '.join(f'{x:.2f}'.rstrip('0').rstrip('.') or '0' for x in v)}]," for a, v in self.bars.items())
        return f"Rhythm({_num(self.slot)}, {_num(self.beat)}, {{{rows}\n{ind}}})"

    __repr__ = source


@dataclass
class HeardPart:
    """A track as heard: chords per span and the rhythm, plus what the analysis said about the take. `part` is the name of
    the read-only part in the Score ("guitar (heard)"). `bar` is the first bar heard."""
    track: str
    part: str
    key: str
    tuning: float
    grid: str
    bar: int
    chords: list[HeardChord]
    rhythm: Rhythm | None = None
    mode: str = "chords"
    notes: list[HeardNote] = field(default_factory=list)

    def __getitem__(self, k: str):
        if k not in ("chords", "rhythm", "key", "tuning", "track", "bar", "grid", "mode", "part", "notes"):
            raise KeyError(k)
        return getattr(self, k)

    @property
    def end(self) -> Fraction:
        return max([c.end for c in self.chords[-1:]] + [n.end for n in self.notes[-1:]], default=Fraction(0))

    def source(self, var: str) -> str:
        """The constructor call as lines of a piece, an entry of the HEARD dict (see source.to_source)."""
        ind = "        "
        chords = "".join(f"\n{ind}    {c!r}," for c in self.chords)
        rhythm = "None" if self.rhythm is None else self.rhythm.source(ind)
        notes = "".join(f"\n{ind}    {n!r}," for n in self.notes)
        tail = f",\n{ind}notes=[{notes}\n{ind}]" if self.mode == "notes" else ""
        return (f'    "{var}": HeardPart(\n{ind}track="{self.track}", part="{self.part}", key="{self.key}", tuning={self.tuning:.0f}, '
                f'bar={self.bar}, mode="{self.mode}",\n{ind}grid="{self.grid}",\n{ind}chords=[{chords}\n{ind}],\n{ind}rhythm={rhythm}{tail}),')

    def add_to(self, score: Score, instrument: str | None = None) -> Part:
        """The chords as a part of `score` named `self.part`: one block chord per span, voiced in a middle register with the
        bass pitch class lowest, tied across barlines. Silence is a rest. A line heard as notes is its notes instead."""
        inst = instrument or _instrument(self.track)
        part = score.part(self.part, inst)
        if self.mode == "notes":
            t = self.notes[0].start if self.notes else Fraction(0)
            for n in self.notes:
                if n.start > t:
                    t = _place(score, part, t, n.start, [])
                _place(score, part, n.start, n.end, [n.pitch])
                t = n.end
            return part
        for c in self.chords:
            notes = voicing(c)
            t = c.start
            while t < c.end:
                bar, _ = score.position(t)
                stop = min(c.end, score.bar_start(bar + 1))
                last = stop >= c.end
                part._place(t, [Motif(Note(notes, stop - t, tied=not last and bool(notes)))])
                t = stop
        return part


def _place(score: Score, part: Part, t: Fraction, end: Fraction, pitches: list[int]) -> Fraction:
    """Notes (or a rest) from t to end, tied across barlines."""
    while t < end:
        bar, _ = score.position(t)
        stop = min(end, score.bar_start(bar + 1))
        part._place(t, [Motif(Note(pitches, stop - t, tied=stop < end and bool(pitches)))])
        t = stop
    return end


def _instrument(track: str) -> str:
    name = track.lower().strip()
    if name in INSTRUMENTS:
        return name
    return next((i for i in INSTRUMENTS if i in name and i not in ("bass", "pedal", "drums")), "piano")


def voicing(c: HeardChord, bass_low: int = 40, upper_low: int = 55) -> list[int]:
    """MIDI notes for a block chord: the bass pitch class lowest (E2..D#3), the other chord tones closed above G3 (55..66);
    a triad also doubles the bass note in that octave so the chord has four voices."""
    if c.silent:
        return []
    bass = bass_low + (c.bass - bass_low) % 12
    pcs = c.tones()
    upper = [p for p in pcs if p != c.bass % 12] if c.quality != "5" else pcs[1:] + pcs[:1]
    if len(upper) < 3 and c.quality != "5":
        upper.append(c.bass % 12)
    return sorted({bass} | {upper_low + (p - upper_low) % 12 for p in upper})
