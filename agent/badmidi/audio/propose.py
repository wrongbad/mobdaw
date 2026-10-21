"""A time map for an audio-only project, proposed from the beats the audio was played on (AUDIO-PLAN, Phase 7, case B).

    p = propose(beat_times, meter, t0, ppq=960)        # a MapProposal: regions, kind, tempo, pickup, worst error
    p.ops(project_regions)                              # addRegion / removeRegion ops that make the project's map this one

The map starts at project second 0 (bar 1). Time before the take's first downbeat (a pickup, and the silence before the clip
starts: `t0`, the clip's place on the timeline) is one free bar of that length; from the downbeat on come metered bars. The simplest
map that keeps every beat within `TOL` of where the audio's beat tracker found it wins: one region at the average tempo, else
a chain of `rampTo` regions (tempo linear in time between knots every 8, 4, 2 bars), else a region per bar. The result is checked
with `bridge.Timeline` (the same arithmetic as the app), not with the numbers it was built from.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from fractions import Fraction

import numpy as np

from ..bridge import Timeline
from .timing import Meter, _smooth

TOL = 0.020                  # seconds: the 95th percentile of a map beat's distance to the audio's beat
TOL_MAX = 0.040              # ... and the worst one
MIN_PICKUP = 0.02            # a lead-in shorter than this is not a bar of its own
PPQ = 960


@dataclass
class MapProposal:
    regions: list[dict]                                   # the agent view's region dicts, ids included
    kind: str                                             # 'steady' | 'ramps' | 'per-bar'
    bpm: float                                            # quarter notes a minute, on average
    meter: str                                            # '4/4', '3/4', '6/8'
    pickup_s: float                                       # length of the free bar 1 (0: none)
    downbeat_s: float                                     # project seconds of the first downbeat
    max_error_s: float = 0.0
    p95_error_s: float = 0.0
    bars: int = 0                                         # metered bars the map has been fitted to
    first_bar: int = 1                                    # the bar of the first downbeat (2 after a free bar)
    notes: list[str] = field(default_factory=list)

    @property
    def tempo_text(self) -> str:
        return f"{self.bpm:.1f} bpm {self.meter}" if self.kind == "steady" else f"about {self.bpm:.0f} bpm {self.meter}, following the take's tempo ({self.kind}, {len(self.metered())} regions)"

    def metered(self) -> list[dict]:
        return [r for r in self.regions if r["kind"] == "metered"]

    def describe(self) -> str:
        """The map in a line or two: `bar 1: free 0.40 s | bar 2: 87.0 bpm 4/4`."""
        out = []
        for r in self.regions[:6]:
            out.append(f"bar {r['bar']}: free {r['seconds']:.2f} s" if r["kind"] == "free" else
                       f"bar {r['bar']}: {r['bpm']:g} bpm {r['meter']}" + (f" ramping to {r['rampTo']:g}" if r.get("rampTo") else ""))
        return " | ".join(out) + (f" | ... {len(self.regions) - 6} more" if len(self.regions) > 6 else "")

    def ops(self, current: list[dict]) -> list[dict]:
        """The ops that make a project whose regions are `current` (the agent view's) have this map; none if it already has it."""
        if same_map(current, self.regions):
            return []
        want = {r["bar"] for r in self.regions}
        ops = [{"op": "removeRegion", "bar": r["bar"]} for r in sorted(current, key=lambda r: r["bar"]) if r["bar"] > 1 and r["bar"] not in want]
        for r in self.regions:
            if r["kind"] == "free":
                ops.append({"op": "addRegion", "bar": r["bar"], "free": r["seconds"]})
            else:
                ops.append({"op": "addRegion", "bar": r["bar"], "bpm": r["bpm"], "meter": r["meter"],
                            **({"rampTo": r["rampTo"]} if r.get("rampTo") is not None else {})})
        return ops


def same_map(a: list[dict], b: list[dict]) -> bool:
    """Do two region lists say the same thing (ids and the carried-over fields ignored)?"""
    def key(rs):
        return [(r["bar"], r["kind"], round(r.get("seconds", 0), 3), round(r.get("bpm", 0), 3), r.get("meter", ""), round(r.get("rampTo") or 0, 3))
                for r in sorted(rs, key=lambda r: r["bar"])]
    return key(a) == key(b)


def _region(bar: int, bpm: float, meter: str, ramp: float | None = None) -> dict:
    return {"id": f"map{bar}", "bar": bar, "kind": "metered", "bpm": round(bpm, 3), "meter": meter,
            **({"rampTo": round(ramp, 3)} if ramp is not None and abs(ramp - bpm) > 5e-4 else {})}


def _logmean(a: float, b: float) -> float:
    return a if abs(a - b) < 1e-9 * a else (b - a) / math.log(b / a)


def _next_tempo(v0: float, mean: float) -> float:
    """The tempo a linear-in-ticks ramp from v0 must end at to average `mean` (the logarithmic mean of its ends)."""
    lo, hi = 0.5 * v0, 2.0 * v0
    for _ in range(60):
        mid = (lo + hi) / 2
        if _logmean(v0, mid) < mean:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def check(regions: list[dict], beats_abs: np.ndarray, d: int, bpb: int, qpb: Fraction, first_bar: int, ppq: int = PPQ) -> tuple[float, float]:
    """(95th percentile, worst) distance in seconds between the audio's beats from the downbeat `d` on and the same beats of the
    map `regions`, computed by `Timeline`."""
    tl = Timeline({"meta": {"ppq": ppq}, "regions": regions})
    beat_ticks = Fraction(ppq) * qpb / bpb
    err = []
    for k in range(d, len(beats_abs)):
        j, i = divmod(k - d, bpb)
        err.append(tl.seconds_at(tl.bar_start(first_bar + j) + i * beat_ticks) - beats_abs[k])
    if not err:
        return 0.0, 0.0
    e = np.abs(err)
    return float(np.percentile(e, 95)), float(e.max())


def propose(beat_times, mt: Meter, t0: float = 0.0, ppq: int = PPQ) -> MapProposal | None:
    """The map for beats played at `beat_times` (seconds from the start of the audio, which sits at project second `t0`), with
    the meter's bar lines. None if there are too few beats to say anything."""
    B = np.asarray(beat_times, float) + t0
    bpb, d = mt.beats_per_bar, mt.downbeat_index
    if len(B) < max(4, d + 2):
        return None
    compound = mt.unit == "8"
    qpb = Fraction(3, 2) * bpb if compound else Fraction(bpb)           # quarter notes in a bar
    meter = f"{bpb * 3}/8" if compound else f"{bpb}/4"
    nbars = max(1, -(-(len(B) - d) // bpb))
    k = np.arange(len(B))
    sm = _smooth(B, 1.0) if len(B) > 6 else B
    D0 = float(B[d])
    # beats on a straight line: the tempo of the whole take
    a, b = np.polynomial.polynomial.polyfit(k[d:], B[d:], 1) if len(B) - d > 1 else (D0, 0.5)
    down_line = float(a + b * d)                                         # the first downbeat on the straight line, and as the (smoothed) beats have it
    down_beats = float(sm[d])
    first_bar = 2 if max(down_line, down_beats) >= MIN_PICKUP else 1

    def head_for(down: float) -> list[dict]:
        return [{"id": "map1", "bar": 1, "kind": "free", "seconds": round(max(down, MIN_PICKUP), 3)}] if first_bar == 2 else []

    mean_bpm = float(qpb * 60 / (b * bpb))

    def bar_starts(source) -> np.ndarray:
        """Project seconds of the starts of bars 0..nbars (extrapolated past the last beat)."""
        idx = d + bpb * np.arange(nbars + 1)
        iv = float(source[-1] - source[-2])
        return np.array([source[i] if i < len(source) else source[-1] + (i - len(source) + 1) * iv for i in idx])

    S = bar_starts(sm)
    S[0] = down_beats if first_bar == 2 else 0.0                         # (without a free bar, bar 1 starts at second 0)
    cands: list[tuple[str, list[dict]]] = [("steady", head_for(down_line) + [_region(first_bar, mean_bpm, meter)])]
    if nbars >= 4:
        for n in (8, 4, 2):
            if nbars <= n:
                continue
            knots = list(range(0, nbars, n))
            means = [float(qpb * (min(kn + n, nbars) - kn) * 60 / (S[min(kn + n, nbars)] - S[kn])) for kn in knots]
            v = [means[0] + (means[0] - means[1]) / 2 if len(means) > 1 else means[0]]
            v[0] = float(np.clip(v[0], 0.8 * means[0], 1.25 * means[0]))
            for m in means:
                v.append(float(np.clip(_next_tempo(v[-1], m), 0.5 * means[0], 2 * means[0])))
            regs = [_region(first_bar + kn, v[i], meter, v[i + 1]) for i, kn in enumerate(knots)]
            regs.append(_region(first_bar + nbars, v[-1], meter))                   # (a ramp ends at the next region, which carries on)
            cands.append(("ramps", head_for(down_beats) + regs))
    per_bar = [_region(first_bar + j, float(qpb * 60 / (S[j + 1] - S[j])), meter) for j in range(nbars)]
    cands.append(("per-bar", head_for(down_beats) + per_bar))
    best = None
    for kind, regs in cands:
        p95, worst = check(regs, sm, d, bpb, qpb, first_bar, ppq)
        if best is None or worst < best[3]:
            best = (kind, regs, p95, worst)
        if p95 <= TOL and worst <= TOL_MAX:
            best = (kind, regs, p95, worst)
            break
    kind, regs, p95, worst = best
    pickup = regs[0]["seconds"] if regs[0]["kind"] == "free" else 0.0
    down = pickup or max(0.0, down_line if kind == "steady" else down_beats)
    return MapProposal(regs, kind, round(mean_bpm, 2), meter, round(pickup, 3), round(down, 3), worst, p95, nbars, first_bar)
