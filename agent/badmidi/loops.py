"""Which loops (Part.loop) can be engraved as repeats.

A loop always plays expanded. The engraving prints a span once inside
`\\repeat volta N` only when that is true to every staff: the span starts
and ends on barlines, every part (a silent one included) has the same
content in each pass, and no tempo change, section, registration or drift falls
inside it. Anything else is written out in full, and check() says so.
"""
from __future__ import annotations

import bisect
from fractions import Fraction

from .core import Mark


class Span:
    """An accepted repeat: `times` passes of `bars` bars from bar `first`."""
    __slots__ = ("start", "body", "times", "first", "bars")

    def __init__(self, start, body, times, first, bars):
        self.start, self.body, self.times, self.first, self.bars = start, body, times, first, bars

    @property
    def end(self) -> Fraction:
        return self.start + self.body * self.times

    @property
    def after(self) -> int:
        """The bar number after the last pass."""
        return self.first + self.bars * self.times


class Plan:
    def __init__(self, spans: list[Span], notes: list[tuple[Fraction, str, str]]):
        self.spans = spans
        self.notes = notes          # (time, part, message): loops written out in full

    def segments(self, total: Fraction) -> list[tuple[Fraction, Fraction, Span | None]]:
        """The score in order as (start, end, span): the span's first pass
        stands for all its passes (its start/end are that one pass), plain
        stretches have span None. Times are in the full, expanded score."""
        out, cur = [], Fraction(0)
        for sp in self.spans:
            if sp.start > cur:
                out.append((cur, sp.start, None))
            out.append((sp.start, sp.start + sp.body, sp))
            cur = sp.end
        if cur < total:
            out.append((cur, total, None))
        return out


def _in_range(items, starts, a, b):
    return items[bisect.bisect_left(starts, a):bisect.bisect_left(starts, b)]


def plan_loops(score) -> Plan:
    if not score.loops:
        return Plan([], [])
    total = score.barlines(score.bars)[-1]
    data = {}
    for p in score.parts:
        evs = p.events(merge_ties=False)
        mks = [(t, m) for t, m in p.marks(Mark)]
        data[p.name] = (evs, [t for t, _ in evs], mks, [t for t, _ in mks])
    interior = [t for m in score.tempo_marks for t in (m.start, m.end) if t is not None]
    interior += [score.bar_start(s.bar) for s in score.sections]
    interior += [t for p in score.parts for t, _, _ in p.registrations]
    interior += [t for p in score.parts for d in p.drifts for t in (d.start, d.end)]

    spans: list[Span] = []
    notes: list[tuple[Fraction, str, str]] = []
    seen = set()
    for lp in sorted(score.loops, key=lambda l: (l.start, l.part.name)):
        key = (lp.start, lp.body, lp.times)
        if key in seen:
            continue
        seen.add(key)
        label = f"loop x{lp.times} at {score.where(lp.start)}"

        def out(why):
            notes.append((lp.start, lp.part.name, f"{label} is engraved written out: {why}"))
        a, end = lp.start, lp.end
        if not (score.is_barline(a) and score.is_barline(lp.start + lp.body)):
            out("one pass doesn't start and end on barlines")
            continue
        if spans and a < spans[-1].end:
            out("it overlaps another loop")
            continue
        first, last = score.position(a)[0], score.position(a + lp.body)[0]
        if end > total or any(score.meter_at(b).free is not None or score.meter_at(b) != score.meter_at(first)
                              for b in range(first, score.position(end)[0])):
            out("the meter isn't the same throughout")
            continue
        if any(a < t < end for t in interior):
            out("a tempo change, section, registration or drift falls inside it")
            continue
        bad = None
        for name, (evs, starts, mks, mstarts) in data.items():
            lo, hi = bisect.bisect_left(starts, a), bisect.bisect_left(starts, end)
            inside = evs[lo:hi]
            if (lo and evs[lo - 1][0] + evs[lo - 1][1].dur > a) or \
                    (hi > lo and evs[hi - 1][0] + evs[hi - 1][1].dur > end):
                bad = f"{name} has a note across its edge"
                break
            passes = [[] for _ in range(lp.times)]
            for t, n in inside:
                passes[int((t - a) // lp.body)].append((t - a - (t - a) // lp.body * lp.body,
                                                        repr(n), n.dur, n.tied, n.tuplet))
            if any(ps != passes[0] for ps in passes[1:]):
                bad = f"{name} differs between passes"
                break
            # markings: the same in every pass, though the first may also hold
            # ones placed at the very start (a dynamic written once with mark())
            marks = [[] for _ in range(lp.times)]
            for t, m in _in_range(mks, mstarts, a, end):
                r = int((t - a) // lp.body)
                marks[r].append((t - a - r * lp.body, m.kind, m.value))
            head = [x for x in marks[0] if x[0] != 0]
            if any([x for x in ms if x[0] != 0] != head for ms in marks[1:]) or \
                    any(ms != marks[1] for ms in marks[2:]) or \
                    any(x not in marks[0] for x in marks[1]):
                bad = f"{name} has markings that differ between passes"
                break
        if bad:
            out(bad)
            continue
        spans.append(Span(a, lp.body, lp.times, first, last - first))
    return Plan(spans, notes)
