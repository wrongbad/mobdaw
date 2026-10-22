"""Notation hints for the mobdaw bridge: how a piece writes each note, in the shape the agent API takes (docs/agent-api.md).

push sends a `hint` with every note it adds or updates, so mobdaw's score view draws the piece as badmidi engraves it:

    on, len   the whole tied chain: onset and length, exact fractions of a quarter (the API wants them clip-relative;
              here they are absolute, `shift` moves them to a clip)
    segs      the written pieces of the chain, as the MusicXML / LilyPond writers split it (`musicxml._voice_pieces`)
    tup       {n, of, start, span}: the tuplet bracket the note is in, as those writers bracket it
    staff, voice   parts sharing a `staff` are voices on it; a track's staves are its distinct `staff`s in order
    spell     the engraved spelling ('F#4', 'Bb3', 'B#3' is middle C)
    art       badmidi's articulation characters, ">^'_" order

Everything is plain JSON (lists, ints, strings), so a hint compares equal to its copy in a snapshot. Pure: nothing here
talks to a server. The server adds `at` itself.
"""
from __future__ import annotations

import bisect
from fractions import Fraction

from .core import spelling
from .lilypond import _clef
from .musicxml import _voice_pieces
from .score import Score

ART_ORDER = ">^'_"
CLEFS = ("treble", "bass", "alto", "tenor", "treble_8", "bass_8")


def fj(q) -> list[int]:
    """An exact fraction as the API writes it: [numerator, denominator]."""
    q = Fraction(q)
    return [q.numerator, q.denominator]


def layout(score: Score, parts: list[str]) -> tuple[dict[str, tuple[int, int]], list[list]]:
    """(part name -> (staff, voice), the parts of each staff): a track's staves are the distinct `staff`s of its parts in the
    order they come, and the parts sharing one are its voices, 1-based, in order."""
    staves: dict[str, list] = {}
    for name in parts:
        p = score[name]
        staves.setdefault(p.staff, []).append(p)
    lay = {p.name: (si, vi) for si, ms in enumerate(staves.values(), 1) for vi, p in enumerate(ms, 1)}
    return lay, list(staves.values())


def clef_name(members: list) -> str:
    """The clef the engraving gives a staff, as a `Track.clefs` entry."""
    c = _clef(members).strip('"')
    return c if c in CLEFS else "bass" if c.startswith("bass") else "treble"


def clefs_of(score: Score, parts: list[str]) -> list[str] | None:
    """One clef per staff of the track, top first; None for a drum track or no parts."""
    if not parts or any(score[n].drums for n in parts):
        return None
    return [clef_name(ms) for ms in layout(score, parts)[1]]


def clef_arg(clef: str) -> str:
    """A `Part(clef=...)` value for a `Track.clefs` entry (badmidi quotes the octave clefs)."""
    return f'"{clef}"' if "_" in clef else clef


def _groups(bars, starts) -> dict[int, tuple[Fraction, Fraction]]:
    """id(piece) -> (start, span) of the tuplet bracket it is in, from the flags `_bracket_tuplets` set on the bar's pieces."""
    out: dict[int, tuple[Fraction, Fraction]] = {}
    for b, bar in enumerate(bars):
        cur = None
        for p in bar:
            if p.tstart:
                cur = [starts[b] + p.onset, Fraction(0), []]
            if cur is not None:
                cur[1] += p.v
                cur[2].append(p)
                if p.tstop:
                    for q in cur[2]:
                        out[id(q)] = (cur[0], cur[1])
                    cur = None
    return out


def _spell(head) -> str:
    step, alter, octave, _ = head
    return f"{step}{'#' * alter if alter > 0 else 'b' * -alter}{octave}"


def note_hints(score: Score, parts: list[str]) -> dict[tuple[Fraction, int], dict]:
    """(onset, midi) -> the hint of every note of the parts (tied chains merged, as `Part.events()` has them), in absolute quarters.
    Drum parts get none."""
    out: dict[tuple[Fraction, int], dict] = {}
    if not parts or any(score[n].drums for n in parts):
        return out
    nbars = score.bars
    starts = score.barlines(nbars)
    lay, _ = layout(score, parts)
    with spelling(score.key):                # `_head` spells a computed pitch by the key, as the writers do
        for name in parts:
            part = score[name]
            staff, voice = lay[name]
            bars = _voice_pieces(score, part, starts, voice == 1)
            groups = _groups(bars, starts)
            flat = sorted(((starts[b] + p.onset, p) for b, bar in enumerate(bars) for p in bar if p.kind == "note"),
                          key=lambda x: x[0])
            at = [t for t, _ in flat]
            for t, note in part.events():
                if note.is_rest:
                    continue
                art = "".join(c for c in ART_ORDER if c in note.art)
                for pitch in note.pitches:
                    mine = []
                    for i in range(bisect.bisect_left(at, t), len(flat)):
                        if flat[i][0] >= t + note.dur:
                            break
                        if pitch.midi in flat[i][1].midis:
                            mine.append(flat[i][1])
                    h: dict = {"on": fj(t), "len": fj(note.dur)}
                    if len(mine) > 1 and sum(p.v for p in mine) == note.dur:
                        h["segs"] = [fj(p.v) for p in mine]
                    if mine and mine[0].tup is not None and all(p.tup == mine[0].tup and groups.get(id(p)) == groups.get(id(mine[0])) for p in mine) \
                            and id(mine[0]) in groups:
                        n, of = mine[0].tup
                        start, span = groups[id(mine[0])]
                        h["tup"] = {"n": n, "of": of, "start": fj(start), "span": fj(span)}
                    h["staff"], h["voice"] = staff, voice
                    head = next((x for x in (mine[0].heads if mine else []) if x[3] == pitch.midi), None)
                    if head:
                        h["spell"] = _spell(head)
                    if art:
                        h["art"] = art
                    out[(t, pitch.midi)] = h
    return out


def shift(h: dict, origin: Fraction) -> dict:
    """The hint with its times relative to a clip that starts at `origin` quarters (what the API takes)."""
    out = dict(h)
    out["on"] = fj(Fraction(*h["on"]) - origin)
    if "tup" in h:
        out["tup"] = {**h["tup"], "start": fj(Fraction(*h["tup"]["start"]) - origin)}
    return out
