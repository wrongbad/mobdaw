"""Analysis: a lens on what the voices are doing, pitch-class sets, stretto search.

Nothing here judges. observe() names what happens at each moment in the
vocabulary of counterpoint (a passing note, a suspension resolving m7 to
M6, parallel fifths, voices crossing), with the beat it falls on and the
intervals involved. What to make of it is the composer's business.

Pitch-class sets: prime_form({0, 4, 8}) -> (0, 4, 8); set_label gives the
Forte number and a common name where there is one ("3-12 (048) augmented").
Prime forms follow Rahn (packed from the right), as most software does.
"""
from __future__ import annotations

import bisect
from fractions import Fraction
from itertools import combinations
from typing import Iterable

# --- pitch-class sets -----------------------------------------------------------

# Forte numbers for every trichord and tetrachord, and the larger sets that
# have common names.
FORTE: dict[tuple[int, ...], tuple[str, str]] = {
    (0, 1, 2): ("3-1", "chromatic"), (0, 1, 3): ("3-2", ""), (0, 1, 4): ("3-3", ""),
    (0, 1, 5): ("3-4", ""), (0, 1, 6): ("3-5", "Viennese"), (0, 2, 4): ("3-6", "whole-tone"),
    (0, 2, 5): ("3-7", ""), (0, 2, 6): ("3-8", "It+6"), (0, 2, 7): ("3-9", "quartal"),
    (0, 3, 6): ("3-10", "diminished"), (0, 3, 7): ("3-11", "triad"), (0, 4, 8): ("3-12", "augmented"),
    (0, 1, 2, 3): ("4-1", ""), (0, 1, 2, 4): ("4-2", ""), (0, 1, 3, 4): ("4-3", ""),
    (0, 1, 2, 5): ("4-4", ""), (0, 1, 2, 6): ("4-5", ""), (0, 1, 2, 7): ("4-6", ""),
    (0, 1, 4, 5): ("4-7", ""), (0, 1, 5, 6): ("4-8", ""), (0, 1, 6, 7): ("4-9", ""),
    (0, 2, 3, 5): ("4-10", ""), (0, 1, 3, 5): ("4-11", ""), (0, 2, 3, 6): ("4-12", ""),
    (0, 1, 3, 6): ("4-13", ""), (0, 2, 3, 7): ("4-14", ""), (0, 1, 4, 6): ("4-Z15", "all-interval"),
    (0, 1, 5, 7): ("4-16", ""), (0, 3, 4, 7): ("4-17", ""), (0, 1, 4, 7): ("4-18", ""),
    (0, 1, 4, 8): ("4-19", ""), (0, 1, 5, 8): ("4-20", "major 7th"), (0, 2, 4, 6): ("4-21", "whole-tone"),
    (0, 2, 4, 7): ("4-22", ""), (0, 2, 5, 7): ("4-23", "quartal"), (0, 2, 4, 8): ("4-24", ""),
    (0, 2, 6, 8): ("4-25", "Fr+6"), (0, 3, 5, 8): ("4-26", "minor 7th"),
    (0, 2, 5, 8): ("4-27", "dominant 7th"), (0, 3, 6, 9): ("4-28", "diminished 7th"),
    (0, 1, 3, 7): ("4-Z29", "all-interval"),
    (0, 2, 4, 7, 9): ("5-35", "pentatonic"),
    (0, 1, 2, 3, 4, 5): ("6-1", "chromatic"), (0, 1, 4, 5, 8, 9): ("6-20", "hexatonic"),
    (0, 1, 3, 6, 7, 9): ("6-30", "Petrushka"), (0, 2, 4, 5, 7, 9): ("6-32", "diatonic hexachord"),
    (0, 2, 4, 6, 8, 10): ("6-35", "whole-tone"),
    (0, 1, 3, 5, 6, 8, 10): ("7-35", "diatonic"), (0, 1, 3, 4, 6, 7, 9, 10): ("8-28", "octatonic"),
}


def _pcs(pitches: Iterable) -> set[int]:
    return {(p if isinstance(p, int) else p.midi) % 12 for p in pitches}


def normal_order(pitches: Iterable) -> tuple[int, ...]:
    """The most compact rotation of a set (Rahn), e.g. (9, 0, 4) for A minor."""
    pcs = sorted(_pcs(pitches))
    if not pcs:
        return ()
    rots = [tuple(pcs[i:] + pcs[:i]) for i in range(len(pcs))]
    return min(rots, key=lambda r: tuple((r[k] - r[0]) % 12 for k in range(len(r) - 1, 0, -1)) + (r[0],))


def prime_form(pitches: Iterable) -> tuple[int, ...]:
    """The set class's representative: transposed to 0, inverted if more compact."""
    pcs = _pcs(pitches)
    if not pcs:
        return ()
    best = None
    for s in (pcs, {(-p) % 12 for p in pcs}):
        n = normal_order(s)
        form = tuple((p - n[0]) % 12 for p in n)
        if best is None or tuple(reversed(form)) < tuple(reversed(best)):
            best = form
    return best


def interval_vector(pitches: Iterable) -> tuple[int, ...]:
    """How many of each interval class 1..6 the set contains."""
    v = [0] * 6
    for a, b in combinations(sorted(_pcs(pitches)), 2):
        ic = min((a - b) % 12, (b - a) % 12)
        v[ic - 1] += 1
    return tuple(v)


def _digits(form) -> str:
    return "(" + "".join("0123456789TE"[p] for p in form) + ")"


def set_label(pitches: Iterable) -> str:
    """'3-12 (048) augmented', '(013479)', 'ic5' for a dyad."""
    form = prime_form(pitches)
    if len(form) < 2:
        return ""
    if len(form) == 2:
        return f"ic{form[1]}"
    forte, name = FORTE.get(form, ("", ""))
    return " ".join(x for x in (forte, _digits(form), name) if x)


# --- the lens: what the voices are doing -------------------------------------------

INTERVAL_NAMES = {0: "P1", 1: "m2", 2: "M2", 3: "m3", 4: "M3", 5: "P4", 6: "tritone",
                  7: "P5", 8: "m6", 9: "M6", 10: "m7", 11: "M7"}
# The traditional dissonances; a fourth is one only above the bass.
DISSONANT = {1, 2, 6, 10, 11}


class Observation:
    """Something happening at time t: `kind` names it ("passing",
    "suspension", "parallel fifths" ...), `where` is a part ("rh") or a pair
    ("rh/bass"), `detail` the pitches and intervals."""
    __slots__ = ("t", "where", "kind", "detail")

    def __init__(self, t: Fraction, where: str, kind: str, detail: str):
        self.t, self.where, self.kind, self.detail = t, where, kind, detail

    def __repr__(self) -> str:
        return f"Observation({self.t}, {self.where!r}, {self.kind!r}, {self.detail!r})"


def _at(evs, starts: list[Fraction], t: Fraction) -> int | None:
    """Index of the event sounding at t, or None."""
    i = bisect.bisect_right(starts, t) - 1
    for j in range(i, max(i - 8, -1), -1):
        s, n = evs[j]
        if s + n.dur > t:
            return j
    return None


def _adjacent(evs, i: int, step: int, x: int) -> int | None:
    """The pitch nearest x in the note right before (step=-1) or after (+1)
    event i, if that note joins it with no gap and isn't a rest."""
    j = i + step
    if not 0 <= j < len(evs):
        return None
    (s, n), (s0, n0) = evs[j], evs[i]
    if n.is_rest or (step < 0 and s + n.dur != s0) or (step > 0 and s != s0 + n0.dur):
        return None
    return min((p.midi for p in n.pitches), key=lambda m: abs(m - x))


def _motion(before: int | None, x: int, after: int | None) -> str:
    """How a note on a dissonance is approached and left."""
    step_in = before is not None and 0 < abs(x - before) <= 2
    step_out = after is not None and 0 < abs(after - x) <= 2
    if step_in and step_out:
        return "passing" if (x - before) * (after - x) > 0 else "neighbour"
    if after is None:
        return "unresolved"
    if step_in and after == x:
        return "anticipation"
    if step_out:
        return "appoggiatura"
    if step_in:
        return "escape tone"
    return "free dissonance"


def observe(score, parts=None) -> list[Observation]:
    """Everything the lens sees, in time order.

    Dissonances (seconds, sevenths, tritones, a fourth above the bass) are
    named by how the dissonant note moves. A note that sounds on into a
    strong beat as the other voice moves against it is held: a suspension
    if it then falls a step (with its intervals: m7->M6), a retardation if
    it rises a step, otherwise a held dissonance. A note struck into the
    dissonance is passing, neighbour, appoggiatura, escape tone,
    anticipation or free, and "accented" on a strong beat. Between the top
    of each part and the bottom of each part below it: parallel fifths and
    octaves, and voices crossing."""
    from .core import Pitch, spelling
    sel = [score[n] for n in parts] if parts else score.ordered_parts()
    evs = {p.name: p.events() for p in sel}
    starts = {k: [s for s, _ in e] for k, e in evs.items()}
    times = sorted({s for e in evs.values() for s, _ in e})
    out: list[Observation] = []

    def name(m: int) -> str:
        with spelling(score.key):
            return str(Pitch(m))

    def sounding(part, t):
        i = _at(evs[part], starts[part], t)
        return None if i is None or evs[part][i][1].is_rest else i

    def struck(part, i, x, t):
        """Did this pitch begin at t? A repeated pitch counts as held."""
        return evs[part][i][0] == t and _adjacent(evs[part], i, -1, x) != x

    def resolves(part, i, x):
        after = _adjacent(evs[part], i, 1, x)
        return after is not None and 0 < abs(after - x) <= 2

    # dissonances: who carries each one, and against whom
    for t in times:
        strong = score.metric_level(t) >= 2
        now = [(p.name, i, x.midi) for p in sel if (i := sounding(p.name, t)) is not None
               for x in evs[p.name][i][1].pitches]
        if len(now) < 2:
            continue
        bass = min(m for _, _, m in now)
        against: dict[tuple[str, int, int], list[tuple[str, int]]] = {}   # note -> [(part, pitch)]
        for (pa, ia, a), (pb, ib, b) in combinations(now, 2):
            if pa == pb:
                continue
            iv = abs(a - b) % 12
            if not (iv in DISSONANT or (iv == 5 and min(a, b) == bass)):
                continue
            new_a, new_b = struck(pa, ia, a, t), struck(pb, ib, b, t)
            A, B = (pa, ia, a, pb, b), (pb, ib, b, pa, a)
            if new_a and new_b:
                carriers = [A, B]
            elif new_a or new_b:
                moving, held = (A, B) if new_a else (B, A)
                # on a strong beat a held note that then moves by step is the
                # dissonance (a suspension); otherwise the note that moves is
                carriers = [held] if strong and resolves(*held[:3]) else [moving]
            else:
                continue
            for part, i, x, other, y in carriers:
                against.setdefault((part, i, x), []).append((other, y))
        for (part, i, x), rel in against.items():
            e = evs[part]
            ivs = [INTERVAL_NAMES[abs(x - y) % 12] for _, y in rel]
            if not struck(part, i, x, t):          # held into the dissonance
                after = _adjacent(e, i, 1, x)
                if after is not None and 1 <= x - after <= 2:
                    kind = "suspension"
                    # what it resolves to, against the first voice it clashed with
                    other = rel[0][0]
                    j = sounding(other, e[i][0] + e[i][1].dur)
                    if j is not None:
                        y = min((p.midi for p in evs[other][j][1].pitches), key=lambda m: abs(m - after))
                        ivs[0] += "->" + INTERVAL_NAMES[abs(after - y) % 12]
                elif after is not None and 1 <= after - x <= 2:
                    kind = "retardation"
                else:
                    kind = "held dissonance"
            else:
                kind = _motion(_adjacent(e, i, -1, x), x, _adjacent(e, i, 1, x))
                if strong and kind not in ("free dissonance", "unresolved"):
                    kind = "accented " + kind
            out.append(Observation(t, part, kind, f"{name(x)}: " + ", ".join(
                f"{iv} with {other} {name(y)}" for iv, (other, y) in zip(ivs, rel))))

    # parallels and crossings between the outer voices of each pair of parts
    for k, upper in enumerate(sel):
        for lower in sel[k + 1:]:
            pair, prev, crossed = f"{upper.name}/{lower.name}", None, False
            for t in sorted(set(starts[upper.name]) | set(starts[lower.name])):
                i, j = sounding(upper.name, t), sounding(lower.name, t)
                if i is None or j is None:
                    prev, crossed = None, False
                    continue
                a = evs[upper.name][i][1].pitches[-1].midi
                b = evs[lower.name][j][1].pitches[0].midi
                if a < b and not crossed:
                    out.append(Observation(t, pair, "voices cross", f"{name(a)} below {name(b)}"))
                crossed = a < b
                if prev is not None:
                    pa, pb = prev
                    if a != pa and b != pb and (a - pa) * (b - pb) > 0:
                        i0, i1 = abs(pa - pb) % 12, abs(a - b) % 12
                        kind = "parallel fifths" if i0 == i1 == 7 else "parallel octaves" if i0 == i1 == 0 else None
                        if kind:
                            out.append(Observation(t, pair, kind, f"{name(pa)}->{name(a)} over {name(pb)}->{name(b)}"))
                prev = (a, b)
    out.sort(key=lambda o: (o.t, [p.name for p in sel].index(o.where.split("/")[0])))
    return out


# --- stretto search -------------------------------------------------------------------


class Stretto:
    """One way to overlap a subject with a copy of itself: the copy enters
    `offset` quarter notes later, shifted by `interval`. `leader` and
    `follower` are the two lines, without barlines; `observations` is what
    the lens sees where they overlap."""

    def __init__(self, offset: Fraction, interval: int, leader, follower, observations, steps: bool):
        self.offset, self.interval = offset, interval
        self.leader, self.follower = leader, follower
        self.observations, self.steps = observations, steps

    def count(self, kind: str) -> int:
        """How many observations mention `kind`: s.count("parallel"), s.count("suspension")."""
        return sum(kind in o.kind for o in self.observations)

    def summary(self) -> str:
        """'2 passing, 1 suspension, 1 parallel octaves', or 'consonant throughout'."""
        kinds: dict[str, int] = {}
        for o in self.observations:
            kinds[o.kind] = kinds.get(o.kind, 0) + 1
        return ", ".join(f"{n} {k}" for k, n in kinds.items()) or "consonant throughout"

    def place(self, leader, follower, bar: int, beat=1) -> None:
        """Put the subject in part `leader` at bar/beat, and the copy in part
        `follower` at the offset."""
        t = leader.score.time(bar, beat)
        leader._place(t, [self.leader])
        follower._place(t + self.offset, [self.follower])

    def __repr__(self) -> str:
        return f"Stretto(offset={self.offset}, interval={self.interval}: {self.summary()})"


def interval_name(semitones: int) -> str:
    """7 -> 'P5', 12 -> 'P8', 19 -> 'P5+8va'."""
    n = abs(semitones)
    if n and n % 12 == 0:
        return "P8" if n == 12 else f"{n // 12} P8"
    return INTERVAL_NAMES[n % 12] + ("+8va" * (n // 12))


class Strettos(list):
    """Every overlap tried, in order of offset; prints as a table."""

    def __str__(self) -> str:
        from .core import fmt_number
        rows = [(fmt_number(s.offset) + " q",
                 f"{s.interval:+d} step{'s' if abs(s.interval) != 1 else ''}" if s.steps
                 else f"{s.interval:+d} ({interval_name(s.interval)})",
                 s.summary()) for s in self]
        w0 = max([len(r[0]) for r in rows] + [6])
        w1 = max([len(r[1]) for r in rows] + [8])
        return "\n".join(f"{a:<{w0}}  {b:<{w1}}  {c}" for a, b, c in [("offset", "interval", "what happens")] + rows)


def stretti(subject, follower=None, intervals: Iterable[int] = (12, 7, 5, 0, -5, -7, -12),
            offsets: Iterable | None = None, scale=None, meter=(4, 4), beat=1) -> Strettos:
    """Lay a subject against a later copy of itself at every offset and
    interval, and describe each overlap through the lens.

        print(stretti(subject))                                   # octave, fifth, fourth ...
        stretti(subject, follower=lambda m: m.invert(), offsets=[1, 2])
        stretti(subject, intervals=range(-7, 8), scale=key("D dorian"))   # in scale steps
        [s for s in stretti(subject) if not s.count("parallel")]

    offsets are in quarter notes (default: every beat while the voices
    overlap); the leader starts on `beat` of bar 1 in `meter`."""
    from .core import Motif
    from .score import Score
    lead = Motif(*subject.notes)
    base = Motif(*(follower(lead) if follower else lead).notes)
    probe = Score(meter=meter)
    step = probe.meter_at(1).beat_len
    if offsets is None:
        offsets = [k * step for k in range(1, int(lead.dur / step))]
    start = probe.time(1, beat)
    out = Strettos()
    for off in offsets:
        off = Fraction(off)
        for iv in intervals:
            f = base.transpose(iv, scale)
            sc = Score(meter=meter, key=scale if scale is not None else "C major")
            names = ("follower", "leader") if iv >= 0 else ("leader", "follower")
            parts = {n: sc.part(n) for n in names}
            parts["leader"]._place(start, [lead])
            parts["follower"]._place(start + off, [f])
            out.append(Stretto(off, iv, lead, f, observe(sc), scale is not None))
    out.sort(key=lambda s: (s.offset, -s.interval))
    return out
