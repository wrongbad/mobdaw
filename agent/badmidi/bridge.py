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

What is pushed: only notes. A note is identified by (track, onset, pitch): new ones become `addNotes` (into the
clip that covers them, else a new clip), missing ones `removeNotes`, a changed length `updateNotes`; a part the
snapshot doesn't know becomes a new track (`--like <track>` copies another track's whole device chain). Meter,
tempo, markers and the key are the project's: if the piece's timeline differs, push refuses. It also refuses
when the project moved since the pull (someone else edited), so pull again.
"""
from __future__ import annotations

import json
import os
import re
import statistics
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from fractions import Fraction

from .core import Motif, Note, Pitch
from .ingest import (_Item, _N, _clean_name, _lines, _pitch, _place, _unique, estimate_key,
                     instrument_for, SourceNote)
from .scale import Scale, key as parse_key
from .score import INSTRUMENTS, Loop, Meter, Score

DEFAULT_URL = "http://localhost:5173"
MAX_OPS, MAX_NOTES = 5000, 100_000     # the server's batch limits (docs/agent-api.md)


class BridgeError(Exception):
    pass


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

    def ops(self, pid: str, ops: list[dict], label: str) -> dict:
        return self._call("POST", f"/projects/{pid}/ops", {"label": label[:40], "ops": ops})


# --- the project's timeline, in ticks ------------------------------------------------


def _frac(x) -> Fraction:
    """A tick count from the state (JSON numbers, rounded to 3 decimals by the server) as an exact Fraction."""
    return Fraction(x).limit_denominator(1000)


class Timeline:
    """Bar starts in ticks from the regions of a state (the same arithmetic as shared/src/timemap.ts at constant tempo;
    ramps change time, not ticks, so ticks need no tempo except for a free bar's nominal length)."""

    def __init__(self, state: dict):
        self.ppq = state["meta"]["ppq"]
        self.regions = sorted(state["regions"], key=lambda r: r["bar"])
        self.bar_ticks: list[tuple[int, Fraction]] = []      # (first bar, ticks per bar) per region
        bpm = Fraction(120)
        for r in self.regions:
            if r["kind"] == "free":
                self.bar_ticks.append((r["bar"], Fraction(r["seconds"]).limit_denominator(1000) * bpm / 60 * self.ppq))
            else:
                bpm = Fraction(r["bpm"]).limit_denominator(1000)
                self.bar_ticks.append((r["bar"], _frac(r["barTicks"])))
        if not self.bar_ticks or self.bar_ticks[0][0] != 1:
            raise BridgeError("the project has no region at bar 1")

    def bar_start(self, bar: int) -> Fraction:
        t = Fraction(0)
        for i, (b0, bt) in enumerate(self.bar_ticks):
            b1 = self.bar_ticks[i + 1][0] if i + 1 < len(self.bar_ticks) else None
            if b1 is None or bar <= b1:
                return t + (bar - b0) * bt
            t += (b1 - b0) * bt
        return t

    def bar_of(self, tick: Fraction) -> int:
        """The bar a tick is in (1-based)."""
        t0 = Fraction(0)
        for i, (b0, bt) in enumerate(self.bar_ticks):
            b1 = self.bar_ticks[i + 1][0] if i + 1 < len(self.bar_ticks) else None
            if b1 is None or tick < t0 + (b1 - b0) * bt:
                return b0 + int((tick - t0) // bt)
            t0 += (b1 - b0) * bt
        return 1


def _meter_text(r: dict) -> str:
    return r["meter"] + (" " + "+".join(map(str, r["groups"])) if r.get("groups") else "")


def _score_meter(r: dict) -> str:
    """badmidi's spelling of a region's meter: '7/8' or '2+2+3/8'."""
    num, den = r["meter"].split("/")
    return f"{'+'.join(map(str, r['groups']))}/{den}" if r.get("groups") else f"{num}/{den}"


# --- reading a state: tracks, clips, notes ---------------------------------------------


class _VN(_N):
    """An importer note that also knows the project's velocity for it."""
    __slots__ = ("vel",)


def _vnote(on: Fraction, dur: Fraction, midi: int, vel: int) -> _VN:
    n = _VN(SourceNote(on, dur, midi))
    n.vel = vel
    return n


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
                           "midi": n["pitch"], "vel": n["v"], "readonly": readonly}
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
    sm = [statistics.median(base[max(0, i - 1):i + 2]) for i in range(len(base))]
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
    return Score(state.get("name") or "Untitled", meter=Meter.parse(_score_meter(rs[0]) if rs[0]["kind"] == "metered" else "4/4"),
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
    markings give it now (`pv`): push changes a note's velocity only when its `pv` changes."""
    out = []
    for tr in tracks:
        for name in parts_by_track.get(tr.info["id"], []):
            if not any(p.name == name for p in score.parts):
                continue
            part = score[name]
            pv = performed(score, part)
            for on, note in part.events():
                if note.is_rest:
                    continue
                for p in note.pitches:
                    src = tr.by_key.get((on, p.midi))
                    if src:
                        out.append({"track": tr.info["id"], "id": src["id"], "clip": src["clip"], "on": str(on), "dur": str(note.dur),
                                    "midi": p.midi, "vel": src["vel"], "pv": pv[(on, p.midi)], "readonly": src["readonly"]})
    return out


def _snapshot(state: dict, project: str, filter_info: dict | None, tracks: list[_Track], parts_by_track: dict, baseline: list[dict], bars: int) -> dict:
    return {
        "project": project, "rev": state.get("rev"), "ppq": state["meta"]["ppq"], "regions": state["regions"], "filter": filter_info or {},
        "bars": bars, "notes": baseline,
        "tracks": [{"id": tr.info["id"], "name": tr.info["name"], "drums": tr.drums, "parts": parts_by_track.get(tr.info["id"], []), "clips": tr.clips}
                   for tr in tracks],
    }


def pull(state: dict, project: str = "", filter_info: dict | None = None) -> Pulled:
    """A Score and a snapshot from a project state (see the module docstring)."""
    ppq = state["meta"]["ppq"]
    report: list[str] = []
    score, keyed = _start_score(state)
    _timeline_into(score, state, report)
    tracks = _collect(state, report)
    for t in state["tracks"]:
        for c in t["clips"]:
            if c["kind"] == "audio":
                report.append(f"left out: audio clip at {c['start']} on {t['name']!r}")

    if not keyed:
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
        if not tr.notes:
            score.part(name, inst)
            parts_by_track[t["id"]] = [name]
            continue
        ns = []
        for n in tr.notes:
            vn = _vnote(n["on"], n["dur"], n["midi"], n["vel"])
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
            chords[(n.onset, n.end)].append(n)
        items = [_Item(on, end, sorted(g, key=lambda n: n.midi), None) for (on, end), g in chords.items()]
        lines = _lines(items)
        end_t = max(it.end for l in lines for it in l)
        bar, beat = score.position(end_t)
        nbars = max(1, bar - 1 if beat == 1 else bar)
        pitches = [n.midi for line in lines for it in line for n in it.notes]
        rng = None if tr.drums else (Pitch(min(INSTRUMENTS[inst][1], *pitches)), Pitch(max(INSTRUMENTS[inst][2], *pitches)))
        main = score.part(name, inst, range=rng) if rng else score.part(name, inst)
        parts = [main] + [main.voice(_unique(f"{name} {k}", taken)) for k in range(2, len(lines) + 1)]
        for part, line in zip(parts, lines):
            _place(score, part, line, infer_dynamics(score, line, tr.drums), nbars, 4)
        parts_by_track[t["id"]] = [p.name for p in parts]
        # loops that repeat whole passes are p.loop() in the piece (the sounding events are the same either way)
        for c in tr.clips:
            if c["passes"] >= 2 and not c["readonly"]:
                a = _frac(c["startTick"]) / ppq
                body = _frac(c["loopTicks"]) / ppq
                for part in parts:
                    if any(a <= on < a + body * c["passes"] for on, _ in part.events()):
                        score.loops.append(Loop(part, a, body, c["passes"]))
    baseline = _baseline(score, parts_by_track, tracks)
    return Pulled(score, _snapshot(state, project, filter_info, tracks, parts_by_track, baseline, score.bars if score.parts else 0), report)


# --- push: Score + snapshot -> ops ---------------------------------------------------


@dataclass
class PushPlan:
    ops: list[dict] = field(default_factory=list)
    summary: list[str] = field(default_factory=list)
    adds: int = 0
    removes: int = 0
    updates: int = 0
    new_tracks: int = 0
    new_parts: dict[int, list[str]] = field(default_factory=dict)    # addTrack op index -> the piece's part names for it
    track_parts: dict[str, list[str]] = field(default_factory=dict)  # existing track id -> the piece's part names for it

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


def check_timeline(score: Score, snap: dict) -> None:
    """Refuse when the piece's bars are not the project's: notes would land in the wrong places."""
    tl = Timeline({"meta": {"ppq": snap["ppq"]}, "regions": snap["regions"]})
    for bar in range(1, max(snap.get("bars", 0), score.bars) + 2):
        want, got = tl.bar_start(bar), score.bar_start(bar) * snap["ppq"]
        if want != got:
            raise BridgeError(
                f"the piece's bar {bar} starts at tick {float(got):g} but the project's at {float(want):g}: its meter or tempo "
                "map differs from the project's. Push only sends notes; change the timeline with apply_ops "
                "(addRegion / setRegion), then pull again")


def _fold_loops(new: list, clips: list[dict], ppq: int, name: str) -> list:
    """Drop the later passes of the project's looped clips from `new` after checking they repeat pass 1: the project holds one
    pass. A pass that was edited alone has no place in the project: say so."""
    for c in clips:
        if c["passes"] < 2 or c["readonly"]:
            continue
        a, loop = _frac(c["startTick"]) / ppq, _frac(c["loopTicks"]) / ppq
        b = a + loop * c["passes"]
        inside = [e for e in new if a <= e[0] < b]
        by_pass = defaultdict(list)
        for on, midi, dur, v in inside:
            k = int((on - a) // loop)
            local = on - a - k * loop
            by_pass[k].append((local, midi, min(dur, loop - local), v))
        first = sorted(by_pass[0])
        for k in range(1, c["passes"]):
            if sorted(by_pass[k]) != first:
                where = f"bar {k + 1} of the loop starting at tick {float(a * ppq):g}"
                raise BridgeError(f"{name}: pass {k + 1} of a looped clip differs from pass 1 ({where}). The project loops one pattern: "
                                  "edit pass 1 (or the p.loop() body), and keep the passes identical")
        new = [e for e in new if not (a + loop <= e[0] < b)]
    return new


def plan(score: Score, snap: dict, like: dict[str, str] | str | None = None, preset: str | None = None) -> PushPlan:
    """The ops that turn the snapshot's project into the piece."""
    check_timeline(score, snap)
    ppq = snap["ppq"]
    tl = Timeline({"meta": {"ppq": ppq}, "regions": snap["regions"]})
    pl = PushPlan()
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

    def note_json(on: Fraction, midi: int, dur: Fraction, v: int, origin: Fraction) -> dict:
        return {"p": midi, "t": _tick(on - origin, ppq), "d": _tick(dur, ppq), "v": v}

    def clip_ops(track_ref: str, track_id: str | None, notes: list, name: str, drums: bool, loops: list):
        """addNotes into covering clips (a looped one takes pass 1 only); leftovers into new clips: one looped clip per
        p.loop() of the piece, one clip per run of nearby notes."""
        nonlocal new_notes_total
        clips = list(clips_of.get(track_id) or []) if track_id else []
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
                if c["passes"] >= 2 and on * ppq >= a + _frac(c["loopTicks"]):
                    break                           # a later pass: folded away before this (identical to pass 1)
                into[c["id"]].append((e, a / ppq))
                break
            else:
                rest.append(e)
        for cid, ns in into.items():
            pl.ops.append({"op": "addNotes", "clipId": cid, "notes": [note_json(on, m, d, v, a) for (on, m, d, v), a in ns]})
        view = {"view": "drums"} if drums else {}
        # looped clips for the piece's loops over what is left
        for lp in loops:
            span = [e for e in rest if lp.start <= e[0] < lp.end]
            if not span:
                continue
            first = sorted(e for e in span if e[0] < lp.start + lp.body)
            for k in range(1, lp.times):
                got = sorted((on - k * lp.body, m, min(d, lp.start + lp.body - (on - k * lp.body)), v) for on, m, d, v in span
                             if lp.start + k * lp.body <= on < lp.start + (k + 1) * lp.body)
                want = sorted((on, m, min(d, lp.start + lp.body - on), v) for on, m, d, v in first)
                if got != want:
                    raise BridgeError(f"{name}: pass {k + 1} of the loop at bar {score.position(lp.start)[0]} differs from pass 1; "
                                      "a looped clip repeats one pattern")
            rest = [e for e in rest if e not in span]
            start, length, loop = lp.start * ppq, lp.body * lp.times * ppq, lp.body * ppq
            pl.ops.append({"op": "addMidiClip", "trackId": track_ref, "start": _tick(lp.start, ppq), "length": _tick(lp.body * lp.times, ppq),
                           "loop": _tick(lp.body, ppq), **view})
            cref = f"${len(pl.ops) - 1}"
            pl.ops.append({"op": "addNotes", "clipId": cref, "notes": [note_json(on, m, min(d, lp.body - (on - lp.start)), v, lp.start) for on, m, d, v in first]})
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
            pl.ops.append({"op": "addNotes", "clipId": cref, "notes": [note_json(on, m, d, v, start / ppq) for on, m, d, v in run]})

    # existing tracks: diff
    for t in snap["tracks"]:
        parts = [p for p in t["parts"] if any(p == x.name for x in score.parts)] + extra.get(t["id"], [])
        pl.track_parts[t["id"]] = parts
        new = _events(score, parts)
        for e in new:
            window_ok(e[0], t["name"])
        new = _fold_loops(new, t["clips"], ppq, t["name"])
        old = base.get(t["id"], [])
        have = defaultdict(list)
        for n in old:
            have[(Fraction(n["on"]), n["midi"])].append(n)
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
                if patch:
                    if n["readonly"]:
                        raise BridgeError(f"{t['name']}: a note in a read-only looped clip changed; those are read-only here")
                    pl.ops.append({"op": "updateNotes", "notes": [{"id": n["id"], **patch}]})
                    pl.updates += 1
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
            loops = [lp for lp in score.loops if lp.part.name in parts]
            clip_ops(t["id"], t["id"], added, t["name"], t.get("drums", False), loops)
            pl.adds += len(added)
            new_notes_total += len(added)
        if gone or added or changed:
            pl.summary.append(f"{t['name']}: +{len(added)} -{len(gone)} ~{changed} notes")

    # new parts -> new tracks (voice lines of a new part share its track)
    groups: dict[str, list[str]] = {}
    for p in score.parts:
        if p.name in known or p.staff in known:
            continue
        groups.setdefault(p.staff, []).append(p.name)
    for root, names in groups.items():
        ev = _events(score, names)
        if not ev:
            continue
        for e in ev:
            window_ok(e[0], root)
        drums = score[names[0]].drums
        src = (like.get(root) or like.get("*")) if isinstance(like, dict) else like
        if drums and not (src or preset):
            raise BridgeError(f"new drum part {root!r}: say which track's drum devices it plays (--like <drum track>): "
                              "a drum kit is one keyed one-shot device per drum, which a piece cannot describe")
        op = {"op": "addTrack", "name": root}
        if src:
            op["like"] = src
        elif preset:
            op["preset"] = preset
        pl.ops.append(op)
        ref = f"${len(pl.ops) - 1}"
        pl.new_parts[len(pl.ops) - 1] = names
        clip_ops(ref, None, ev, root, drums, [lp for lp in score.loops if lp.part.name in names])
        pl.new_tracks += 1
        pl.adds += len(ev)
        new_notes_total += len(ev)
        pl.summary.append(f"new {'drum ' if drums else ''}track {root!r}: {len(ev)} notes" + (f", like {src!r}" if src else (f", preset {preset!r}" if preset else ", default instrument (finnwave); --like <track> copies a track's sound")))
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
    return _snapshot(state, snap["project"], f, tracks, parts, _baseline(score, parts, tracks), max(snap.get("bars", 0), score.bars))


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


def pull_main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="badmidi pull", description="Pull a mobdaw project into a badmidi piece and a snapshot.")
    ap.add_argument("project", help="project id or name")
    ap.add_argument("-o", "--out", help="piece to write (default: <project name>.py)")
    ap.add_argument("--tracks", help="comma-separated track names or ids: pull only these (push then touches only these)")
    ap.add_argument("--bars", help="bar range such as 17-32: only notes touching them (push then only edits those bars)")
    ap.add_argument("--phrase", type=int, default=4, help="bars per at() call (default 4)")
    args = ap.parse_args(argv)
    from .source import write_source
    from .views import has_errors
    c = Client()
    pid = c.project_id(args.project)
    tracks = [x for x in (args.tracks or "").split(",") if x] or None
    bars = _bars(args.bars)
    state = c.state(pid, tracks, bars)
    name = next((p["name"] for p in c.projects() if p["id"] == pid), "project")
    state["name"] = name
    pulled = pull(state, pid, {k: v for k, v in (("tracks", tracks), ("fromBar", bars and bars[0]), ("toBar", bars and bars[1])) if v})
    out = args.out or re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_").lower() + ".py"
    write_source(pulled.score, out, "\n".join([f"pulled from mobdaw project {name!r} ({pid}) at rev {state.get('rev')}", *pulled.report]), phrase=args.phrase)
    write_snapshot(snapshot_path(out), pulled.snapshot)
    n = len(pulled.snapshot["notes"])
    print(f"{name}: {len(pulled.score.parts)} parts, {n} notes, rev {state.get('rev')}")
    for line in pulled.report:
        print(line)
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
    ap.add_argument("--json", action="store_true", help="print the ops as JSON")
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
    p = plan(score, snap, like or None, args.preset)
    if p.empty:
        print("nothing to push: the piece matches the project as pulled")
        return 0
    print(f"{len(p.ops)} ops: +{p.adds} -{p.removes} ~{p.updates} notes, {p.new_tracks} new tracks")
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
