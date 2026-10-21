"""Listen to a track of a mobdaw project: its audio, on the project's beat grid, as a chord chart in score time.

    badmidi listen <project> --track Guitar [--bars 1-16] [--as chords] [--wait 60]

    heard = listen(client, pid, state, "Guitar", bars=(1, 16))   # Listened: .part (a HeardPart), .chart(), .ok
Needs the `badmidi[audio]` extra. The analysis (hear.py) is cached beside the sample cache, keyed by the clips, the options
and the grid, so asking again is instant; bump ANALYSIS_VERSION when hear.py changes what it answers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import asdict, dataclass
from fractions import Fraction

import numpy as np

from ..bridge import BridgeError, Client, SampleIncoming, Timeline, _frac
from ..heard import HeardChord, HeardPart, Rhythm
from ..ingest import _clean_name
from . import hear
from .source import SR, _find_track, default_cache_dir, track_audio

ANALYSIS_VERSION = 1
MODES = ("chords", "notes")


@dataclass
class Listened:
    part: HeardPart
    heard: hear.Heard
    grid: hear.Grid
    takes: int
    bars: tuple[int, int]
    name: str

    @property
    def ok(self) -> bool:
        return self.heard.grid_check.on_grid

    def chart(self) -> str:
        return hear.format_chart(self.heard, self.grid, f"{self.name} (audio, {self.takes} take{'s' * (self.takes != 1)})",
                                 self.bars[0], self.part.mode)

    def problem(self) -> str:
        """Why the grid check failed, and what to do."""
        g = self.heard.grid_check
        if abs(g.drift) > 0.03 or g.spread > 0.03:
            return (f"the playing drifts from the project's beats (drift {g.drift * 1000:+.0f} ms over the take, spread {g.spread * 1000:.0f} ms): "
                    "it was not played to the click. Re-record it to the click, or set the project's tempo from the loop "
                    "(`tempo from loop` in mobdaw), then listen again.")
        return (f"the playing sits {abs(g.mean_offset) * 1000:.0f} ms {'behind' if g.mean_offset > 0 else 'ahead of'} the project's beats: "
                "recording latency compensation is probably off. Re-record, or check the latency setting, then listen again.")


# --- the cache ----------------------------------------------------------------------


def _key(clips: list[dict], mode: str, grid: hear.Grid, origin: float) -> str:
    desc = {"v": ANALYSIS_VERSION, "mode": mode, "origin": round(origin, 4),
            "clips": [[c["sourceHash"], c.get("sourceOffsetSeconds", 0), c["lengthSeconds"], c.get("loopSeconds"), c.get("loopPhaseSeconds", 0),
                       c.get("gain", 1), c["startSeconds"]] for c in clips],
            "grid": [[round(b, 4) for b in grid.beats], grid.bar_starts, round(grid.end or 0, 4)]}
    return hashlib.sha256(json.dumps(desc, sort_keys=True).encode()).hexdigest()


def _heard_from_json(d: dict) -> hear.Heard:
    return hear.Heard(d["tuning_cents"], hear.Key(**d["key"]), hear.GridCheck(**d["grid_check"]),
                      [hear.ChordSpan(**{**c, "runner_up": tuple(c["runner_up"]) if c["runner_up"] else None}) for c in d["chords"]],
                      hear.Rhythm(d["rhythm"]["slots_per_beat"], d["rhythm"]["bars"]), hear.Onsets(**d["onsets"]))


def _cached(path: str, compute) -> hear.Heard:
    try:
        with open(path) as f:
            return _heard_from_json(json.load(f))
    except (OSError, ValueError, KeyError, TypeError):
        pass
    h = compute()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".part"
        with open(tmp, "w") as f:
            json.dump(asdict(h), f, default=float)
        os.replace(tmp, path)
    except OSError:
        pass                                                   # a cache that cannot be written is only slower
    return h


# --- listening ------------------------------------------------------------------------


def audio_bars(tl: Timeline, clips: list[dict]) -> tuple[int, int]:
    """The bars the clips cover: from the bar the first starts in to the bar the last ends in."""
    a = min(c["startSeconds"] for c in clips)
    b = max(c["startSeconds"] + c["lengthSeconds"] for c in clips)
    return max(1, tl.bar_of(_frac(tl.tick_at(a)))), max(1, tl.bar_of(_frac(tl.tick_at(b)) - Fraction(1, 1000)))


def listen(client: Client, pid: str, state: dict, track: str, bars: tuple[int, int] | None = None, mode: str = "chords",
           wait: float = 0, cache_dir: str | None = None) -> Listened:
    """The track's audio as heard chords over `bars` (default: where the audio is). Raises BridgeError (SampleIncoming
    while a take is still uploading) if it cannot."""
    if mode == "notes":
        raise BridgeError("--as notes (a sung or single-note line) is not built yet; use --as chords")
    if mode != "chords":
        raise BridgeError(f"unknown mode {mode!r}; use one of: {', '.join(MODES)}")
    t = _find_track(state, track)
    clips = [c for c in t["clips"] if c["kind"] == "audio"]
    if not clips:
        raise BridgeError(f"track {t['name']!r} has no audio clips")
    tl = Timeline(state)
    first, last = bars or audio_bars(tl, clips)
    if last < first:
        raise BridgeError(f"bars {first}-{last}: the range is empty")
    bg = tl.beat_grid(first, last + 1)
    origin = bg[0][0]
    end_tick = tl.bar_start(last + 1)
    end_abs = tl.seconds_at(end_tick)
    grid = hear.Grid([s - origin for s, _, _ in bg], [b for *_, b in bg], end_abs - origin)
    hit = [c for c in clips if c["startSeconds"] < end_abs and c["startSeconds"] + c["lengthSeconds"] > origin]
    if not hit:
        raise BridgeError(f"track {t['name']!r} has no audio in bars {first}-{last}")
    cache = os.path.join(cache_dir or default_cache_dir(), "analysis", _key(hit, mode, grid, origin) + ".json")

    def analyse() -> hear.Heard:
        sig, t0 = track_audio(client, pid, state, t["id"], SR, wait, cache_dir)
        i0, i1 = round((origin - t0) * SR), round((end_abs - t0) * SR)
        x = np.concatenate([np.zeros(max(0, -i0), np.float32), sig[max(0, i0):max(0, i1)]])
        if len(x) < SR // 4:
            raise BridgeError(f"track {t['name']!r}: almost no audio in bars {first}-{last}")
        h = hear.hear_chords(x, SR, grid)
        beat = (bg[1][1] - bg[0][1]) / tl.ppq if len(bg) > 1 else Fraction(1)
        spb = max(1, round(beat * 4))                          # slots are 16th notes, whatever the beat
        if spb != 4:
            h.rhythm = hear.rhythm(h.onsets, grid, spb, h.grid_check.mean_offset if h.grid_check.on_grid else 0.0)
        return h

    h = _cached(cache, analyse)
    return Listened(_part(h, grid, bg, end_tick, tl.ppq, t["name"], first, mode), h, grid,
                    len({c["sourceHash"] for c in hit}), (first, last), t["name"])


def _part(h: hear.Heard, grid: hear.Grid, bg, end_tick, ppq: int, track: str, first: int, mode: str) -> HeardPart:
    """The analysis in score time (quarter notes)."""
    q = [Fraction(t) / ppq for _, t, _ in bg] + [Fraction(end_tick) / ppq]
    chords = [HeardChord(q[c.start_beat], q[c.end_beat], c.symbol, c.root_pc, c.bass_pc, c.quality, round(c.confidence, 2),
                         c.runner_up[0] if c.runner_up else "", c.implied) for c in h.chords]
    beat = q[1] - q[0] if len(bg) > 1 else Fraction(1)
    spb = h.rhythm.slots_per_beat
    starts = [q[a] for a, _ in grid.bars()]
    rhythm = Rhythm(beat / spb, beat, dict(zip(starts, h.rhythm.bars))) if h.rhythm.bars else None
    gc = h.grid_check
    where = f"on the grid ({gc.mean_offset * 1000:+.0f} ms)" if gc.on_grid else f"OFF the grid ({gc.mean_offset * 1000:+.0f} ms)"
    return HeardPart(track, f"{_clean_name(track) or 'track'} (heard)", h.key.name, round(h.tuning_cents), where, first, chords, rhythm, mode)


# --- command ----------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    from ..cli import _bars
    ap = argparse.ArgumentParser(prog="badmidi listen", description="Print the chords heard in a track of a mobdaw project.")
    ap.add_argument("project", help="project id or name")
    ap.add_argument("--track", required=True, help="the audio track (name or id)")
    ap.add_argument("--bars", help="bar range such as 1-16 (default: where the audio is)")
    ap.add_argument("--as", dest="mode", default="chords", choices=MODES, help="chords (default); notes is not built yet")
    ap.add_argument("--wait", type=float, default=0, metavar="SECONDS", help="if the take is still uploading, wait up to this long")
    args = ap.parse_args(argv)
    try:
        c = Client()
        pid = c.project_id(args.project)
        state = c.state(pid, [args.track])
        res = listen(c, pid, state, args.track, _bars(args.bars), args.mode, args.wait)
    except SampleIncoming:
        sys.exit(f"badmidi listen: the take on {args.track!r} is still uploading from the recorder's device; "
                 "try again in a minute, or pass --wait 120 to wait for it")
    except BridgeError as e:
        sys.exit(f"badmidi listen: {e}")
    if not res.ok:
        print(res.chart().splitlines()[0])
        print(res.problem())
        return 1
    print(res.chart())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
