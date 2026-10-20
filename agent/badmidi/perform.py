"""Performance: how the score's markings become playback.

The score says what a player sees (p, a hairpin, rit., a fermata, Ped.);
this module decides what that means in MIDI terms. Nothing here is notation:
change these numbers and the printed music stays the same.
"""
from __future__ import annotations

import bisect
from fractions import Fraction

from .core import Mark, Note

LEVELS = {"ppp": 24, "pp": 36, "p": 50, "mp": 64, "mf": 78, "f": 94, "ff": 108, "fff": 120}
DEFAULT_LEVEL = LEVELS["mf"]
HAIRPIN_STEP = 28            # how far an open-ended hairpin goes (about two dynamic levels)
SFORZANDO = {"sf": 18, "sfz": 22, "rfz": 14}   # one-note accents above the current level
ACCENT = {">": 12, "^": 20}
STACCATO = Fraction(1, 2)     # fraction of the written length that sounds
FERMATA_HOLD = 2.0            # a fermata note lasts this many times longer
RAMP_STEP = Fraction(1, 4)    # tempo ramps are sampled every sixteenth
PEDAL_LIFT = Fraction(1, 16)  # pedal change: up at the beat, down again this much later


# --- tempo -------------------------------------------------------------------


def tempo_map(score) -> list[tuple[Fraction, float]]:
    """Piecewise-constant (time, bpm) steps covering the whole piece."""
    base: list[tuple[Fraction, float]] = [(Fraction(0), float(score.tempo))]

    def bpm_before(t):
        return [b for s, b in base if s <= t][-1]

    for m in sorted(score.tempo_marks, key=lambda m: m.start):
        if m.bpm is None:
            continue
        if not m.gradual:
            base.append((m.start, float(m.bpm)))
            continue
        b0, n = bpm_before(m.start), int((m.end - m.start) / RAMP_STEP)
        for k in range(n):
            base.append((m.start + k * RAMP_STEP, b0 + (m.bpm - b0) * k / max(n, 1)))
        base.append((m.end, float(m.bpm)))
    base.sort(key=lambda x: x[0])

    holds = sorted({(t, t + n.dur) for p in score.parts for t, n in p.events() if "@" in n.art})
    if not holds:
        return _dedupe(base)
    cuts = sorted({t for t, _ in base} | {t for span in holds for t in span})
    out = []
    for t in cuts:
        bpm = [b for s, b in base if s <= t][-1]
        if any(a <= t < b for a, b in holds):
            bpm /= FERMATA_HOLD
        out.append((t, bpm))
    return _dedupe(out)


def _dedupe(steps):
    out: list[tuple[Fraction, float]] = []
    for t, b in steps:
        if out and out[-1][0] == t:
            out[-1] = (t, b)
        elif not out or out[-1][1] != b:
            out.append((t, b))
    return out


def seconds_at(tmap, t: Fraction) -> float:
    secs = 0.0
    for i, (s, bpm) in enumerate(tmap):
        e = tmap[i + 1][0] if i + 1 < len(tmap) else None
        if s >= t:
            break
        span = (min(e, t) if e is not None else t) - s
        secs += float(span) * 60 / bpm
    return secs


# --- per-part drift ----------------------------------------------------------


def warp(part):
    """The part's playback clock: a function from written time to the time it
    sounds at (both in quarter notes, before the score's tempo map). Each
    drift adds a linear ramp of `ahead` over its span and holds it after.
    Raises ValueError if the part would have to play backwards."""
    drifts = list(part.drifts)
    if not drifts:
        return lambda t: t
    cuts = sorted({d.start for d in drifts} | {d.end for d in drifts})

    def offset(t):
        return sum((d.ahead * (min(max(t, d.start), d.end) - d.start) / (d.end - d.start) for d in drifts),
                   Fraction(0))
    for a, b in zip(cuts, cuts[1:]):
        if (b - a) + offset(b) - offset(a) <= 0:
            raise ValueError(f"drift on {part.name!r} would play backwards between "
                             f"{part.score.where(a)} and {part.score.where(b)}; use a smaller `ahead` or a longer span")
    return lambda t: max(Fraction(0), t + offset(t))


# --- dynamics ----------------------------------------------------------------


def _marking_parts(part):
    """Dynamics and pedal are shared across a group (a piano's two hands)."""
    if part.group is None:
        return [part]
    return [p for p in part.score.parts if p.group == part.group]


class Dynamics:
    """The loudness curve a part follows: steps at dynamics, linear ramps along
    hairpins, plus one-note sforzandi."""

    def __init__(self, part):
        marks = sorted(((t, m) for p in _marking_parts(part) for t, m in p.marks(Mark)
                        if m.kind in ("dyn", "cresc", "dim", "end")), key=lambda x: x[0])
        self.points: list[tuple[Fraction, float]] = [(Fraction(0), DEFAULT_LEVEL)]
        self.sforzandi: dict[Fraction, float] = {}
        cur, hairpin = float(DEFAULT_LEVEL), None   # hairpin: (start, +1 or -1)

        def close(t, target=None):
            nonlocal cur, hairpin
            start, sign = hairpin
            target = cur + sign * HAIRPIN_STEP if target is None else target
            self.points += [(start, cur), (t, target)]
            cur, hairpin = target, None

        for t, m in marks:
            if m.kind == "dyn":
                v = m.value
                if v in SFORZANDO:
                    self.sforzandi[t] = SFORZANDO[v]
                    continue
                level = LEVELS["p"] if v == "fp" else LEVELS[v]
                if v == "fp":
                    self.sforzandi[t] = LEVELS["f"] - level
                if hairpin and hairpin[0] < t:
                    close(t, level)
                else:
                    hairpin = None
                    self.points += [(t, cur), (t, level)]
                    cur = level
            elif m.kind == "end":
                if hairpin:
                    close(t)
            else:
                if hairpin:
                    close(t)
                hairpin = (t, 1 if m.kind == "cresc" else -1)
        if hairpin:
            close(max(part.score.end, hairpin[0] + 1))
        self.points.sort(key=lambda x: x[0])
        self._times = [t for t, _ in self.points]

    def level(self, t: Fraction) -> float:
        i = bisect.bisect_right(self._times, t) - 1
        t0, v0 = self.points[i]
        if i + 1 < len(self.points):
            t1, v1 = self.points[i + 1]
            if t1 > t0:
                return v0 + (v1 - v0) * float((t - t0) / (t1 - t0))
        return v0


METRIC = (4, 2)               # extra velocity on downbeats, on other beats


def velocity(dyn: Dynamics, part, t: Fraction, note: Note) -> int:
    level = part.score.metric_level(t)
    metric = METRIC[0] if level == 3 else METRIC[1] if level >= 0 else 0
    v = dyn.level(t) + part.balance + dyn.sforzandi.get(t, 0) + metric
    v += max((ACCENT.get(c, 0) for c in note.art), default=0)
    return max(1, min(127, round(v)))


def sounding_dur(note: Note) -> Fraction:
    return note.dur * STACCATO if "'" in note.art else note.dur


# --- pedal -------------------------------------------------------------------


def pedal_events(part) -> list[tuple[Fraction, int]]:
    """(time, CC64 value) for the group's pedal marks: ped = down (or change
    if already down), * = up."""
    marks = sorted(((t, m) for p in _marking_parts(part) for t, m in p.marks(Mark)
                    if m.kind in ("ped", "pedup")), key=lambda x: x[0])
    out, down = [], False
    for t, m in marks:
        if m.kind == "ped":
            if down:
                out += [(t, 0), (t + PEDAL_LIFT, 127)]
            else:
                out.append((t, 127))
            down = True
        elif down:
            out.append((t, 0))
            down = False
    if down:
        out.append((part.score.end, 0))
    return out
