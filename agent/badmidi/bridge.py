"""The mobdaw bridge: pull a project into a Score, push the edits back as ONE batch of ops.

    badmidi projects                          the projects you can work in
    badmidi pull <project> -o piece.py        the project as a piece (+ piece.mobdaw.json, the snapshot)
    badmidi push piece.py                     dry run: the ops that make the project match the piece
    badmidi push piece.py --apply             send them as one labelled history entry

No model sits between the two: a script reads the project's JSON state, so every real track is in the Score
(`grid`, `lens` and `form` see the whole ensemble) and what is sent is computed, not retyped. Settings come from
the environment, never from a file that could be committed: MOBDAW_URL (default http://localhost:5173, or the
site root such as https://wrongbad.com/mobdaw) and MOBDAW_TOKEN (an API token from the account page).

What is read: regions -> meter / tempo / rit. / accel. / free bars, markers -> sections, `meta.key`, every MIDI
clip's notes at exact positions (`clip.startTick + note.t`, in ticks of `meta.ppq`). Drum-view and audio clips
are left out (said in the report); notes in looped clips are shown as stored and cannot be changed from here.

Notation hints (docs/agent-api.md): push sends each note it adds or updates with a `hint` built from the piece's own engraving
(`badmidi.hints`: exact onset and length, written pieces, tuplet, staff and voice, spelling, articulation) and the track's `clefs`,
so mobdaw's score view shows the piece as written. Pull places a note from its hint when the hint is still fresh (the note's tick,
length and pitch are what the hint was written for) and guesses the rest as before; the report says how many of each. A note whose
performance is unchanged but whose hint differs from the pulled baseline (respelled, re-voiced) is sent as an `updateNotes` with
just the hint. `badmidi push --no-hints` leaves them out.

What is pushed: only notes. A note is identified by (track, onset, pitch): new ones become `addNotes` (into the
clip that covers them, else a new clip), missing ones `removeNotes`, a changed length `updateNotes`; a part the
snapshot doesn't know becomes a new track (`--like <track>` copies another track's whole device chain). Meter,
tempo, markers and the key are the project's: if the piece's timeline differs, push refuses. The one exception is an
audio-only project (no click track, no MIDI notes) pulled with `--listen`: the audio defines the time map, so the pull
puts the proposed map in the piece and the snapshot, and push sends its region ops FIRST in the same batch as the notes
(one history entry; `--keep-map` leaves the map alone). The piece must still match exactly that map. It also refuses
when the project moved since the pull (someone else edited), so pull again.
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import sys
import urllib.error
import urllib.request
from bisect import bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from fractions import Fraction

import hashlib

from . import patches
from .core import Motif, Note, Pitch
from . import hints as hintlib
from .heard import HeardPart
from .ingest import (_Item, _N, _clean_name, _lines_tagged, _pitch, _place, _unique, estimate_key,
                     instrument_for, SourceNote)
from .scale import Scale, key as parse_key
from .score import INSTRUMENTS, Loop, Meter, Score

DEFAULT_URL = "http://localhost:5173"
MAX_OPS, MAX_NOTES = 5000, 100_000     # the server's batch limits (docs/agent-api.md)


class BridgeError(Exception):
    pass


class SampleIncoming(BridgeError):
    """409 sample_incoming: the take is still on the recorder's device; retry, or wait for the `sample` event."""


# --- the API ---------------------------------------------------------------------


class Client:
    """The mobdaw agent API over HTTP (stdlib only)."""

    def __init__(self, base: str | None = None, token: str | None = None):
        self.base = (base or os.environ.get("MOBDAW_URL") or DEFAULT_URL).rstrip("/")
        self.token = token or os.environ.get("MOBDAW_TOKEN")
        if not self.token:
            raise BridgeError("set MOBDAW_TOKEN to an API token (account page -> api tokens); it is read from the "
                              "environment so it never lands in a piece or a snapshot")

    def _call(self, method: str, path: str, body=None):
        req = urllib.request.Request(f"{self.base}/api/agent{path}", method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"authorization": f"Bearer {self.token}", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read())
            except Exception:
                err = {}
            if e.code == 409 and err.get("error") == "sample_incoming":
                raise SampleIncoming(f"{method} {path}: {err.get('message') or 'sample_incoming'}") from None
            raise BridgeError(f"{method} {path}: {e.code} {err.get('message') or err.get('error') or e.reason}"
                              + (f" (op {err['op']})" if err.get("op") is not None else "")) from None
        except urllib.error.URLError as e:
            raise BridgeError(f"cannot reach {self.base}: {e.reason}") from None

    def projects(self) -> list[dict]:
        return self._call("GET", "/projects")

    def project_id(self, ref: str) -> str:
        """A project's id from an id or a (unique, case-insensitive) name."""
        ps = self.projects()
        for p in ps:
            if p["id"] == ref:
                return ref
        hits = [p for p in ps if p["name"].lower() == ref.lower()]
        if len(hits) != 1:
            raise BridgeError(f"{'no' if not hits else 'several'} project named {ref!r}; "
                              "yours: " + (", ".join("%s (%s)" % (q["name"], q["id"]) for q in ps) or "none"))
        return hits[0]["id"]

    def state(self, pid: str, tracks: list[str] | None = None, bars: tuple[int, int] | None = None) -> dict:
        q = []
        if tracks:
            q.append("tracks=" + urllib.request.quote(",".join(tracks)))
        if bars:
            q.append(f"fromBar={bars[0]}&toBar={bars[1]}")
        return self._call("GET", f"/projects/{pid}/state?format=json" + "".join("&" + x for x in q))

    def history_since(self, pid: str, seq: int) -> list[dict]:
        return self._call("GET", f"/projects/{pid}/history?since={seq}&limit=5")

    def sample_url(self, pid: str, hash: str) -> str:
        """The signed download URL of a project sample: absolute (S3) or a path on the server (local storage)."""
        return self._call("GET", f"/projects/{pid}/samples/{hash}/url")["url"]

    def events(self, pid: str, since: int | None = None, wait: float = 0) -> dict:
        """{cursor, events, gap?}: long-poll the project's events (chat, history, presence, samples). Without `since`: from now."""
        return self._call("GET", f"/projects/{pid}/events?wait={wait:g}" + ("" if since is None else f"&since={since}"))

    def chat(self, pid: str, text: str) -> dict:
        """Say something in the project's chat as this token's user ("name (api)")."""
        return self._call("POST", f"/projects/{pid}/chat", {"text": text})

    def ops(self, pid: str, ops: list[dict], label: str) -> dict:
        return self._call("POST", f"/projects/{pid}/ops", {"label": label[:40], "ops": ops})


# --- the project's timeline, in ticks ------------------------------------------------


def _frac(x) -> Fraction:
    """A tick count from the state (JSON numbers, rounded to 3 decimals by the server) as an exact Fraction."""
    return Fraction(x).limit_denominator(1000)


@dataclass
class _Span:
    """One region (or the filler after a free bar) on the tick and second axes; the same layout as `Span` in timemap.ts."""
    bar: int
    end_bar: float                  # first bar after the span (inf for the last)
    tick0: Fraction
    tick1: Fraction | None          # None: runs forever
    sec0: float
    bpm0: float
    bpm1: float
    free: bool
    synthetic: bool
    num: int                        # beats per bar (1 in a free bar)
    bar_ticks: Fraction
    beat_ticks: Fraction


def _ramp_seconds(b0: float, b1: float, ticks: float, ppq: int, total: float) -> float:
    """Seconds for `ticks` ticks of a span that goes from tempo b0 to b1 linearly in ticks (timemap.ts `secondsFor`)."""
    if b0 == b1 or abs(b1 - b0) < 1e-12 * b0:
        return ticks * 60 / (b0 * ppq)
    return 60 * total / (ppq * (b1 - b0)) * math.log((b0 + (b1 - b0) * ticks / total) / b0)


class Timeline:
    """The project's timeline from the regions of a state: bar starts in ticks (exact Fractions) and score time in seconds
    (floats), the same arithmetic as shared/src/timemap.ts: constant tempo, linear tempo ramps (`rampTo`, closed form) and
    free bars (a bar of fixed seconds whose ticks are nominal: its length at the tempo in effect before it, 120 if first;
    a gap after it is filled with the last metered meter at that tempo)."""

    def __init__(self, state: dict):
        self.ppq = state["meta"]["ppq"]
        by_bar: dict[int, dict] = {}
        for r in state["regions"]:                      # same bar: the smallest id wins, as in normalizeRegions
            if r["bar"] not in by_bar or r.get("id", "") < by_bar[r["bar"]].get("id", ""):
                by_bar[r["bar"]] = r
        self.regions = [by_bar[b] for b in sorted(by_bar)]
        if not self.regions or self.regions[0]["bar"] != 1:
            raise BridgeError("the project has no region at bar 1")
        self.spans: list[_Span] = []
        tick, sec, bpm = Fraction(0), 0.0, 120.0        # bpm: the tempo a free bar borrows (the end tempo of what precedes it)
        num, den = 4, 4                                  # the last metered meter, for fillers

        def add(r: dict, end_bar: float, synthetic: bool = False) -> None:
            nonlocal tick, sec, bpm, num, den
            if r["kind"] == "free":
                length = Fraction(r["seconds"]).limit_denominator(1000)
                span = _Span(r["bar"], end_bar, tick, tick + length * Fraction(bpm).limit_denominator(1000) / 60 * self.ppq,
                             sec, bpm, bpm, True, False, 1, length * Fraction(bpm).limit_denominator(1000) / 60 * self.ppq, Fraction(self.ppq))
                sec += float(length)
            else:
                num, den = (int(x) for x in r["meter"].split("/"))
                bt = Fraction(num * 4 * self.ppq, den)
                b0 = float(r["bpm"])
                finite = end_bar != math.inf
                ticks = (end_bar - r["bar"]) * bt if finite else None
                b1 = float(r["rampTo"]) if finite and r.get("rampTo") is not None and r["rampTo"] != r["bpm"] else b0
                span = _Span(r["bar"], end_bar, tick, None if ticks is None else tick + ticks, sec, b0, b1, False, synthetic,
                             num, bt, Fraction(4 * self.ppq, den))
                if ticks is not None:
                    sec += _ramp_seconds(b0, b1, float(ticks), self.ppq, float(ticks))
            self.spans.append(span)
            if span.tick1 is not None:
                tick = span.tick1
            bpm = span.bpm1

        for i, r in enumerate(self.regions):
            nxt = self.regions[i + 1]["bar"] if i + 1 < len(self.regions) else math.inf
            if r["kind"] == "free":
                add(r, r["bar"] + 1)
                if nxt > r["bar"] + 1:
                    add({"kind": "metered", "bar": r["bar"] + 1, "bpm": bpm, "meter": f"{num}/{den}"}, nxt, True)
            else:
                add(r, nxt)
        self._tick0 = [s.tick0 for s in self.spans]
        self._sec0 = [s.sec0 for s in self.spans]
        self._bar0 = [s.bar for s in self.spans]
        # (first bar, ticks per bar) per stored region
        self.bar_ticks: list[tuple[int, Fraction]] = [(s.bar, s.bar_ticks) for s in self.spans if not s.synthetic]

    def bar_start(self, bar: float) -> Fraction:
        s = self.spans[max(0, bisect_right(self._bar0, bar) - 1)]
        return s.tick0 + (Fraction(bar) - s.bar) * s.bar_ticks

    def bar_of(self, tick: Fraction) -> int:
        """The bar a tick is in (1-based)."""
        s = self.spans[max(0, bisect_right(self._tick0, tick) - 1)]
        return s.bar if s.free else s.bar + int((tick - s.tick0) // s.bar_ticks)

    def seconds_at(self, tick) -> float:
        """Score seconds of a tick (timemap.ts `tickToSampleExact` / sampleRate). Before tick 0 the first tempo extrapolates."""
        s = self.spans[max(0, bisect_right(self._tick0, tick) - 1)]
        dt = float(tick - s.tick0)
        total = None if s.tick1 is None else float(s.tick1 - s.tick0)
        if s.free or s.bpm0 == s.bpm1 or total is None:
            return s.sec0 + dt * 60 / (s.bpm0 * self.ppq)
        return s.sec0 + _ramp_seconds(s.bpm0, s.bpm1, dt, self.ppq, total)

    def tick_at(self, seconds: float) -> float:
        """The tick at a score time (timemap.ts `sampleToTick`), as a float; `_frac` it for an exact value."""
        s = self.spans[max(0, bisect_right(self._sec0, seconds) - 1)]
        ds = seconds - s.sec0
        total = None if s.tick1 is None else float(s.tick1 - s.tick0)
        if s.free or s.bpm0 == s.bpm1 or total is None or abs(s.bpm1 - s.bpm0) < 1e-12 * s.bpm0:
            return float(s.tick0) + ds * s.bpm0 * self.ppq / 60
        b = s.bpm0 * math.exp(ds * self.ppq * (s.bpm1 - s.bpm0) / (60 * total))
        return float(s.tick0) + (b - s.bpm0) * total / (s.bpm1 - s.bpm0)

    def beat_grid(self, from_bar: int, to_bar: int, compound: bool = False) -> list[tuple[float, Fraction, bool]]:
        """Every beat of bars [from_bar, to_bar) as (seconds, tick, is_bar_start). A beat is a 1/den note (`beatTicks`); a free
        bar has just its bar line. `compound`: in 6/8, 9/8, 12/8 (groups of three, or none given) a beat is the dotted quarter,
        a group of three 1/8s, which is how such a bar is felt (and how chords change)."""
        out = []
        for bar in range(from_bar, to_bar):
            s = self.spans[max(0, bisect_right(self._bar0, bar) - 1)]
            t0 = self.bar_start(bar)
            step = 3 if compound and self._compound(s) else 1
            for k in range(0, 1 if s.free else math.ceil(s.bar_ticks / s.beat_ticks - Fraction(1, 10**9)), step):
                t = t0 + k * s.beat_ticks
                out.append((self.seconds_at(t), t, k == 0))
        return out

    def _compound(self, s: _Span) -> bool:
        if s.free or s.num < 6 or s.num % 3 or s.beat_ticks * 2 != self.ppq:
            return False
        r = next((r for r in self.regions if r["bar"] == s.bar), None)
        return all(g == 3 for g in (r or {}).get("groups") or [3])


def _meter_text(r: dict) -> str:
    return r["meter"] + (" " + "+".join(map(str, r["groups"])) if r.get("groups") else "")


def _score_meter(r: dict) -> str:
    """badmidi's spelling of a region's meter: '7/8' or '2+2+3/8'."""
    num, den = r["meter"].split("/")
    return f"{'+'.join(map(str, r['groups']))}/{den}" if r.get("groups") else f"{num}/{den}"


# --- reading a state: tracks, clips, notes ---------------------------------------------


class _VN(_N):
    """An importer note that also knows the project's velocity for it."""
    __slots__ = ("vel", "ghost", "tup", "tag")


def _vnote(on: Fraction, dur: Fraction, midi: int, vel: int, ghost: bool, hint: dict | None = None) -> _VN:
    """`ghost`: a repeat of a looped clip's pattern (a later pass). It is placed so the views hear it, but the project has no
    note for it: the loop is the pattern, and the passes are what the loop means. `hint`: the note's fresh notation hint
    (`_fresh_hint`): its spelling, articulations, tuplet and (staff, voice) are used as written instead of guessed."""
    n = _VN(SourceNote(on, dur, midi))
    n.vel, n.ghost, n.tup, n.tag = vel, ghost, None, None
    if hint:
        n.spell, n.art = hint.get("spell"), hint.get("art", "")
        t = hint.get("tup")
        n.tup = (t["n"], t["of"]) if t else None
        n.tag = hint.get("staff", 1) * 1000 + hint.get("voice", 1)
    return n


def _fresh_hint(n: dict) -> dict | None:
    """A project note's notation hint when it is still true of the note: its `at` (tick, length, pitch) equals the note's now
    (the state rounds ticks to 3 decimals), and it is shaped as the API writes it. Anything else: None, and the note is guessed."""
    h = n.get("hint")
    try:
        at = h["at"]
        if not (abs(at[0] - n["t"]) < 0.0011 and abs(at[1] - n["d"]) < 0.0011 and at[2] == n["pitch"]):
            return None
        for k in ("on", "len"):
            if not (len(h[k]) == 2 and all(isinstance(x, int) for x in h[k]) and h[k][1] > 0):
                return None
        if h["len"][0] <= 0:
            return None
        t = h.get("tup")
        if t is not None and not (isinstance(t["n"], int) and isinstance(t["of"], int) and t["n"] > 0 and t["of"] > 0):
            return None
        if not all(isinstance(h.get(k, 1), int) and h.get(k, 1) > 0 for k in ("staff", "voice")):
            return None
        return h
    except (KeyError, TypeError, IndexError):
        return None


def is_drum_track(t: dict) -> bool:
    """A drum track: a clip in drum view, or an instrument chain made only of one-key drums."""
    if any(c.get("view") == "drums" for c in t["clips"] if c["kind"] == "midi"):
        return True
    inst = [d for d in t["devices"] if d["type"] != "mix"]
    return bool(inst) and all(d.get("key") is not None for d in inst)


@dataclass
class _Track:
    info: dict
    drums: bool
    clips: list[dict] = field(default_factory=list)
    notes: list[dict] = field(default_factory=list)       # what plays: pass 1 of a loop has ids, later passes are ghosts
    by_key: dict = field(default_factory=dict)            # (onset, pitch) -> the project's note (pass 1 only)
    hinted: int = 0                                       # notes placed from a fresh notation hint
    guessed: int = 0                                      # notes placed by guessing (no hint, or a stale one: `stale`)
    stale: int = 0


def _collect(state: dict, report: list[str]) -> list[_Track]:
    """The state's MIDI tracks with their notes at exact quarter-note positions, loops unrolled (later passes are
    ghosts: no id, they exist so the views hear the whole piece)."""
    ppq = state["meta"]["ppq"]
    out = []
    for t in state["tracks"]:
        if t["kind"] != "midi":
            if t["clips"]:
                report.append(f"left out: {t['kind']} track {t['name']!r} ({len(t['clips'])} clips)")
            continue
        tr = _Track(t, is_drum_track(t))
        for c in t["clips"]:
            if c["kind"] != "midi":
                continue
            start, length = _frac(c["startTick"]), _frac(c["lengthTicks"])
            loop = _frac(c["loopTicks"]) if c.get("loopTicks") else None
            passes = -(-length // loop) if loop else 1
            whole = bool(loop) and length % loop == 0 and passes >= 2
            readonly = bool(c.get("forever")) or (bool(loop) and not whole)
            tr.clips.append({"id": c["id"], "startTick": c["startTick"], "lengthTicks": c["lengthTicks"], "loopTicks": c.get("loopTicks"),
                             "passes": int(passes) if whole else 1, "readonly": readonly, "view": c.get("view")})
            if c.get("forever"):
                report.append(f"{t['name']!r} clip at {c['start']} loops forever: one pass is shown and it is read-only here")
            elif readonly:
                report.append(f"{t['name']!r} clip at {c['start']} loops in a partial last pass: unrolled, read-only here")
            skipped = 0
            for n in c["notes"]:
                tt, d = _frac(n["t"]), _frac(n["d"])
                hint = None if (tr.drums or loop) else _fresh_hint(n)    # a looped clip is its pattern: guessed, so every pass agrees
                if loop and not c.get("forever"):
                    if tt >= loop:
                        skipped += 1
                        continue
                    d = min(d, loop - tt)
                for k in range(int(passes) if loop and not c.get("forever") else 1):
                    on = start + k * (loop or 0) + tt
                    if on >= start + length:
                        continue
                    row = {"id": n["id"] if k == 0 else None, "clip": c["id"], "on": on / ppq, "dur": min(d, start + length - on) / ppq,
                           "midi": n["pitch"], "vel": n["v"], "readonly": readonly, "hint": None}
                    if k == 0 and hint:       # written as the hint says: its onset and length, not the performed ones
                        row["on"], row["dur"], row["hint"] = start / ppq + Fraction(*hint["on"]), Fraction(*hint["len"]), hint
                    if k == 0 and not tr.drums:
                        if hint:
                            tr.hinted += 1
                        else:
                            tr.guessed += 1
                            tr.stale += bool(n.get("hint"))
                    tr.notes.append(row)
                    if k == 0:
                        tr.by_key[(row["on"], row["midi"])] = row
            if skipped:
                report.append(f"{t['name']!r} clip at {c['start']}: {skipped} notes past the loop length never play and are left out")
        out.append(tr)
    return out


# --- dynamics: velocities -> marks (pull), marks -> velocities (push) ------------------

from . import perform  # noqa: E402
from .core import dyn as dyn_mark  # noqa: E402

_LEVEL_NAMES = sorted(perform.LEVELS, key=perform.LEVELS.get)


def _level_name(v: float) -> str:
    return min(_LEVEL_NAMES, key=lambda k: abs(perform.LEVELS[k] - v))


def _metric(score: Score, t: Fraction) -> int:
    level = score.metric_level(t)
    return perform.METRIC[0] if level == 3 else perform.METRIC[1] if level >= 0 else 0


def infer_dynamics(score: Score, line: list[_Item], drums: bool) -> list[tuple[Fraction, object]]:
    """Dynamics marks that make the line's performed velocities approximate the project's: the velocity less the metric
    accent, smoothed over three notes, as the nearest dynamic level, a mark where it changes. A drum part gets one level
    for the whole part (its hits' variation is accent: ">" on the notes well above it, set on the notes by the caller)."""
    if not line:
        return []
    base = []
    for it in line:
        v = sum(n.vel for n in it.notes) / len(it.notes)
        base.append(v - _metric(score, it.onset))
    if drums:
        level = _level_name(statistics.median(base))
        return [] if level == "mf" else [(line[0].onset, dyn_mark(level))]
    sm = [statistics.median(base[i - 1:i + 2]) if 0 < i < len(base) - 1 else base[i] for i in range(len(base))]   # (the ends have no neighbour to vote)
    cur, marks = "mf", []
    for it, v in zip(line, sm):
        lv = _level_name(v)
        if lv != cur:
            marks.append((it.onset, dyn_mark(lv)))
            cur = lv
    return marks


def performed(score: Score, part) -> dict[tuple[Fraction, int], int]:
    """The velocity the score's markings give each note of a part: (onset, pitch) -> MIDI velocity."""
    dyn = perform.Dynamics(part)
    out = {}
    for on, note in part.events():
        if note.is_rest:
            continue
        v = perform.velocity(dyn, part, on, note)
        for p in note.pitches:
            out[(on, p.midi)] = v
    return out


# --- pull: state -> Score -----------------------------------------------------------


@dataclass
class Pulled:
    score: Score
    snapshot: dict
    report: list[str] = field(default_factory=list)
    heard: dict[str, HeardPart] = field(default_factory=dict)      # HEARD in the piece: name -> what the recording says
    hinted: int = 0                                                # pitched notes placed from a fresh notation hint
    guessed: int = 0                                               # ... and placed by guessing (no hint, or a stale one)


def _timeline_into(score: Score, state: dict, report: list[str]) -> None:
    rs = sorted(state["regions"], key=lambda r: r["bar"])
    tl = Timeline(state)
    bpm = None
    for i, r in enumerate(rs):
        nxt = rs[i + 1] if i + 1 < len(rs) else None
        if r["kind"] == "free":
            q = tl.bar_ticks[i][1] / tl.ppq
            score.free_bar(r["bar"], q)
            continue
        if r["bar"] > 1 and (i == 0 or rs[i - 1]["kind"] == "free" or _score_meter(rs[i - 1]) != _score_meter(r)):
            score.meter_change(r["bar"], _score_meter(r))
        if bpm is not None and abs(r["bpm"] - bpm) > 1e-9:
            score.tempo_mark(r["bar"], bpm=r["bpm"])
        bpm = r["bpm"]
        if r.get("rampTo") is not None and nxt and abs(r["rampTo"] - r["bpm"]) > 1e-9:
            (score.rit if r["rampTo"] < r["bpm"] else score.accel)(r["bar"], nxt["bar"], to=r["rampTo"])
            bpm = r["rampTo"]
    for m in state.get("markers", []):
        if not any(s.bar == m["bar"] for s in score.sections):
            score.section(m["bar"], m["label"], m.get("text"))


def _start_score(state: dict) -> tuple[Score, bool]:
    rs = sorted(state["regions"], key=lambda r: r["bar"])
    first = next((r for r in rs if r["kind"] == "metered"), None)
    key = state["meta"].get("key")
    try:
        scale = parse_key(key) if key else None
    except Exception:
        scale = None
    return Score(state.get("name") or "Untitled", meter=Meter.parse(_score_meter(first) if first else "4/4"),
                 key=scale or "C major", tempo=first["bpm"] if first else 120), scale is not None


def suggest_meter(state: dict) -> str | None:
    """A hint when the map is the 4/4 default but the clips say otherwise (migrated projects default to 4/4): the
    candidate meter whose bars the clips' starts and lengths land on, if 4/4's bars don't fit and one does."""
    rs = state["regions"]
    if len(rs) != 1 or rs[0]["kind"] != "metered" or rs[0]["meter"] != "4/4":
        return None
    ppq = state["meta"]["ppq"]
    spans = [Fraction(v).limit_denominator(1000) for t in state["tracks"] for c in t["clips"] if c["kind"] == "midi"
             for v in (c["startTick"], c["lengthTicks"])]
    for n in (n for t in state["tracks"] for c in t["clips"] if c["kind"] == "midi" for n in c["notes"]):
        spans.append(Fraction(n["d"]).limit_denominator(1000))
    spans = [s for s in spans if s]
    if len(spans) < 4:
        return None
    fits = lambda bar: sum(1 for s in spans if s % bar == 0) / len(spans)
    four = fits(4 * ppq)
    best = max(((fits(Fraction(num * 4 * ppq, den)), f"{num}/{den}") for num, den in ((3, 4), (6, 8), (2, 4), (5, 4), (6, 4), (3, 8))),
               key=lambda x: x[0], default=(0, ""))
    return best[1] if best[0] >= 0.9 and best[0] > four + 0.2 else None


def _baseline(score: Score, parts_by_track: dict[str, list[str]], tracks: list[_Track]) -> list[dict]:
    """What the parts say, per note, with the id of the project's note at that (onset, pitch) and the velocity the
    markings give it now (`pv`): push changes a note's velocity only when its `pv` changes. `hint` is the notation hint
    push would send for the note as the parts say it now (absolute quarters, no `at`): push sends a note's hint again only
    when it differs from this, or when the note's length changes (which makes the project's copy stale)."""
    out = []
    for tr in tracks:
        names = [n for n in parts_by_track.get(tr.info["id"], []) if any(p.name == n for p in score.parts)]
        hints = {} if tr.drums else hintlib.note_hints(score, names)      # what push would send for each note, as the piece says it now
        for name in names:
            part = score[name]
            pv = performed(score, part)
            for on, note in part.events():
                if note.is_rest:
                    continue
                for p in note.pitches:
                    src = tr.by_key.get((on, p.midi))
                    if src:
                        out.append({"track": tr.info["id"], "id": src["id"], "clip": src["clip"], "on": str(on), "dur": str(note.dur),
                                    "midi": p.midi, "vel": src["vel"], "pv": pv[(on, p.midi)], "readonly": src["readonly"],
                                    "hint": hints.get((on, p.midi))})
    return out


def _snapshot(state: dict, project: str, filter_info: dict | None, tracks: list[_Track], parts_by_track: dict, baseline: list[dict], bars: int,
              heard: list[dict] | None = None, map_ops: list[dict] | None = None, map_text: str = "",
              moved: tuple[list[dict], list[str]] = ([], [])) -> dict:
    return {
        "project": project, "rev": state.get("rev"), "ppq": state["meta"]["ppq"], "regions": state["regions"], "filter": filter_info or {},
        "bars": bars, "notes": baseline, "heard": heard or [], "map_ops": map_ops or [], "map_text": map_text,
        "move_ops": moved[0], "moved": moved[1],
        "tracks": [{"id": tr.info["id"], "name": tr.info["name"], "drums": tr.drums, "parts": parts_by_track.get(tr.info["id"], []), "clips": tr.clips,
                    "clefs": tr.info.get("clefs")}
                   for tr in tracks],
    }


def _sig(score: Score, part: str) -> str:
    """A fingerprint of what a part says (onset, pitch, length of every note): how push notices an edit to a heard part."""
    ev = sorted((str(on), m, str(d)) for on, m, d, _ in _events(score, [part]))
    return hashlib.sha1(json.dumps(ev).encode()).hexdigest()


def _staff_mains(score: Score, name: str, inst: str, rng, clefs: list[str] | None, nstaves: int, taken: set[str]) -> list:
    """The first part of each staff of a track: one per clef of its `clefs` (more when the hints use more staves; one when it
    has none), the first named for the track. Staves of one track share a group (a braced grand staff) and a MIDI channel."""
    nstaves = max(1, nstaves, len(clefs or []))
    out = []
    for k in range(1, nstaves + 1):
        kw: dict = {"range": rng} if rng else {}
        if clefs and k <= len(clefs):
            kw["clef"] = hintlib.clef_arg(clefs[k - 1])
        if nstaves > 1:
            kw.update(group=name, channel=name)
        out.append(score.part(name if k == 1 else _unique(f"{name} staff {k}", taken), inst, **kw))
    return out


def _moved_by_map(old_regions: list[dict], new_regions: list[dict], state: dict) -> tuple[list[dict], list[str]]:
    """Ops (after the region ops) and summary lines that keep the markers (by bar) and the empty MIDI clips (by tick) at their old
    time under a new map: each goes to the bar / tick that holds its old project second."""
    old, new = Timeline({"meta": state["meta"], "regions": old_regions}), Timeline({"meta": state["meta"], "regions": new_regions})
    ops, lines = [], []
    for m in state.get("markers", []):
        bar = new.bar_of(_frac(new.tick_at(old.seconds_at(old.bar_start(m["bar"])))))
        if bar != m["bar"]:
            ops.append({"op": "updateMarker", "id": m["id"], "bar": bar})
            lines.append(f"marker {m['label']!r}: bar {m['bar']} -> bar {bar} (keeps its time)")
    for t in state["tracks"]:
        for c in t["clips"]:
            if c["kind"] != "midi" or c["notes"]:
                continue
            tick = round(new.tick_at(old.seconds_at(c["startTick"])))
            if tick != round(c["startTick"]):
                ops.append({"op": "updateClip", "id": c["id"], "start": max(0, tick)})
                lines.append(f"empty clip {c['id']} on {t['name']!r}: tick {c['startTick']:g} -> {max(0, tick)} (keeps its time)")
    return ops, lines


def pull(state: dict, project: str = "", filter_info: dict | None = None, heard: list[HeardPart] | None = None, proposal=None) -> Pulled:
    """A Score and a snapshot from a project state (see the module docstring). `heard`: audio tracks as heard
    (badmidi.audio.listen): each becomes a read-only part "<track> (heard)" and an entry of the piece's HEARD. `proposal`: the time
    map an audio-only project gets from its audio (`Listened.proposal`: `.regions`, `.ops(current regions)`, `.describe()`): the
    Score is built on that map, and the snapshot holds it as the map the piece must match plus the ops that make the project have it,
    which `plan` puts first in the batch."""
    ppq = state["meta"]["ppq"]
    report: list[str] = []
    map_ops, map_text, moved = [], "", ([], [])
    if proposal is not None:
        map_ops = proposal.ops(state["regions"])
        map_text = proposal.describe()
        if map_ops:
            moved = _moved_by_map(state["regions"], proposal.regions, state)
            at = {o["id"]: o["bar"] for o in moved[0] if o["op"] == "updateMarker"}
            state = {**state, "markers": [{**m, "bar": at.get(m["id"], m["bar"])} for m in state.get("markers", [])]}
        state = {**state, "regions": proposal.regions}
        report.append(f"time map: the project had no click or MIDI notes, so the audio defines it: {map_text} "
                      + (f"({len(map_ops)} region ops, sent first in the same push as the bass: one history entry, a revert undoes both)" if map_ops else "(the project already has it)"))
    score, keyed = _start_score(state)
    _timeline_into(score, state, report)
    tracks = _collect(state, report)
    for t in state["tracks"]:
        for c in t["clips"]:
            if c["kind"] == "audio":
                report.append(f"left out: audio clip at {c['start']} on {t['name']!r}")

    if not keyed and heard:
        score.key = parse_key(heard[0].key)
        report.append(f"key: {score.key.name} (heard in {heard[0].track!r}; the project has none; setKey to fix)")
    elif not keyed:
        weights = [0.0] * 12
        for tr in tracks:
            if not tr.drums:
                for n in tr.notes:
                    weights[n["midi"] % 12] += float(n["dur"])
        if any(weights):
            score.key = estimate_key(weights)
            report.append(f"key: {score.key.name} (estimated: the project has none; setKey to fix)")
    hint = suggest_meter(state)
    if hint:
        report.append(f"meter: the project is on the default 4/4 but its clips fit {hint} bars; if that is the music, "
                      f'apply_ops [{{"op": "setRegion", "bar": 1, "meter": "{hint}"}}] and pull again')

    taken: set[str] = set()
    parts_by_track: dict[str, list[str]] = {}
    for i, tr in enumerate(tracks, 1):
        t = tr.info
        name = _unique(_clean_name(t["name"]) or f"track {i}", taken)
        if tr.drums:
            keys = sorted({d["key"] for d in t["devices"] if d.get("key") is not None})
            names = {d["key"]: (d.get("name") or d["type"]) for d in t["devices"] if d.get("key") is not None}
            report.append(f"drums {t['name']!r} (part {name!r}): " + ", ".join(f"{Pitch(k).name} = {names[k]}" for k in keys)
                          + "; not shown in grid / lens / form (name it in --parts to include)")
        dev = " ".join(d.get("name") or d["type"] for d in t["devices"] if d["type"] != "mix")
        inst = "drums" if tr.drums else instrument_for(None, f"{t['name']} {dev}")
        clefs = None if tr.drums else (t.get("clefs") or None)
        if not tr.notes:
            mains = _staff_mains(score, name, inst, None, clefs, len(clefs or []), taken)
            parts_by_track[t["id"]] = [p.name for p in mains]
            continue
        ns = []
        for n in tr.notes:
            vn = _vnote(n["on"], n["dur"], n["midi"], n["vel"], n["id"] is None and not n["readonly"], n["hint"])
            ns.append(vn)
        by_pitch = defaultdict(list)
        for n in sorted(ns, key=lambda n: (n.onset, -n.end)):
            by_pitch[n.midi].append(n)
        dup = 0
        for same in by_pitch.values():                    # a note can't overlap itself in a part
            prev = None
            for n in same:
                if prev and n.onset < prev.end:
                    if n.onset == prev.onset:
                        n.end = n.onset
                        dup += 1
                        continue
                    prev.end = n.onset
                prev = n
        if dup:
            report.append(f"{t['name']!r}: {dup} duplicate notes (same pitch, same onset) are not shown")
        ns = [n for n in ns if n.end > n.onset]
        if tr.drums:                                     # accent the hits well above the part's level
            med = statistics.median(n.vel - _metric(score, n.onset) for n in ns)
            for n in ns:
                if n.vel - _metric(score, n.onset) >= med + 10:
                    n.art = ">"
        chords = defaultdict(list)
        for n in ns:
            chords[(n.onset, n.end, n.tag, n.tup)].append(n)
        items = [_Item(on, end, sorted(g, key=lambda n: n.midi), tag, tup) for (on, end, tag, tup), g in chords.items()]
        tagged = _lines_tagged(items)
        # staff -> its lines, voice 1 first. Hinted notes sit where their hint says (staff, voice); the rest are guessed into the
        # lines as before (the first voice when a hinted voice is known). A voice the hints skip is kept as an empty line.
        if all(tag is None for tag, _ in tagged):
            staff_lines = {1: [line for _, line in tagged]}
        else:
            slots: dict[int, dict[int, list]] = {}
            for tag, line in tagged:
                slots.setdefault(tag // 1000, {}).setdefault(tag % 1000, []).append(line)
            # (a voice that overlaps itself, e.g. a guessed note over a hinted one, gets an extra line after the hinted voices, so they keep their numbers)
            staff_lines = {st: [(vs.get(v) or [[]])[0] for v in range(1, max(vs) + 1)] + [ln for v in sorted(vs) for ln in vs[v][1:]]
                           for st, vs in slots.items()}
        nstaves = max([len(clefs or []), *staff_lines])
        for st in range(1, nstaves + 1):
            staff_lines.setdefault(st, [[]])
        lines = [ln for st in sorted(staff_lines) for ln in staff_lines[st]]
        end_t = max(it.end for l in lines for it in l)
        bar, beat = score.position(end_t)
        nbars = max(1, bar - 1 if beat == 1 else bar)
        pitches = [n.midi for line in lines for it in line for n in it.notes]
        rng = None if tr.drums else (Pitch(min(INSTRUMENTS[inst][1], *pitches)), Pitch(max(INSTRUMENTS[inst][2], *pitches)))
        parts, plines = [], []
        for st, main in enumerate(_staff_mains(score, name, inst, rng, clefs, nstaves, taken), 1):
            ls = staff_lines[st]
            parts += [main] + [main.voice(_unique(f"{main.name} {k}", taken)) for k in range(2, len(ls) + 1)]
            plines += ls
        loops = [(_frac(c["startTick"]) / ppq, _frac(c["loopTicks"]) / ppq, c["passes"]) for c in tr.clips if c["passes"] >= 2 and not c["readonly"]]
        for part, line in zip(parts, plines):
            # dynamics are read from the first pass of a loop and repeated in each pass: a loop is its body
            marks = infer_dynamics(score, [it for it in line if not any(n.ghost for n in it.notes)], tr.drums)
            for a, body, passes in loops:
                marks += [(t + k * body, m) for t, m in marks if a <= t < a + body for k in range(1, passes)]
            _place(score, part, line, sorted(marks, key=lambda x: x[0]), nbars, 4)
        parts_by_track[t["id"]] = [p.name for p in parts]
        # a looped clip is a Loop in the piece (p.loop() in its source): the pattern once, `times` passes
        for a, body, passes in loops:
            for part in parts:
                if any(a <= on < a + body * passes for on, _ in part.events()):
                    score.loops.append(Loop(part, a, body, passes))
    baseline = _baseline(score, parts_by_track, tracks)
    hinted, guessed = sum(tr.hinted for tr in tracks), sum(tr.guessed for tr in tracks)
    if hinted + guessed:
        stale = sum(tr.stale for tr in tracks)
        report.append(f"notation hints: {hinted} of {hinted + guessed} notes placed from fresh hints (onset, length, spelling, tuplet, voice, "
                      f"articulation as written), {guessed} guessed" + (f" ({stale} of them have a stale hint: edited since it was written)" if stale else ""))
    marks, hp = [], {}
    for h in heard or []:
        h.part = _unique(h.part, taken)
        h.add_to(score)
        hp[_unique(_clean_name(h.track) or "track", set(hp))] = h
        marks.append({"part": h.part, "track": h.track, "sig": _sig(score, h.part)})
        what = (f"{len(h.notes)} notes (a line; the chords are a guess from the melody)" if h.mode == "notes" else f"{len(h.chords)} chord spans")
        report.append(f"heard: {h.part!r} from audio track {h.track!r}: {what}, key {h.key}, {h.grid}; "
                      f"read-only (HEARD in the piece has the {'notes, guessed chords' if h.mode == 'notes' else 'chords'} and rhythm; push skips it, --guide pushes it muted)")
        if h.timing:
            report.append(f"timing of {h.track!r} (case {h.timing.case.upper()}): {h.timing.summary}")
            report += [f"warning ({h.track!r}): {w}" for w in h.timing.warnings]
    return Pulled(score, _snapshot(state, project, filter_info, tracks, parts_by_track, baseline, score.bars if score.parts else 0, marks, map_ops, map_text, moved),
                  report, hp, hinted, guessed)


# --- push: Score + snapshot -> ops ---------------------------------------------------


@dataclass
class PushPlan:
    ops: list[dict] = field(default_factory=list)
    summary: list[str] = field(default_factory=list)
    adds: int = 0
    removes: int = 0
    updates: int = 0
    hints: int = 0                  # notes sent with a notation hint (adds, and updates that changed a note's hint)
    new_tracks: int = 0
    new_parts: dict[int, list[str]] = field(default_factory=dict)    # addTrack op index -> the piece's part names for it
    track_parts: dict[str, list[str]] = field(default_factory=dict)  # existing track id -> the piece's part names for it
    guided: list[str] = field(default_factory=list)                  # heard parts pushed as muted tracks (no longer heard parts)

    @property
    def empty(self) -> bool:
        return not self.ops


def _events(score: Score, part_names: list[str]) -> list[tuple[Fraction, int, Fraction, int]]:
    """(onset, pitch, duration, performed velocity) of every note of the parts."""
    out = []
    for name in part_names:
        part = score[name]
        pv = performed(score, part)
        for on, note in part.events():
            for p in note.pitches:
                out.append((on, p.midi, note.dur, pv[(on, p.midi)]))
    return out


def _tick(q: Fraction, ppq: int):
    t = q * ppq
    return int(t) if t.denominator == 1 else round(float(t), 4)


def _tempo_sig(score: Score) -> tuple:
    """The tempo side of a Score's timeline: opening tempo, tempo marks (where, to what, until), free bar lengths."""
    return (float(score.tempo), tuple((m.start, m.bpm, m.end) for m in score.tempo_marks[1:]),
            tuple(sorted((bar, m.free) for bar, m in score._free.items())))


def check_timeline(score: Score, snap: dict) -> None:
    """Refuse when the piece's bars or tempo are not the project's: notes would land in the wrong places. 'The project's' is the
    snapshot's regions: for an audio-only project pulled with `--listen` that is the map proposed from the audio, whose ops
    `plan` sends first in the same batch; anything else the piece changes about meter or tempo is refused."""
    ref_state = {"meta": {"ppq": snap["ppq"]}, "regions": snap["regions"], "markers": []}
    ref, _ = _start_score(ref_state)
    _timeline_into(ref, ref_state, [])
    if _tempo_sig(score) != _tempo_sig(ref):
        raise BridgeError("the piece's tempo or free bars differ from the project's: its meter or tempo map differs from the project's. "
                          "Push only sends notes (and, for an audio-only project, the time map proposed from its audio); change the timeline "
                          "with apply_ops (addRegion / setRegion), then pull again")
    tl = Timeline({"meta": {"ppq": snap["ppq"]}, "regions": snap["regions"]})
    for bar in range(1, max(snap.get("bars", 0), score.bars, *(r["bar"] for r in snap["regions"])) + 2):
        want, got = tl.bar_start(bar), score.bar_start(bar) * snap["ppq"]
        if want != got:
            raise BridgeError(
                f"the piece's bar {bar} starts at tick {float(got):g} but the project's at {float(want):g}: its meter or tempo "
                "map differs from the project's. Push only sends notes; change the timeline with apply_ops "
                "(addRegion / setRegion), then pull again")


def _first_passes(loops: list, events: list) -> list:
    """A loop is its body played `times` times: the later passes are what the loop means, not more notes, so only the first
    pass of each loop is kept (Part refuses notes over a loop's span, so the passes cannot differ)."""
    spans = [(lp.start + lp.body, lp.end) for lp in loops]
    return [e for e in events if not any(a <= e[0] < b for a, b in spans)]


def _reconcile_clips(score: Score, t: dict, parts: list[str], loops: list, ppq: int, pl: "PushPlan") -> list[dict]:
    """The track's clips as they will be after this push. A Loop in the piece at a clip's start makes the clip loop that
    body that many times (an `updateClip` when the project's loop differs); a looped clip with no Loop over it is unlooped,
    and its notes in every pass are then plain notes. A Loop that starts inside a clip without matching its start has no
    clip to be: say so."""
    eff = []
    for c in t["clips"]:
        c = dict(c)
        eff.append(c)
        if c["readonly"]:
            continue
        a = _frac(c["startTick"]) / ppq
        ln = _frac(c["lengthTicks"]) / ppq
        here = [lp for lp in loops if lp.start == a]
        want = {(lp.body, lp.times) for lp in here}
        if len(want) > 1:
            raise BridgeError(f"{t['name']}: the lines of the clip at bar {score.position(a)[0]} loop differently; a clip has one loop")
        if want:
            (body, times), = want
            for name in parts:
                if name not in {lp.part.name for lp in here} and any(a <= on < a + ln for on, n in score[name].events() if not n.is_rest):
                    raise BridgeError(f"{t['name']}: part {name!r} has notes in the looped clip at bar {score.position(a)[0]} but no loop; "
                                      "every line of a looped clip loops together")
            cur = (_frac(c["loopTicks"]) / ppq, c["passes"]) if c["passes"] >= 2 else None
            if cur != (body, times):
                pl.ops.append({"op": "updateClip", "id": c["id"], "loop": _tick(body, ppq), "length": _tick(body * times, ppq)})
                c.update(loopTicks=_tick(body, ppq), passes=times, lengthTicks=_tick(body * times, ppq))
        elif c["passes"] >= 2:
            pl.ops.append({"op": "updateClip", "id": c["id"], "loop": 0})
            c.update(loopTicks=None, passes=1)
    for lp in loops:
        if not any(_frac(c["startTick"]) / ppq == lp.start for c in t["clips"]):
            hit = next((c for c in t["clips"] if _frac(c["startTick"]) / ppq < lp.end and _frac(c["startTick"]) / ppq + _frac(c["lengthTicks"]) / ppq > lp.start), None)
            if hit:
                raise BridgeError(f"{t['name']}: the loop at bar {score.position(lp.start)[0]} overlaps the clip at tick {hit['startTick']}: "
                                  "start it where that clip starts (to loop the clip), or clear() the clip's bars first")
    return eff


def plan(score: Score, snap: dict, like: dict[str, str] | str | None = None, preset: str | None = None,
         sound: dict[str, str] | str | None = None, guide: bool = False, hints: bool = True) -> PushPlan:
    """The ops that turn the snapshot's project into the piece (`sound`: a patch name, or {part: name}, for new tracks). Heard parts (audio as chords) are not the project's: they
    are skipped, and refused if edited; `guide` sends them as muted tracks instead.

    `hints` (default): every note that is added, or updated in length or in how the piece writes it, carries a notation `hint`
    (badmidi.hints: onset and length as exact fractions, written pieces, tuplet, staff and voice, spelling, articulation) and the
    track gets its `clefs`, so mobdaw's score view shows the piece as badmidi engraves it. A note whose performance is unchanged but
    whose hint differs from the snapshot's (respelled, re-voiced) is an `updateNotes` with just the new hint. `hints=False` for a
    server that predates them (it refuses the unknown field)."""
    check_timeline(score, snap)
    heard = {h["part"]: h for h in snap.get("heard", [])}
    if not guide:
        for name, h in heard.items():
            if any(p.name == name for p in score.parts) and _sig(score, name) != h["sig"]:
                raise BridgeError(f"{name!r} is what the recording says, not a track of the project: edits to it are not pushed. "
                                  "Put your changes in another part (HEARD has the chords), or push it as a muted track you can then edit with --guide")
    ppq = snap["ppq"]
    tl = Timeline({"meta": {"ppq": ppq}, "regions": snap["regions"]})
    pl = PushPlan(ops=list(snap.get("map_ops") or []))
    if pl.ops:
        pl.summary.append(f"time map: {snap.get('map_text') or 'from the audio'} ({len(pl.ops)} region ops, first in the batch)")
        pl.ops += snap.get("move_ops") or []
        pl.summary += [f"moved with the map: {line}" for line in snap.get("moved") or []]
    known = {n for t in snap["tracks"] for n in t["parts"]}
    # a voice line added to a known part's staff (part.voice(...)) belongs to that part's track
    extra: dict[str, list[str]] = defaultdict(list)
    for p in score.parts:
        if p.name not in known and p.staff in known:
            extra[next(t["id"] for t in snap["tracks"] if p.staff in t["parts"])].append(p.name)
    lo, hi = _window(snap, tl)
    base = defaultdict(list)
    for n in snap["notes"]:
        base[n["track"]].append(n)
    clips_of = {t["id"]: t["clips"] for t in snap["tracks"]}
    new_notes_total = 0

    def window_ok(on: Fraction, what: str):
        if not (lo <= on * ppq < hi):
            raise BridgeError(f"{what}: a note at tick {float(on * ppq):g} is outside the pulled bars "
                              f"({snap['filter'].get('fromBar')}-{snap['filter'].get('toBar')}); pull the whole project or widen --bars")

    def note_json(on: Fraction, midi: int, dur: Fraction, v: int, origin: Fraction, hs: dict | None = None) -> dict:
        j = {"p": midi, "t": _tick(on - origin, ppq), "d": _tick(dur, ppq), "v": v}
        if hs and (on, midi) in hs:
            j["hint"] = hintlib.shift(hs[(on, midi)], origin)
            pl.hints += 1
        return j

    def clip_ops(track_ref: str, clips: list[dict], notes: list, name: str, drums: bool, loops: list, hs: dict | None = None):
        """addNotes into covering clips; leftovers into new clips: one looped clip per Loop of the piece, one plain clip per
        run of nearby notes. `notes` has only the first pass of every loop."""
        nonlocal new_notes_total
        rest = []
        into: dict[str, list] = defaultdict(list)
        for e in sorted(notes):
            on = e[0]
            for c in clips:
                a, ln = _frac(c["startTick"]), _frac(c["lengthTicks"])
                if not (a <= on * ppq < a + ln):
                    continue
                if c["readonly"]:
                    raise BridgeError(f"{name}: a new note at tick {float(on * ppq):g} falls inside a read-only looped clip")
                into[c["id"]].append((e, a / ppq))
                break
            else:
                rest.append(e)
        for cid, ns in into.items():
            pl.ops.append({"op": "addNotes", "clipId": cid, "notes": [note_json(on, m, d, v, a, hs) for (on, m, d, v), a in ns]})
        view = {"view": "drums"} if drums else {}
        # looped clips for the piece's loops over what is left
        for lp in loops:
            span = [e for e in rest if lp.start <= e[0] < lp.start + lp.body]
            if not span:
                continue
            first = sorted(span)                 # a loop is its body: only the first pass was kept (_first_passes)
            rest = [e for e in rest if e not in span]
            start, length, loop = lp.start * ppq, lp.body * lp.times * ppq, lp.body * ppq
            pl.ops.append({"op": "addMidiClip", "trackId": track_ref, "start": _tick(lp.start, ppq), "length": _tick(lp.body * lp.times, ppq),
                           "loop": _tick(lp.body, ppq), **view})
            cref = f"${len(pl.ops) - 1}"
            pl.ops.append({"op": "addNotes", "clipId": cref, "notes": [note_json(on, m, min(d, lp.body - (on - lp.start)), v, lp.start, hs) for on, m, d, v in first]})
        # new plain clips: from the first bar a run starts in to the bar its last note ends in; a gap of 8+ empty bars splits a run
        runs: list[list] = []
        for n in rest:
            if runs and tl.bar_of(n[0] * ppq) - tl.bar_of(max(x[0] + x[2] for x in runs[-1]) * ppq) <= 8:
                runs[-1].append(n)
            else:
                runs.append([n])
        for run in runs:
            b0 = tl.bar_of(run[0][0] * ppq)
            end = max(on + d for on, _, d, _ in run) * ppq
            b1 = tl.bar_of(end) if end != tl.bar_start(tl.bar_of(end)) else tl.bar_of(end) - 1
            start, stop = tl.bar_start(b0), tl.bar_start(max(b1, b0) + 1)
            pl.ops.append({"op": "addMidiClip", "trackId": track_ref, "start": _tick(start / ppq, ppq), "length": _tick((stop - start) / ppq, ppq), **view})
            cref = f"${len(pl.ops) - 1}"
            pl.ops.append({"op": "addNotes", "clipId": cref, "notes": [note_json(on, m, d, v, start / ppq, hs) for on, m, d, v in run]})

    # existing tracks: diff
    for t in snap["tracks"]:
        parts = [p for p in t["parts"] if any(p == x.name for x in score.parts)] + extra.get(t["id"], [])
        pl.track_parts[t["id"]] = parts
        new = _events(score, parts)
        for e in new:
            window_ok(e[0], t["name"])
        loops = [lp for lp in score.loops if lp.part.name in parts]
        eff = _reconcile_clips(score, t, parts, loops, ppq, pl)
        new = _first_passes(loops, new)
        old = base.get(t["id"], [])
        have = defaultdict(list)
        for n in old:
            have[(Fraction(n["on"]), n["midi"])].append(n)
        hs = hintlib.note_hints(score, parts) if hints and not t.get("drums") else {}
        origin = {c["id"]: _frac(c["startTick"]) / ppq for c in t["clips"]}
        added, changed = [], 0
        for on, midi, dur, v in sorted(new):
            hit = have.get((on, midi))
            if hit:
                n = hit.pop(0)
                patch = {}
                if Fraction(n["dur"]) != dur:
                    patch["d"] = _tick(dur, ppq)
                if n["pv"] != v:
                    patch["v"] = v
                h = hs.get((on, midi))
                # a changed length makes the project's hint stale, so the note's hint goes with it; otherwise only a changed hint is sent
                if h and not n["readonly"] and ("d" in patch or ("hint" in n and n["hint"] != h)):
                    patch["hint"] = hintlib.shift(h, origin[n["clip"]])
                if patch:
                    if n["readonly"]:
                        raise BridgeError(f"{t['name']}: a note in a read-only looped clip changed; those are read-only here")
                    pl.ops.append({"op": "updateNotes", "notes": [{"id": n["id"], **patch}]})
                    pl.updates += 1
                    pl.hints += "hint" in patch
                    changed += 1
            else:
                added.append((on, midi, dur, v))
        gone = [n for ns in have.values() for n in ns]
        if gone and not parts:
            pl.summary.append(f"{t['name']}: all {len(gone)} notes removed (the part is gone from the piece)")
        if any(n["readonly"] for n in gone):
            raise BridgeError(f"{t['name']}: notes in a read-only looped clip were removed; those are read-only here")
        if gone:
            pl.ops.append({"op": "removeNotes", "ids": [n["id"] for n in gone]})
            pl.removes += len(gone)
        if added:
            clip_ops(t["id"], eff, added, t["name"], t.get("drums", False), loops, hs)
            pl.adds += len(added)
            new_notes_total += len(added)
        clefs = hintlib.clefs_of(score, parts) if hints and not t.get("drums") else None
        old_clefs = t.get("clefs")
        # the clefs the piece engraves with; a track the project gave none keeps the score view's choice unless this push writes to it
        if clefs and clefs != old_clefs and (old_clefs or gone or added or changed):
            pl.ops.append({"op": "updateTrack", "id": t["id"], "clefs": clefs})
            pl.summary.append(f"{t['name']}: clefs {'+'.join(clefs)}")
        if gone or added or changed:
            pl.summary.append(f"{t['name']}: +{len(added)} -{len(gone)} ~{changed} notes")

    # new parts -> new tracks (voice lines of a new part share its track)
    groups: dict[str, list[str]] = {}
    for p in score.parts:
        if p.name in known or p.staff in known or (p.name in heard and not guide):
            continue
        groups.setdefault(p.staff, []).append(p.name)
    for root, names in groups.items():
        ev = _first_passes([lp for lp in score.loops if lp.part.name in names], _events(score, names))
        if not ev:
            continue
        for e in ev:
            window_ok(e[0], root)
        drums = score[names[0]].drums
        is_guide = guide and names[0] in heard
        src = None if is_guide else (like.get(root) or like.get("*")) if isinstance(like, dict) else like
        pat = None if is_guide else (sound.get(root) or sound.get("*")) if isinstance(sound, dict) else sound
        if sum(map(bool, (src, preset, pat))) > 1:
            raise BridgeError(f"new part {root!r}: --like, --preset and --patch are alternatives; give one")
        if drums and not (src or preset):
            raise BridgeError(f"new drum part {root!r}: say which track's drum devices it plays (--like <drum track>): "
                              "a drum kit is one keyed one-shot device per drum, which a piece cannot describe")
        op = {"op": "addTrack", "name": heard[names[0]]["track"] + " (heard)" if is_guide else root}
        hs = {} if (is_guide or not hints or drums) else hintlib.note_hints(score, names)
        if hs:
            op["clefs"] = hintlib.clefs_of(score, names)
        if src:
            op["like"] = src
        elif preset:
            op["preset"] = preset
        elif pat:
            op["preset"] = "none"
        pl.ops.append(op)
        ref = f"${len(pl.ops) - 1}"
        pl.new_parts[len(pl.ops) - 1] = names
        if pat:
            try:
                pl.ops.append(patches.device_op(pat, ref))
            except ValueError as e:
                raise BridgeError(str(e)) from None
        if is_guide:
            pl.ops.append({"op": "updateTrack", "id": ref, "muted": True})
            pl.guided += names
        clip_ops(ref, [], ev, root, drums, [lp for lp in score.loops if lp.part.name in names], hs)
        pl.new_tracks += 1
        pl.adds += len(ev)
        new_notes_total += len(ev)
        pl.summary.append(f"new {'drum ' if drums else ''}track {root!r}: {len(ev)} notes" + (" (muted guide of the recording)" if is_guide else f", like {src!r}" if src else f", preset {preset!r}" if preset else f", patch {pat!r}" if pat else ", default instrument (finnwave); --like <track> copies a track's sound, --patch bass is a bass sound"))
    if len(pl.ops) > MAX_OPS or new_notes_total > MAX_NOTES:
        raise BridgeError(f"too big for one batch ({len(pl.ops)} ops, {new_notes_total} notes; limits {MAX_OPS} / {MAX_NOTES})")
    return pl


def _window(snap: dict, tl: Timeline) -> tuple[Fraction, Fraction]:
    f = snap.get("filter") or {}
    lo = tl.bar_start(f["fromBar"]) if f.get("fromBar") else Fraction(0)
    hi = tl.bar_start(f["toBar"] + 1) if f.get("toBar") else Fraction(10 ** 15)
    return lo, hi


def rebaseline(score: Score, snap: dict, state: dict, pl: PushPlan, res: dict) -> dict:
    """The snapshot after a push: the project's new state with the piece as the reference for what each part says (so the
    next push diffs against what was just sent, velocities included)."""
    parts = dict(pl.track_parts)
    for i, names in pl.new_parts.items():
        parts[res["ids"][i]] = names
    tracks = _collect(state, [])
    f = snap.get("filter") or {}
    heard = [h for h in snap.get("heard", []) if h["part"] not in pl.guided]
    return _snapshot(state, snap["project"], f, tracks, parts, _baseline(score, parts, tracks), max(snap.get("bars", 0), score.bars), heard)


# --- files -------------------------------------------------------------------------


def snapshot_path(piece: str) -> str:
    return os.path.splitext(piece)[0] + ".mobdaw.json"


def _jsonable(o):
    if isinstance(o, Fraction):
        return str(o)
    raise TypeError(type(o))


def write_snapshot(path: str, snap: dict) -> None:
    with open(path, "w") as f:
        json.dump(snap, f, default=_jsonable, indent=1)


def read_snapshot(path: str) -> dict:
    if not os.path.exists(path):
        raise BridgeError(f"no snapshot {path}: pull the project first (badmidi pull <project> -o piece.py)")
    with open(path) as f:
        return json.load(f)


def _bars(text: str | None):
    if not text:
        return None
    a, _, b = text.partition("-")
    return int(a), int(b or a)


# --- commands ----------------------------------------------------------------------


def projects_main(argv: list[str]) -> int:
    for p in Client().projects():
        print(f"{p['id']}  {p['name']}  ({p['role']}{'' if p['canEdit'] else ', read-only now'})")
    return 0


def write_pulled(pulled: Pulled, path: str, header: str, phrase: int = 4) -> None:
    """The piece (with HEARD for heard parts) and its snapshot."""
    from .source import write_source
    write_source(pulled.score, path, header, phrase=phrase, heard=pulled.heard or None)
    write_snapshot(snapshot_path(path), pulled.snapshot)


def pull_main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="badmidi pull", description="Pull a mobdaw project into a badmidi piece and a snapshot.")
    ap.add_argument("project", help="project id or name")
    ap.add_argument("-o", "--out", help="piece to write (default: <project name>.py)")
    ap.add_argument("--tracks", help="comma-separated track names or ids: pull only these (push then touches only these)")
    ap.add_argument("--bars", help="bar range such as 17-32: only notes touching them (push then only edits those bars)")
    ap.add_argument("--phrase", type=int, default=4, help="bars per at() call (default 4)")
    ap.add_argument("--listen", action="append", default=[], metavar="TRACK",
                    help="an audio track to hear as chords or notes: a read-only '<track> (heard)' part and HEARD in the piece (needs badmidi[audio]); repeatable")
    ap.add_argument("--as", dest="mode", default="auto", choices=("auto", "chords", "notes"), help="--listen: chords, notes (a sung or single-note line) or auto (default)")
    ap.add_argument("--wait", type=float, default=0, metavar="SECONDS", help="--listen: wait this long for a take that is still uploading")
    ap.add_argument("--case", default="auto", choices=("auto", "a", "b"),
                    help="--listen: a = follow the project's time map (it has a click track or MIDI notes), b = the audio defines the map; default auto")
    ap.add_argument("--keep-map", action="store_true", help="--listen, audio-only project: do not change the project's time map (the bass is placed on the old map's ticks)")
    ap.add_argument("--meter", metavar="N/D", help="--listen, audio-only project: the meter, when the audio's reading is wrong (3/4, 6/8, ...); the tracked beat is its beat")
    ap.add_argument("--downbeat-beat", type=int, default=0, metavar="N",
                    help="--listen, audio-only project: the first bar line is N tracked beats later than the audio's reading has it (negative: earlier)")
    args = ap.parse_args(argv)
    from .views import has_errors
    c = Client()
    pid = c.project_id(args.project)
    tracks = [x for x in (args.tracks or "").split(",") if x] or None
    bars = _bars(args.bars)
    state = c.state(pid, tracks, bars)
    name = next((p["name"] for p in c.projects() if p["id"] == pid), "project")
    state["name"] = name
    heard, charts, proposal = [], [], None
    if args.listen:
        try:
            from .audio.listen import listen
        except ImportError:
            raise BridgeError("--listen needs numpy, scipy and soundfile: pip install 'badmidi[audio]'") from None
        whole = c.state(pid)                  # the case is decided from the whole project (its click track and MIDI notes), whatever --tracks says
        for tr in args.listen:
            try:
                if proposal is None:
                    got = listen(c, pid, whole, tr, bars, args.mode, args.wait, case=args.case, keep_map=args.keep_map,
                                 meter=args.meter, downbeat_beat=args.downbeat_beat)
                else:                         # a second track is heard against the map the first one proposed
                    got = listen(c, pid, {**whole, "regions": proposal.regions}, tr, bars, args.mode, args.wait, case="a")
            except SampleIncoming:
                raise BridgeError(f"the take on {tr!r} is still uploading from the recorder's device; try again in a minute, or pass --wait 120") from None
            proposal = proposal or got.proposal
            heard.append(got.part)
            charts.append(got.chart())
    pulled = pull(state, pid, {k: v for k, v in (("tracks", tracks), ("fromBar", bars and bars[0]), ("toBar", bars and bars[1])) if v}, heard, proposal)
    out = args.out or re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_").lower() + ".py"
    write_pulled(pulled, out, "\n".join([f"pulled from mobdaw project {name!r} ({pid}) at rev {state.get('rev')}", *pulled.report]), args.phrase)
    n = len(pulled.snapshot["notes"])
    print(f"{name}: {len(pulled.score.parts)} parts, {n} notes, rev {state.get('rev')}")
    for line in pulled.report:
        print(line)
    for chart in charts:
        print(chart)
    print(f"wrote {out} and {snapshot_path(out)}" + ("; check reports errors" if has_errors(pulled.score) else ""))
    return 0


def push_main(argv: list[str]) -> int:
    import argparse
    from .cli import load_score
    ap = argparse.ArgumentParser(prog="badmidi push", description="Send a piece's edits back to its mobdaw project as one batch of ops.")
    ap.add_argument("piece")
    ap.add_argument("--apply", action="store_true", help="send the ops (default: print them)")
    ap.add_argument("--label", default="badmidi push", help="the history entry's name (40 characters)")
    ap.add_argument("--like", action="append", default=[], metavar="[PART=]TRACK",
                    help="new tracks copy this track's devices (a bare TRACK applies to every new part); repeatable")
    ap.add_argument("--preset", help="new tracks get this instrument device type (default finnwave)")
    ap.add_argument("--patch", action="append", default=[], metavar="[PART=]NAME",
                    help=f"new tracks get this named sound ({', '.join(patches.PATCHES)}); a bare NAME applies to every new part; repeatable")
    ap.add_argument("--guide", action="store_true", help="push the heard parts as muted MIDI tracks (to see and fix what was heard)")
    ap.add_argument("--json", action="store_true", help="print the ops as JSON")
    ap.add_argument("--no-hints", action="store_true",
                    help="send notes without notation hints and tracks without clefs (for a server that predates them)")
    args = ap.parse_args(argv)
    from .views import has_errors
    snap = read_snapshot(snapshot_path(args.piece))
    score = load_score(args.piece)
    if has_errors(score):
        print(score.check())
        raise BridgeError("the piece has errors: fix them (badmidi piece.py check) before pushing")
    like: dict[str, str] = {}
    for x in args.like:
        k, eq, v = x.partition("=")
        like[k if eq else "*"] = v if eq else k
    patch: dict[str, str] = {}
    for x in args.patch:
        k, eq, v = x.partition("=")
        patch[k if eq else "*"] = v if eq else k
    p = plan(score, snap, like or None, args.preset, patch or None, args.guide, hints=not args.no_hints)
    if p.empty:
        print("nothing to push: the piece matches the project as pulled")
        return 0
    print(f"{len(p.ops)} ops: +{p.adds} -{p.removes} ~{p.updates} notes, {p.new_tracks} new tracks"
          + (f", {p.hints} notes with notation hints" if p.hints else ""))
    for line in p.summary:
        print("  " + line)
    if args.json:
        print(json.dumps(p.ops, indent=1))
    if not args.apply:
        print("dry run; --apply sends it as one history entry")
        return 0
    c = Client()
    pid = snap["project"]
    moved = c.history_since(pid, snap["rev"])
    if moved:
        raise BridgeError(f"the project moved since the pull (rev {snap['rev']}; {moved[-1]['username']}: {moved[-1]['text']!r}): pull again, "
                          "merge your edits into the new piece, and push")
    res = c.ops(pid, p.ops, args.label)
    print(f"pushed as history entry {res['seq']} ({args.label!r}); revert it from the History panel or with the revert tool")
    # refresh the snapshot (new ids, new rev) so the next push diffs against what the project is now
    f = snap.get("filter") or {}
    state = c.state(pid, f.get("tracks"), (f["fromBar"], f["toBar"]) if f.get("fromBar") else None)
    write_snapshot(snapshot_path(args.piece), rebaseline(score, snap, state, p, res))
    return 0


def main(cmd: str, argv: list[str]) -> int:
    try:
        return {"projects": projects_main, "pull": pull_main, "push": push_main}[cmd](argv)
    except BridgeError as e:
        sys.exit(f"badmidi {cmd}: {e}")
