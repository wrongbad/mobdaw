"""Draft bass lines from heard chords: a starting point for the composer to edit, not the finished part.

    heard = HEARD["guitar"]                                       # from `badmidi pull --listen Guitar`
    bass_guitar = score.part("bass guitar")
    bass_guitar.at(heard.bar, bass.line(heard, style="walk", key=score.key))
    bass_guitar.at(heard.bar, bass.line(heard.chords, heard.rhythm, "pulse", kick=bass.kicks(score["drums"])))

Styles: `roots` (the bass note of each chord, struck again on every bar line), `root-fifth` (a root, then a fifth, on every
beat), `pulse` (8ths on the root; heard strong onsets that fall between 8ths are added, and every strong one is accented),
`walk` (a beat each: root, chord tones, then an approach note, chromatic or from `key`, into the next change). `swing=` (default:
the heard take's, `HEARD[..].timing`, when it was a swing feel) puts the off-beat 8ths of `pulse` where the take played them, e.g. 0.62 of
the beat (rounded to 1/48 of it, whole ticks at 960 ppq); a triplet feel (3 or 6 slots to the beat in the heard rhythm) pulses in triplet 8ths. The note
under a chord is its `bass` pitch class, so inversions are kept; each pitch is the octave nearest the one before, inside
`range`. A `kick` (onset times, or a drum Part) pulls onsets onto the kick: added in `pulse`, snapped to in the others.
The Motif starts at the first chord; place it at that bar (`heard.bar`).
"""
from __future__ import annotations

from fractions import Fraction

from .core import Motif, Note, as_pitch
from .heard import HeardChord, HeardPart, Rhythm
from .scale import Scale, key as parse_key

_range = range
STYLES = ("roots", "root-fifth", "pulse", "walk")
KICKS = (35, 36)                  # GM bass drum keys
SNAP = Fraction(1, 4)             # a kick this close to an onset (a 16th) pulls it onto the kick
STRONG = 0.5                      # heard onset strength that counts as an accent


def kicks(drums, keys=KICKS) -> list[Fraction]:
    """Onset times (quarters) of the kick drum in a drum Part."""
    return sorted({on for on, n in drums.events() if not n.is_rest and any(p.midi in keys for p in n.pitches)})


class _Voice:
    """Picks the octave of a pitch class nearest the previous note, inside the range."""

    def __init__(self, lo: int, hi: int):
        self.lo, self.hi, self.prev = lo, hi, None

    def near(self, pc: int, ref: int | None = None) -> int:
        ref = ref if ref is not None else self.prev if self.prev is not None else min(self.hi, self.lo + 10)
        cands = [m for m in range(self.lo, self.hi + 1) if m % 12 == pc % 12]
        return min(cands, key=lambda m: (abs(m - ref), m)) if cands else min(max(ref, self.lo), self.hi)

    def pick(self, pc: int) -> int:
        self.prev = self.near(pc)
        return self.prev


def _step(rhythm: Rhythm | None, t: Fraction) -> Fraction:
    """The pulse's step in quarters at t: an 8th, or a third of the beat when the heard rhythm is in thirds (a triplet feel)."""
    if rhythm and rhythm.slot_at(t) and rhythm.beat_at(t) / rhythm.slot_at(t) in (3, 6):
        return rhythm.beat_at(t) / 3
    return Fraction(1, 2)


def _bars(t0: Fraction, end: Fraction, rhythm: Rhythm | None) -> list[tuple[Fraction, Fraction]]:
    if rhythm and rhythm.bars:
        return rhythm.bar_spans()
    n = int((end - t0) / 4) + 1
    return [(t0 + 4 * k, t0 + 4 * (k + 1)) for k in range(n)]


def _bar_start(t: Fraction, bars) -> Fraction:
    return max((a for a, _ in bars if a <= t), default=bars[0][0])


def _approach(v: _Voice, target_pc: int, scale: Scale | None, avoid: int | None) -> int | None:
    """A note a step from the target (the octave nearest the previous note): a scale step when there is a key, else a
    half step; not the previous note itself, never the target's own pitch class."""
    t = v.near(target_pc)
    ref = v.prev if v.prev is not None else t
    pcs = {(scale.tonic + s) % 12 for s in scale.steps} if scale else None
    cands = []
    for d in (-1, 1):
        for step in ((1, 2) if pcs else (1,)):
            m = t + d * step
            if pcs is None or m % 12 in pcs:
                cands.append(m)
                break
    cands = [m for m in cands if v.lo <= m <= v.hi and m != avoid and m % 12 != target_pc % 12]
    return min(cands, key=lambda m: (abs(m - ref), m)) if cands else None


def line(chords, rhythm: Rhythm | None = None, style: str = "roots", key=None, range=("E1", "G3"), kick=None, swing: float | None = None) -> Motif:
    """A draft bass Motif for the chords (HeardChords, or a HeardPart, which also gives the rhythm, key and swing)."""
    if style not in STYLES:
        raise ValueError(f"unknown bass style {style!r}; known: {', '.join(STYLES)}")
    if isinstance(chords, HeardPart):
        rhythm, key = rhythm or chords.rhythm, key or chords.key
        if swing is None and chords.timing is not None and chords.timing.feel == "swing8":
            swing = chords.timing.swing
        chords = chords.chords
    chords = sorted(chords, key=lambda c: c.start)
    if not chords:
        raise ValueError("no chords to write a bass line for")
    scale = parse_key(key) if isinstance(key, str) else key
    if kick is not None and hasattr(kick, "events"):
        kick = kicks(kick)
    kick = sorted(Fraction(k) for k in kick or [])
    lo, hi = as_pitch(range[0]).midi, as_pitch(range[1]).midi
    t0, end = chords[0].start, chords[-1].end
    def beat_at(t: Fraction) -> Fraction:
        return rhythm.beat_at(t) if rhythm else Fraction(1)
    bars = _bars(t0, end, rhythm)
    sw = Fraction(min(max(round((swing or 0.5) * 48), 24), 40), 48)            # where the off-beat 8th falls in its beat

    def swung(t: Fraction) -> Fraction:
        """An off-beat 8th (halfway through a beat of the bar) moved to where the take swung it."""
        beat = beat_at(t)
        u = (t - _bar_start(t, bars)) / beat
        return t + (sw - Fraction(1, 2)) * beat if sw != Fraction(1, 2) and u - (u.numerator // u.denominator) == Fraction(1, 2) else t

    v = _Voice(lo, hi)
    out: list[tuple[Fraction, int | None, bool]] = []         # (onset, midi or None for a rest, accent)

    for i, c in enumerate(chords):
        if c.silent:
            out.append((c.start, None, False))
            continue
        nxt = next((x for x in chords[i + 1:i + 2] if not x.silent and x.start == c.end), None)
        if style == "roots":
            for t in [c.start] + [a for a, _ in bars if c.start < a < c.end]:
                out.append((t, v.pick(c.bass), False))
        elif style == "root-fifth":
            fifth = c.fifth() if c.fifth() != c.bass else c.root
            k = 0
            t = c.start
            while t < c.end:
                k = int((t - max(c.start, _bar_start(t, bars))) / beat_at(t))
                out.append((t, v.pick(c.bass if k % 2 == 0 else fifth), False))
                t += beat_at(t)
        elif style == "pulse":
            grid = []
            t = c.start
            while t < c.end:
                grid.append(t)
                t += _step(rhythm, t)
            heard = rhythm.onsets(c.start, c.end, STRONG) if rhythm else []
            hits = {t for t, _ in heard} | {k for k in kick if c.start <= k < c.end}
            pitch = v.pick(c.bass)
            on = {(t if t in kick else swung(t)): t in hits for t in set(grid) | hits}
            for t in sorted(on):
                out.append((t, pitch, on[t]))
        else:                                                  # walk
            beat = beat_at(c.start)
            n = max(1, -((c.start - c.end) // beat))
            third, fifth = c.third(), c.fifth()
            mids = [fifth] if n == 3 else ([third, fifth, c.root, fifth] * n)
            for j in _range(n):
                t = c.start + j * beat
                if j == 0:
                    m = v.pick(c.bass)
                elif j == n - 1 and nxt is not None and nxt.bass != c.bass:
                    m = _approach(v, nxt.bass, scale, v.prev)
                    m = v.pick(fifth) if m is None else m
                    v.prev = m
                else:
                    m = v.pick(next((p for p in mids[j - 1:] if p is not None and p != v.prev % 12), c.bass))
                out.append((t, m, False))
    out = _snap(out, kick, t0, end) if kick and style != "pulse" else out
    return _motif(sorted(out, key=lambda x: x[0]), end, bars)


def _snap(notes, kick: list[Fraction], lo: Fraction, hi: Fraction):
    """Move each onset that has a kick within a 16th (inside [lo, hi)) onto it, and accent it."""
    taken, out = set(), []
    for t, m, acc in notes:
        k = min(kick, key=lambda k: abs(k - t), default=None)
        if k is not None and 0 < abs(k - t) <= SNAP and k not in taken and lo <= k < hi and m is not None:
            t, acc = k, True
        taken.add(t)
        out.append((t, m, acc))
    return out


def _motif(onsets, end: Fraction, bars) -> Motif:
    """Notes from onsets: each lasts to the next onset (the last to `end`), split at barlines into tied pieces."""
    edges = sorted({a for a, _ in bars} | {b for _, b in bars})
    items = []
    seen = set()
    onsets = [o for o in onsets if not (o[0] in seen or seen.add(o[0]))]
    for (t, m, acc), nxt in zip(onsets, [o[0] for o in onsets[1:]] + [end]):
        cuts = [t] + [e for e in edges if t < e < nxt] + [nxt]
        for a, b in zip(cuts, cuts[1:]):
            last = b == cuts[-1]
            if m is None:
                items.append(Note((), b - a))
            else:
                items.append(Note([m], b - a, tied=not last, art=">" if acc and a == t else ""))
    return Motif(*items)
