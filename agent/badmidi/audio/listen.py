"""Listen to a track of a mobdaw project: its audio as a chord chart in score time, following whatever timing the audio has.

    badmidi listen <project> --track Guitar [--bars 1-16] [--as auto|chords|notes] [--snap 16] [--wait 60] [--case auto|a|b] [--keep-map]

    heard = listen(client, pid, state, "Guitar", bars=(1, 16))   # Listened: .part (a HeardPart), .chart(), .timing, .proposal
Needs the `badmidi[audio]` extra. It never refuses a take for its timing (AUDIO-PLAN, Phase 7): it reads what is there and says how
sure it is. Two cases, decided from the project:

  A. the project has a timing reference (a click track, or any MIDI clip with notes): its time map is the truth. The take is aligned
     to the project's beats (`timing.align`): a steady offset ("the take sits +35 ms behind the beats: move the clip 35 ms earlier"),
     a drift ("rushes to -120 ms by bar 12"), the feel (swing 62%, triplets) are reported, chords and notes are read on the beats as
     the take played them, and every heard position is on the project's grid (played beat k is project beat k). The map is not touched.
  B. audio only: the audio defines the map. The beats, meter and downbeat are tracked (`timing.analyze`), a time map is proposed from
     them (`propose.propose`: a free bar for the pickup, then one region, ramps or a region a bar), and heard positions are in ticks
     of that proposed map. `pull --listen` / `push` send the map in the same batch as the bass (`--keep-map`: don't; positions are
     then the old map's ticks of where the audio was played).

`--case a|b` overrides the decision (a project whose click you don't want to follow; a MIDI-only sketch you do). The analysis (hear.py,
timing.py) is cached beside the sample cache, keyed by the clips, the options, the grid and a hash of the analysis code, so asking
again is instant and editing the analysis never serves stale answers. `--as auto` (the default) hears a single clear line as notes
and anything else as chords.
"""
from __future__ import annotations

import argparse
import functools
import hashlib
import json
import os
import sys
from dataclasses import asdict, dataclass, field
from fractions import Fraction

import numpy as np

from ..bridge import BridgeError, Client, SampleIncoming, Timeline, _frac
from ..heard import HeardChord, HeardNote, HeardPart, HeardTiming, Rhythm
from ..ingest import _clean_name
from . import hear, propose as proposing, timing
from .source import SR, _find_track, default_cache_dir, track_audio

MODES = ("auto", "chords", "notes")
CASES = ("auto", "a", "b")
FEELS = {"straight16": "straight feel", "triplet8": "triplet feel", "triplet16": "triplet 16ths feel"}


@dataclass
class Listened:
    part: HeardPart
    heard: hear.Heard
    grid: hear.Grid
    takes: int
    bars: tuple[int, int]
    name: str
    beat: Fraction = Fraction(1)                      # quarters per beat of the grid
    timing: HeardTiming = field(default_factory=lambda: HeardTiming("a"))
    proposal: proposing.MapProposal | None = None     # case B: the map to send with the bass (None with --keep-map)
    where: str = ""                                   # how the take sits on the beats, for the chart's header

    @property
    def warnings(self) -> list[str]:
        return self.timing.warnings

    def chart(self) -> str:
        lines = hear.format_chart(self.heard, self.grid, f"{self.name} (audio, {self.takes} take{'s' * (self.takes != 1)})",
                                  self.bars[0], self.part.mode, self.beat, self.where or None).splitlines()
        t = self.timing
        extra = [f"timing: {t.summary}"]
        if t.case == "b" and t.map:
            extra.append("map: " + (f"{self.proposal.describe()} (sent with the bass by push)" if self.proposal else
                                   "(not applied: --keep-map) " + proposing.MapProposal(t.map, "", t.bpm, t.meter, t.pickup_s, t.downbeat_s).describe()))
        extra += [f"warning: {w}" for w in t.warnings]
        return "\n".join(lines[:1] + extra + lines[1:])


# --- the case ----------------------------------------------------------------------


def timing_reference(state: dict) -> str | None:
    """Why the project has a timing reference, or None (then the audio defines the map): a track with role 'click' (the metronome
    track the metronome button creates the first time it is switched on, muted or not) or any MIDI clip with notes."""
    for t in state["tracks"]:
        if t.get("role") == "click":
            return "a click track"
    for t in state["tracks"]:
        if any(c["kind"] == "midi" and c.get("notes") for c in t["clips"]):
            return f"MIDI notes on {t['name']!r}"
    return None


# --- the cache ----------------------------------------------------------------------


@functools.lru_cache(maxsize=1)
def _code_version() -> str:
    """A hash of the code that decides what an analysis says (hear.py, timing.py, propose.py and this file), so the cache can never
    outlive an edit."""
    h = hashlib.sha256()
    for f in (hear.__file__, timing.__file__, proposing.__file__, __file__):
        with open(f, "rb") as fh:
            h.update(fh.read())
    return h.hexdigest()[:16]


def _key(clips: list[dict], mode: str, grid: hear.Grid | None, origin: float, snap: int = 16, case: str = "a", end: float = 0.0,
         meter: tuple[str | None, int] = (None, 0)) -> str:
    desc = {"meter": list(meter), "v": _code_version(), "mode": mode, "snap": snap, "origin": round(origin, 4), "case": case, "end": round(end, 4),
            "clips": [[c["sourceHash"], c.get("sourceOffsetSeconds", 0), c["lengthSeconds"], c.get("loopSeconds"), c.get("loopPhaseSeconds", 0),
                       c.get("gain", 1), c["startSeconds"]] for c in clips],
            "grid": [[round(b, 4) for b in grid.beats], grid.bar_starts, round(grid.end or 0, 4)] if grid else None}
    return hashlib.sha256(json.dumps(desc, sort_keys=True).encode()).hexdigest()


def _json_default(o):
    if isinstance(o, Fraction):
        return str(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, np.generic):
        return o.item()
    return float(o)


def _heard_from_json(d: dict) -> hear.Heard:
    return hear.Heard(d["tuning_cents"], hear.Key(**d["key"]), hear.GridCheck(**d["grid_check"]),
                      [hear.ChordSpan(**{**c, "runner_up": tuple(c["runner_up"]) if c["runner_up"] else None}) for c in d["chords"]],
                      hear.Rhythm(d["rhythm"]["slots_per_beat"], d["rhythm"]["bars"], d["rhythm"].get("beat_slots")), hear.Onsets(**d["onsets"]),
                      [hear.HeardNote(**{**n, "start_beat": Fraction(n["start_beat"]), "end_beat": Fraction(n["end_beat"])}) for n in d["notes"]],
                      d["mode"], hear.Decision(**d["decision"]) if d["decision"] else None)


def _cached(path: str, compute) -> tuple[hear.Heard, dict]:
    """(Heard, info) from the cache file, else from `compute()` (which returns the same) and written there. `info` is plain JSON:
    the timing readings (feel, alignment or beats and meter)."""
    try:
        with open(path) as f:
            d = json.load(f)
        return _heard_from_json(d["heard"]), d["info"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    h, info = compute()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".part"
        with open(tmp, "w") as f:
            json.dump({"heard": asdict(h), "info": info}, f, default=_json_default)
        os.replace(tmp, path)
    except OSError:
        pass                                                   # a cache that cannot be written is only slower
    return h, info


# --- listening ------------------------------------------------------------------------


def audio_bars(tl: Timeline, clips: list[dict]) -> tuple[int, int]:
    """The bars the clips cover: from the bar the first starts in to the bar the last ends in. A last bar the audio only
    spills into (a reverb or ring-out tail shorter than half a bar) is not a bar of music, so it is left out."""
    a = min(c["startSeconds"] for c in clips)
    b = max(c["startSeconds"] + c["lengthSeconds"] for c in clips)
    first = max(1, tl.bar_of(_frac(tl.tick_at(a))))
    end = _frac(tl.tick_at(b))
    last = max(1, tl.bar_of(end - Fraction(1, 1000)))
    if last > first:
        start = tl.bar_start(last)
        if end - start < (tl.bar_start(last + 1) - start) / 2:
            last -= 1
    return first, max(first, last)


def listen(client: Client, pid: str, state: dict, track: str, bars: tuple[int, int] | None = None, mode: str = "auto",
           wait: float = 0, cache_dir: str | None = None, snap: int = 16, case: str = "auto", keep_map: bool = False,
           meter: str | None = None, downbeat_beat: int = 0) -> Listened:
    """The track's audio as heard chords or notes, with its timing read (see the module docstring). `state` is the whole project
    (the case is decided from its click track and MIDI notes); `bars` default to where the audio is; `mode` auto decides by
    voicing; `snap`: notes are quantized to 1/snap notes; `case` 'a' or 'b' overrides the decision; `keep_map` (case B) leaves
    the time map alone; `meter` ('3/4') and `downbeat_beat` (the first bar line that many beats later than the tracker has it) are a
    person's answers for case B and replace the tracker's reading. Raises BridgeError (SampleIncoming while a take is still uploading) only when it cannot read the audio."""
    if mode not in MODES:
        raise BridgeError(f"unknown mode {mode!r}; use one of: {', '.join(MODES)}")
    if case not in CASES:
        raise BridgeError(f"unknown case {case!r}; use one of: {', '.join(CASES)}")
    t = _find_track(state, track)
    clips = [c for c in t["clips"] if c["kind"] == "audio"]
    if not clips:
        raise BridgeError(f"track {t['name']!r} has no audio clips")
    ref = timing_reference(state)
    use = case if case != "auto" else "a" if ref else "b"
    why = (ref or "no click track and no MIDI notes") if case == "auto" else f"--case {case}" + (f" ({ref})" if ref else "")
    args = (client, pid, state, t, clips, bars, mode, wait, cache_dir, snap, why)
    return _listen_a(*args) if use == "a" else _listen_b(*args, keep_map, meter, downbeat_beat)


def _window(client, pid, state, t, origin, end_abs, wait, cache_dir) -> np.ndarray:
    sig, t0 = track_audio(client, pid, state, t["id"], SR, wait, cache_dir)
    i0, i1 = round((origin - t0) * SR), round((end_abs - t0) * SR)
    x = np.concatenate([np.zeros(max(0, -i0), np.float32), sig[max(0, i0):max(0, i1)]])
    if len(x) < SR // 4:
        raise BridgeError(f"track {t['name']!r}: almost no audio in the bars asked for")
    return x


def _feel_json(fl: timing.Feel) -> dict:
    return asdict(fl)


def _compound_feel(fl: timing.Feel) -> timing.Feel:
    """The beat is a dotted quarter: its natural subdivision is three 8ths, whatever a quiet take said."""
    return fl if fl.kind != "straight16" else timing.Feel("triplet8", 2 / 3, fl.offset_s, fl.confidence, fl.n)


def _slot_rhythm(o: hear.Onsets, al: timing.Alignment, fl: timing.Feel, grid: hear.Grid) -> hear.Rhythm:
    """Onset strength per slot of the feel's notated subdivision of each beat, per bar of the grid (each onset on the beat and slot
    it was played as)."""
    ns = len(timing.notated(fl))
    pos = timing.to_grid(o.times, al, fl) if len(o.times) else []
    bars = grid.bars()
    rows = [np.zeros((b - a) * ns) for a, b in bars]
    for gp, st in zip(pos, o.strengths):
        for (a, b), row in zip(bars, rows):
            if a <= gp.beat < b:
                i = (gp.beat - a) * ns + gp.slot
                row[i] = max(row[i], st)
                break
    return hear.Rhythm(ns, [r.round(3).tolist() for r in rows])


def _remap_notes(h: hear.Heard, al: timing.Alignment, fl: timing.Feel) -> None:
    """Notes of a swung or triplet take sit on the feel's slots, not on 16ths: starts from the raw onsets, ends on the slot nearest
    the quantized end (played-beat coordinates), at least a slot long and never past the next start."""
    if fl.kind == "straight16" or not h.notes:
        return
    pos = list(fl.positions()) + [1.0]
    fr = list(timing.notated(fl)) + [Fraction(1)]
    starts = [g.position for g in timing.to_grid([n.raw_onset_s for n in h.notes], al, fl)]
    out = []
    for i, (n, s) in enumerate(zip(h.notes, starts)):
        u = float(n.end_beat)
        k = int(u // 1)
        j = int(np.abs(np.array(pos) - (u - k)).argmin())
        e = Fraction(k) + fr[j]
        if i + 1 < len(h.notes):
            e = min(e, starts[i + 1])
        if e <= s:
            e = s + (fr[1] - fr[0])
        out.append(hear.HeardNote(s, e, n.pitch, n.velocity, n.confidence, n.raw_onset_s))
    h.notes = out


def _bar_of_beat(grid: hear.Grid, i: int, first_bar: int) -> int:
    return first_bar + next((n for n, (a, b) in enumerate(grid.bars()) if a <= i < b), len(grid.bars()) - 1)


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def _feel_text(fl: timing.Feel) -> str:
    return f"swing {_pct(fl.swing_ratio)}" if fl.kind == "swing8" else FEELS[fl.kind]


def _feel_warnings(fl: timing.Feel) -> list[str]:
    """A feel read from few or ambiguous onsets is a guess; name what else it could be."""
    if fl.confidence >= timing.UNSURE or fl.kind == "straight16":
        return []
    other = "straight 16ths" if fl.kind in ("swing8", "triplet8") else "straight 16ths or triplets"
    return [f"the {_feel_text(fl)} is a guess (confidence {fl.confidence:.2f}): it could be {other}"]


def describe_alignment(al: timing.Alignment, grid: hear.Grid, first_bar: int, project_bpm: float) -> tuple[str, str, list[str]]:
    """(the header words, the summary words, warnings) for a take's alignment to the project's beats. A steady offset gets the fix
    ("move the clip 35 ms earlier"); a drift says where it gets to and what tempo the take is closer to."""
    m = al.mean_offset * 1000
    warn: list[str] = []
    if al.kind == "tight":
        return f"on the grid ({m:+.0f} ms)", f"tight to the project's beats ({m:+.0f} ms)", warn
    c = al.offset_curve
    if al.kind == "feel":
        side = "behind" if m > 0 else "ahead of"
        fix = f"move the clip {abs(m):.0f} ms {'earlier' if m > 0 else 'later'}"
        warn.append(f"the take sits {m:+.0f} ms {side} the beats: {fix}. The bass is on the project's grid either way (it does not copy the offset)")
        return f"{abs(m):.0f} ms {side} the beats", f"the take sits {m:+.0f} ms {side} the beats, steadily", warn
    end = float(c[-1]) * 1000
    bar = _bar_of_beat(grid, len(c) - 1, first_bar)
    x = np.arange(len(c), dtype=float)
    slope, icpt = np.polyfit(x, c, 1)
    resid = float(np.abs(c - (slope * x + icpt)).max())
    span = float(grid.beats[-1] - grid.beats[0]) if len(grid.beats) > 1 else 1.0
    rate = slope * (len(c) - 1) / max(span, 1e-6)                    # seconds of offset per second of music
    if resid <= 0.02 and abs(end) >= 45:
        verb = "rushes" if end < 0 else "drags"
        ratio = 1 / (1 + rate)
        faster = ratio > 1
        words = f"{verb} to {end:+.0f} ms by bar {bar}"
        warn.append(f"the take {words}: it is about {abs(ratio - 1) * 100:.0f}% {'faster' if faster else 'slower'} than the project's {project_bpm:.0f} bpm. "
                    f"The bass follows the project's beats (one chord per beat the take played), so it stays on the click; to make the audio fit, "
                    f"re-record to the click, warp the clip, or set the project's tempo to about {project_bpm * ratio:.0f} bpm")
    else:
        lo, hi = float(c.min()) * 1000, float(c.max()) * 1000
        at = _bar_of_beat(grid, int(np.abs(c).argmax()), first_bar)
        words = f"wanders between {lo:+.0f} and {hi:+.0f} ms (furthest at bar {at}), ending at {end:+.0f} ms"
        warn.append(f"the take {words}: it was not played to the click. The bass follows the project's beats (one chord per beat the take played), "
                    "so it stays on the click; to make the audio fit, re-record to the click or warp the clip")
    return words, f"drifts: {words}", warn


def _listen_a(client, pid, state, t, clips, bars, mode, wait, cache_dir, snap, why) -> Listened:
    """Case A: the project's time map is the truth."""
    tl = Timeline(state)
    first, last = bars or audio_bars(tl, clips)
    if last < first:
        raise BridgeError(f"bars {first}-{last}: the range is empty")
    bg = tl.beat_grid(first, last + 1, compound=True)
    origin = bg[0][0]
    end_tick = tl.bar_start(last + 1)
    end_abs = tl.seconds_at(end_tick)
    grid = hear.Grid([s - origin for s, _, _ in bg], [b for *_, b in bg], end_abs - origin)
    hit = [c for c in clips if c["startSeconds"] < end_abs and c["startSeconds"] + c["lengthSeconds"] > origin]
    if not hit:
        raise BridgeError(f"track {t['name']!r} has no audio in bars {first}-{last}")
    ticks = [tk for _, tk, _ in bg] + [end_tick]
    lens = [_beat_len(Fraction(b - a) / tl.ppq) for a, b in zip(ticks, ticks[1:])] if len(bg) > 1 else [Fraction(1)] * len(bg)
    beat = lens[0]
    for ln in sorted(set(lens)):
        if ln * snap % 4:
            raise BridgeError(f"--snap {snap}: a beat of {ln} quarters does not divide into 1/{snap} notes")
    spbs = [max(1, round(Fraction(snap) * ln / 4)) for ln in lens]       # slots are 16th notes (or --snap), whatever the beat
    even = len(set(lens)) == 1
    cache = os.path.join(cache_dir or default_cache_dir(), "analysis", _key(hit, mode, grid, origin, snap, "a") + ".json")
    compound = set(lens) == {Fraction(3, 2)}

    def analyse() -> tuple[hear.Heard, dict]:
        x = _window(client, pid, state, t, origin, end_abs, wait, cache_dir)
        f = timing.features(x)
        o = hear.onsets(x)
        per_bar = int(np.median([b - a for a, b in grid.bars()])) if grid.bars() else 4
        al = timing.align(o.times, grid.beats, timing.beats(f).times, o.strengths, per_bar)
        fl = timing.feel(o.times, al.played_beats, o.strengths)
        fl = _compound_feel(fl) if compound else fl
        h = hear.hear(x, SR, timing.played_grid(al, grid), mode, spbs[0] if even else spbs)
        if not even:                                           # beats of different lengths: slots of the same length, not the feel's notated count
            if h.mode == "chords":
                h.rhythm = hear.rhythm(o, grid, spbs)
        elif h.mode == "chords" or fl.kind != "straight16":
            h.rhythm = _slot_rhythm(o, al, fl, grid)
        _remap_notes(h, al, fl)
        info = {"case": "a", "feel": _feel_json(fl), "align": {**{k: v for k, v in asdict(al).items() if k != "played_beats"}, "played_beats": al.played_beats}}
        return h, info

    h, info = _cached(cache, analyse)
    fl = timing.Feel(**info["feel"])
    a = info["align"]
    al = timing.Alignment(np.array(a["offset_curve"]), a["mean_offset"], a["max_abs_offset"], a["kind"], np.array(a["played_beats"]), a["confidence"],
                          a["method"], a["drift"], a["n"])
    q = [Fraction(tk) / tl.ppq for _, tk, _ in bg] + [Fraction(end_tick) / tl.ppq]
    head, summary, warn = describe_alignment(al, grid, first, 60 * float(beat) / float(np.median(np.diff(grid.beats))) if len(grid.beats) > 1 else 120.0)
    if al.confidence < timing.UNSURE:
        warn.append(f"unsure how the take lines up with the project's beats (confidence {al.confidence:.2f}: few clear onsets); "
                    "the chords are read on the nearest beats and the bass is on the project's grid")
    warn += _feel_warnings(fl)
    tm = HeardTiming("a", why, fl.kind, fl.swing_ratio, f"project grid ({why}); {_feel_text(fl)}; {summary}", al.kind, round(al.mean_offset * 1000, 1),
                     round(al.drift * 1000, 1), conf={"alignment": round(al.confidence, 2), "feel": round(fl.confidence, 2)}, warnings=warn)
    part = _part(h, grid, q, beat, t["name"], first, tm)
    return Listened(part, h, grid, len({c["sourceHash"] for c in hit}), (first, last), t["name"], beat, tm, None, head)


def _meter_text(mt: timing.Meter | timing.Reading, sig=None) -> str:
    n, d = (mt.beats_per_bar * 3, 8) if mt.unit == "8" else (mt.beats_per_bar, 4)
    return f"{n}/{d}"


def _tempo_warning(bt: timing.BeatTrack) -> str:
    alt = next((a for a in bt.alternatives if a.ratio in (0.5, 2.0)), bt.alternatives[0] if bt.alternatives else None)
    if alt is None:
        return f"tempo {bt.bpm:.0f} bpm is a guess (confidence {bt.confidence:.2f}): the beat is not clear in the audio"
    word = {2.0: "double", 0.5: "half"}.get(alt.ratio)
    return f"tempo {bt.bpm:.0f} bpm, or {alt.bpm:.0f}" + (f": tell me if it's {word}" if word else "") + f" (confidence {bt.confidence:.2f})"


def _meter_warnings(mt: timing.Meter, meter_text: str | None = None, downbeat_beat: int = 0) -> list[str]:
    """What is unsure about the meter; a part a person gave (`--meter`, `--downbeat-beat`) is said to be theirs instead."""
    said = ([f"meter {_meter_text(mt)} as given (--meter)"] if meter_text else []) + \
           ([f"first bar line {abs(downbeat_beat)} beat{'s' * (abs(downbeat_beat) != 1)} {'later' if downbeat_beat > 0 else 'earlier'} than tracked, as given (--downbeat-beat)"] if downbeat_beat else [])
    if meter_text or mt.confidence >= timing.UNSURE:
        return said
    ru = mt.runner_up
    me = _meter_text(mt)
    if ru is None:
        return [f"meter {me} is a guess (confidence {mt.confidence:.2f})"]
    other = _meter_text(ru)
    if other != me:
        return said + [f"meter {me}, could be {other} (confidence {mt.confidence:.2f}): tell me if it's {other}"]
    if downbeat_beat:
        return said
    late = ru.downbeat_index - mt.downbeat_index
    return [f"meter {me}, but where the bars start is a guess (confidence {mt.confidence:.2f}): the first bar line could be {abs(late)} "
            f"beat{'s' * (abs(late) != 1)} {'later' if late > 0 else 'earlier'}"]


class _NoBeats(Exception):
    pass


def _listen_b(client, pid, state, t, clips, bars, mode, wait, cache_dir, snap, why, keep_map, meter_text=None, downbeat_beat=0) -> Listened:
    """Case B: audio only, so the audio defines the time map."""
    tl = Timeline(state)
    if bars:
        origin, end_abs = tl.seconds_at(tl.bar_start(bars[0])), tl.seconds_at(tl.bar_start(bars[1] + 1))
    else:
        origin, end_abs = min(c["startSeconds"] for c in clips), max(c["startSeconds"] + c["lengthSeconds"] for c in clips)
    hit = [c for c in clips if c["startSeconds"] < end_abs and c["startSeconds"] + c["lengthSeconds"] > origin]
    if not hit:
        raise BridgeError(f"track {t['name']!r} has no audio in the bars asked for")
    ppq = tl.ppq
    cache = os.path.join(cache_dir or default_cache_dir(), "analysis", _key(hit, mode, None, origin, snap, "b", end_abs, (meter_text, downbeat_beat)) + ".json")

    def analyse() -> tuple[hear.Heard, dict]:
        x = _window(client, pid, state, t, origin, end_abs, wait, cache_dir)
        tm = timing.analyze(x)
        bt, fl = tm.beats, tm.feel
        if len(bt.times) < 4:
            raise _NoBeats
        mt = timing.override_meter(tm.meter, bt.times, meter_text, downbeat_beat)
        if mt.unit == "8":
            fl = _compound_feel(fl)
        grid = timing.audio_grid(bt, mt)
        beat = Fraction(3, 2) if mt.unit == "8" else Fraction(1)
        h = hear.hear(x, SR, grid, mode, max(1, round(Fraction(snap) * beat / 4)))
        o = hear.onsets(x)
        al = timing.Alignment(np.zeros(len(bt.times)), 0.0, 0.0, "tight", bt.times, 1.0, "beats", 0.0, 0)      # the audio's beats are the played ones
        h.rhythm = _slot_rhythm(o, al, fl, grid) if h.mode == "chords" or fl.kind != "straight16" else h.rhythm
        _remap_notes(h, al, fl)
        info = {"case": "b", "feel": _feel_json(fl), "beats": asdict(bt), "meter": {k: v for k, v in asdict(mt).items() if k != "scores"}, "duration": len(x) / SR}
        return h, info

    def read_on_the_old_map(why_not: str) -> Listened:
        res = _listen_a(client, pid, state, t, clips, bars, mode, wait, cache_dir, snap, "no click or MIDI, and " + why_not)
        res.timing.warnings.insert(0, f"{why_not}: read on the project's own time map, which nobody set; the map is left as it is")
        return res

    try:
        h, info = _cached(cache, analyse)
    except ValueError as e:
        raise BridgeError(str(e)) from None
    except _NoBeats:
        return read_on_the_old_map("no steady beat found in the audio (silence, or a single sound)")
    fl = timing.Feel(**info["feel"])
    b = info["beats"]
    bt = timing.BeatTrack(np.array(b["times"]), np.array(b["tempo_curve"]), b["bpm"], b["confidence"], [timing.Alt(**a) for a in b["alternatives"]],
                          b["variation"], b["support"])
    m = info["meter"]
    ru = timing.Reading(**m["runner_up"]) if m.get("runner_up") else None
    mt = timing.Meter(m["beats_per_bar"], m["unit"], m["downbeat_index"], m["first_downbeat_s"], m["confidence"], ru, {})
    grid = timing.audio_grid(bt, mt)
    beat = Fraction(3, 2) if mt.unit == "8" else Fraction(1)
    n = len(bt.times)
    warn: list[str] = []
    prop = proposing.propose(bt.times, mt, origin, ppq)
    if prop is None:
        return read_on_the_old_map("too few beats to propose a map")
    use = not keep_map
    ivl = float(np.median(np.diff(bt.times))) if n > 1 else 0.5
    if use:
        ptl = Timeline({"meta": {"ppq": ppq}, "regions": prop.regions})
        bpb, d = mt.beats_per_bar, mt.downbeat_index
        bt_ticks = Fraction(ppq) * beat
        def at_tick(k: int) -> Fraction:
            if k >= d:
                j, i = divmod(k - d, bpb)
                return (ptl.bar_start(prop.first_bar + j) + i * bt_ticks) / ppq
            return Fraction(round(ptl.tick_at(origin + float(bt.times[k]))), ppq)
        q = [at_tick(k) for k in range(n + 1)]
        first = prop.first_bar if d == 0 else 1
        last = max(first, prop.first_bar + prop.bars - 1)
        if d == 0 and prop.first_bar > 1:
            first = prop.first_bar
        bar_q = ptl.bar_start(first) / ppq
    else:
        otl = tl
        times = [origin + float(x) for x in bt.times] + [origin + float(bt.times[-1]) + ivl]
        q = [Fraction(round(otl.tick_at(s)), ppq) for s in times]
        first = max(1, otl.bar_of(q[0] * ppq))
        last = max(first, otl.bar_of(q[-1] * ppq - 1))
        bar_q = otl.bar_start(first) / ppq
    bpm, msig, pickup, down = prop.bpm, _meter_text(mt), prop.pickup_s, prop.downbeat_s
    if bt.confidence < timing.UNSURE:
        warn.append(_tempo_warning(bt))
    warn += _meter_warnings(mt, meter_text, downbeat_beat)
    if prop.kind != "steady":
        warn.append(f"rubato: the tempo moves about ±{bt.variation * 100:.0f}%; the proposed map follows it ({prop.kind}, {len(prop.metered())} tempo regions)")
    if bt.support < 0.5 and bt.confidence >= timing.UNSURE:
        warn.append("few notes sound on the beats: the beat is a guess")
    warn += _feel_warnings(fl)
    if keep_map:
        warn.append("--keep-map: the project's map is left alone, so the bass is placed on the old map's ticks and will not sit on its bar lines "
                    f"(the take is {prop.bpm:.1f} bpm {prop.meter})")
    summary = (f"audio only ({why}), so the audio defines the map: {bpm:.1f} bpm {msig}, first downbeat at {down:.2f} s"
               + (f" (a pickup of {pickup:.2f} s)" if pickup else "") + f", {_feel_text(fl)}; confidence tempo {bt.confidence:.2f}, meter {mt.confidence:.2f}")
    tm = HeardTiming("b", why, fl.kind, fl.swing_ratio, summary, bpm=round(bpm, 2), meter=msig, downbeat_s=round(down, 3), pickup_s=pickup,
                     conf={"tempo": round(bt.confidence, 2), "meter": round(mt.confidence, 2), "feel": round(fl.confidence, 2)},
                     warnings=warn, map=[{k: v for k, v in r.items() if k != "id"} for r in prop.regions], keep_map=keep_map)
    where = f"no click: {bpm:.1f} bpm {msig}" + (f", pickup {pickup:.2f} s" if pickup else "")
    part = _part(h, grid, q, beat, t["name"], first, tm, bar_q, skip_pickup=bool(use and mt.downbeat_index))
    return Listened(part, h, grid, len({c["sourceHash"] for c in hit}), (first, last), t["name"], beat, tm, prop if use else None, where)


def _beat_len(gap: Fraction) -> Fraction:
    """A beat's length in quarters, from the gap to the next beat: a free bar's single 'beat' is its whole length, so cap it."""
    return min(gap, Fraction(2))


def _part(h: hear.Heard, grid: hear.Grid, q: list[Fraction], beat: Fraction, track: str, first: int, tm: HeardTiming,
          bar_q: Fraction | None = None, skip_pickup: bool = False) -> HeardPart:
    """The analysis in score time (quarter notes): `q` is the start of every beat of the grid and then the end of the last, in
    quarters. The part's mode is what was heard. `bar_q`: where the first bar starts, when the first chord starts later (a lead-in
    of silence becomes a rest); `skip_pickup`: the grid's first bar is a free bar whose beats are not a regular pattern."""
    def rival(c: hear.ChordSpan) -> tuple[str, float]:
        """The runner-up worth naming: none (empty) when the chord is clear and nothing else comes near."""
        sym, p = c.runner_up if c.runner_up else ("", 0.0)
        return ("", 0.0) if p < 0.05 and c.confidence >= 0.5 else (sym, round(p, 2))

    chords = [HeardChord(q[c.start_beat], q[c.end_beat], c.symbol, c.root_pc, c.bass_pc, c.quality, round(c.confidence, 2),
                         *rival(c), c.implied, c.src) for c in h.chords]
    if chords and bar_q is not None and chords[0].start > bar_q:
        chords.insert(0, HeardChord(bar_q, chords[0].start, "N", 0, 0, "N", 0.0))

    def at(b: Fraction) -> Fraction:                           # a (fractional) beat in quarters
        i = min(int(b), len(q) - 2)
        return q[i] + (b - i) * (q[i + 1] - q[i])

    edges = grid.edges()
    notes = [HeardNote(at(n.start_beat), at(n.end_beat), n.pitch, n.velocity, n.confidence,
                       round(float(np.interp(n.raw_onset_s, edges, [float(x) for x in q])), 3)) for n in h.notes]
    spbs = h.rhythm.beat_slots or [h.rhythm.slots_per_beat] * len(grid.beats)
    bars = grid.bars()
    starts = [q[a] for a, _ in bars]
    beats = [_beat_len(q[a + 1] - q[a]) for a, _ in bars]       # each bar's own beat and slot: the meter can change in a take
    slots = [bt / spbs[a] for (a, _), bt in zip(bars, beats)]
    rows = h.rhythm.bars
    if skip_pickup and len(rows) == len(bars) > 1:
        starts[0], beats[0], slots[0] = bar_q if bar_q is not None else starts[0], beat, beat / spbs[0]
        rows, chords = _free_bar(rows, chords, starts[0], starts[1], slots[0])
    rhythm = (Rhythm(slots[0], beats[0], dict(zip(starts, rows)), {a: x for a, x in zip(starts, slots) if x != slots[0]},
                     {a: x for a, x in zip(starts, beats) if x != beats[0]}) if rows and len(starts) == len(rows) else None)
    return HeardPart(track, f"{_clean_name(track) or 'track'} (heard)", h.key.name, round(h.tuning_cents), _where(tm),
                     first, chords, rhythm, h.mode, notes, tm)


def _free_bar(rows: list[list[float]], chords: list[HeardChord], a: Fraction, b: Fraction, slot: Fraction):
    """The pickup's free bar [a, b) (quarters; its length is nominal, so not a whole number of slots) on a regular slot grid: its row
    of onset strengths is spread over `round((b - a) / slot)` slots, and a chord that changes inside it snaps to a slot, so the bass
    draft gets a rhythm row there and no fractional tick."""
    n = max(1, round((b - a) / slot))
    row = [0.0] * n
    for i, x in enumerate(rows[0]):
        j = min(n - 1, round(i * n / len(rows[0])))
        row[j] = max(row[j], x)

    def snap(t: Fraction) -> Fraction:
        return a + round((t - a) / slot) * slot if a < t < b else t
    out: list[HeardChord] = []
    for c in chords:
        c = c._replace(start=snap(c.start), end=snap(c.end))
        if c.start < c.end:
            out.append(c)
    return [row] + rows[1:], out


def _where(tm: HeardTiming) -> str:
    """The part's `grid` words (what the report says about how the take sits)."""
    if tm.case == "a":
        return {"tight": f"on the grid ({tm.offset_ms:+.0f} ms)", "feel": f"{abs(tm.offset_ms):.0f} ms {'behind' if tm.offset_ms > 0 else 'ahead of'} the beats",
                "drifting": f"drifting from the beats ({tm.drift_ms:+.0f} ms)"}.get(tm.alignment, "on the project's beats")
    return f"audio only: {tm.bpm:.1f} bpm {tm.meter}" if tm.bpm else "audio only"


# --- command ----------------------------------------------------------------------------


def add_meter_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--meter", metavar="N/D", help="case b: the meter, when the audio's reading is wrong (2/4, 3/4, 4/4, 6/8, 9/8, 12/8); the tracked beat is its beat")
    ap.add_argument("--downbeat-beat", type=int, default=0, metavar="N",
                    help="case b: the first bar line is N tracked beats later than the audio's reading has it (negative: earlier)")


def main(argv: list[str]) -> int:
    from ..cli import _bars
    ap = argparse.ArgumentParser(prog="badmidi listen", description="Print the chords or notes heard in a track of a mobdaw project.")
    ap.add_argument("project", help="project id or name")
    ap.add_argument("--track", required=True, help="the audio track (name or id)")
    ap.add_argument("--bars", help="bar range such as 1-16 (default: where the audio is)")
    ap.add_argument("--as", dest="mode", default="auto", choices=MODES,
                    help="chords (a strummed guitar, keys), notes (a sung or single-note line), or auto (default): notes when the audio is one clear line")
    ap.add_argument("--snap", type=int, default=16, metavar="N", help="notes: quantize to 1/N notes (default 16)")
    ap.add_argument("--wait", type=float, default=0, metavar="SECONDS", help="if the take is still uploading, wait up to this long")
    ap.add_argument("--case", default="auto", choices=CASES,
                    help="a: follow the project's time map (it has a click track or MIDI notes); b: the audio defines the map; auto (default): a when the project has a click track or MIDI notes")
    ap.add_argument("--keep-map", action="store_true", help="case b: do not propose a time map; positions are the project's old map's")
    add_meter_args(ap)
    args = ap.parse_args(argv)
    try:
        c = Client()
        pid = c.project_id(args.project)
        state = c.state(pid)
        res = listen(c, pid, state, args.track, _bars(args.bars), args.mode, args.wait, snap=args.snap, case=args.case, keep_map=args.keep_map,
                     meter=args.meter, downbeat_beat=args.downbeat_beat)
    except SampleIncoming:
        sys.exit(f"badmidi listen: the take on {args.track!r} is still uploading from the recorder's device; "
                 "try again in a minute, or pass --wait 120 to wait for it")
    except BridgeError as e:
        sys.exit(f"badmidi listen: {e}")
    print(res.chart())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
