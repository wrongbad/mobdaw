"""An offline stand-in for the mobdaw agent API: a project state that applies the ops badmidi's push sends, dict-wise, the way
server/src/agentOps.ts does, and reads back as `GET .../state?format=json` does. Only what push sends: addTrack, addMidiClip,
addNotes, updateNotes, removeNotes, updateClip, updateTrack, with ticks (numbers) for positions and lengths and "$n" references.

What it keeps true to the server, because the bridge depends on it:
  - note ticks are stored exactly and shown rounded to 3 decimals (`t`, `d`); velocity 1..127 is stored /127 and shown rounded;
  - a note's `hint` is validated as the server validates it (shape, `segs` sum, spelling names the pitch, ...) and gets `at` =
    [tick, durTicks, pitch] of the note as it ends up; a patch that changes t/d/p without a hint leaves the old hint alone (stale);
    `hint: null` removes it.
Keep it in step with server/test/agentOps.test.ts if the API changes.
"""
from __future__ import annotations

import copy
import json
import math
from fractions import Fraction

PPQ = 960
CLEFS = ("treble", "bass", "alto", "tenor", "treble_8", "bass_8", "perc")
NAMES = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"]
LETTER = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
ACC = {"": 0, "b": -1, "bb": -2, "#": 1, "##": 2, "x": 2}


class OpError(Exception):
    pass


def regions_of(score) -> list[dict]:
    """The regions (as the state lists them) that make a project's time map the score's: its meters, tempos and ramps."""
    nbars = score.bars
    bars = {1}
    bars |= {b for b, _ in score.meter_changes(nbars)}
    for m in score.tempo_marks[1:]:
        if m.bpm is not None:
            bars.add(score.position(m.start)[0])
            if m.gradual:
                bars.add(score.position(m.end)[0])
    out, bpm = [], float(score.tempo)
    for bar in sorted(bars):
        ramp = None
        for m in score.tempo_marks[1:]:
            if m.bpm is None:
                continue
            if not m.gradual and score.position(m.start)[0] == bar:
                bpm = float(m.bpm)
            if m.gradual and score.position(m.end)[0] == bar:
                bpm = float(m.bpm)
        for m in score.tempo_marks[1:]:
            if m.gradual and m.bpm is not None and score.position(m.start)[0] == bar:
                ramp = float(m.bpm)
        meter = score.meter_at(bar)
        r = {"id": f"r{bar}", "bar": bar, "kind": "metered", "bpm": bpm, "meter": f"{meter.num}/{meter.den}"}
        if meter.explicit:
            r["groups"] = list(meter.groups)
        if ramp is not None:
            r["rampTo"] = ramp
        out.append(r)
    return out


def _r3(x: float) -> float:
    return math.floor(x * 1000 + 0.5) / 1000


def _frac(v, where: str, positive: bool) -> tuple[int, int]:
    if not (isinstance(v, list) and len(v) == 2 and all(isinstance(x, int) and not isinstance(x, bool) for x in v) and v[1] > 0):
        raise OpError(f"{where} must be a fraction [numerator, denominator] of integers with denominator > 0, got {v!r}")
    if (v[0] <= 0) if positive else (v[0] < 0):
        raise OpError(f"{where} out of range: {v!r}")
    return v[0], v[1]


def _posint(v, where: str) -> int:
    if not (isinstance(v, int) and not isinstance(v, bool) and v > 0):
        raise OpError(f"{where} must be a positive integer, got {v!r}")
    return v


def check_hint(h, at: list, where: str = "hint") -> dict:
    """The server's validation of a hint (no `at`) and the stored hint (with it)."""
    if not isinstance(h, dict):
        raise OpError(f"{where} must be an object")
    allowed = ("on", "len", "segs", "tup", "staff", "voice", "spell", "art")
    for k in h:
        if k not in allowed:
            raise OpError(f"{where}: unknown field {k!r}" + (" (at is set by the server)" if k == "at" else ""))
    if "on" not in h or "len" not in h:
        raise OpError(f"{where}: on and len are required")
    on, ln = _frac(h["on"], f"{where}.on", False), _frac(h["len"], f"{where}.len", True)
    out = {"at": at, "on": h["on"], "len": h["len"]}
    if h.get("segs") is not None:
        segs = h["segs"]
        if not isinstance(segs, list) or not segs:
            raise OpError(f"{where}.segs must be a non-empty array")
        total = sum(Fraction(*_frac(s, f"{where}.segs[{i}]", True)) for i, s in enumerate(segs))
        if total != Fraction(*ln):
            raise OpError(f"{where}.segs must add up to len")
        out["segs"] = segs
    if h.get("tup") is not None:
        t = h["tup"]
        if not isinstance(t, dict) or set(t) - {"n", "of", "start", "span"}:
            raise OpError(f"{where}.tup must be {{n, of, start, span}}")
        _posint(t.get("n"), f"{where}.tup.n"), _posint(t.get("of"), f"{where}.tup.of")
        _frac(t.get("start"), f"{where}.tup.start", False), _frac(t.get("span"), f"{where}.tup.span", True)
        out["tup"] = t
    for k in ("staff", "voice"):
        if h.get(k) is not None:
            out[k] = _posint(h[k], f"{where}.{k}")
    if h.get("spell") is not None:
        import re
        m = re.fullmatch(r"([A-G])(bb|##|b|#|x)?(-?\d+)", h["spell"]) if isinstance(h["spell"], str) else None
        if not m:
            raise OpError(f"{where}.spell must be a note name, got {h['spell']!r}")
        if 12 * (int(m[3]) + 1) + LETTER[m[1]] + ACC[m[2] or ""] != at[2]:
            raise OpError(f"{where}.spell {h['spell']!r} does not name the note's pitch {at[2]}")
        out["spell"] = h["spell"]
    if h.get("art"):
        if not isinstance(h["art"], str) or any(c not in ">^'_" for c in h["art"]):
            raise OpError(f"{where}.art must use only > ^ ' _")
        out["art"] = h["art"]
    return out


class FakeMobdaw:
    """A project: a time map, a key and tracks with clips and notes."""

    def __init__(self, regions: list[dict], key: str = "C major", name: str = "Fake"):
        self.regions, self.key, self.name = regions, key, name
        self.tracks: list[dict] = []
        self.markers: list[dict] = []
        self.rev = 0
        self._ids = 0

    def _id(self, prefix: str) -> str:
        self._ids += 1
        return f"{prefix}{self._ids}"

    # --- reads

    def state(self) -> dict:
        """What `GET /state?format=json` shows: notes with t and d rounded to 3 decimals, the hint as stored."""
        tracks = []
        for t in self.tracks:
            clips = []
            for c in t["clips"]:
                notes = []
                for n in sorted(c["notes"], key=lambda n: (n["tick"], n["pitch"])):
                    j = {"id": n["id"], "p": NAMES[n["pitch"] % 12].upper() + str(n["pitch"] // 12 - 1), "pitch": n["pitch"],
                         "t": _r3(n["tick"]), "d": _r3(n["dur"]), "v": round(n["velocity"] * 127)}
                    if n.get("hint"):
                        j["hint"] = copy.deepcopy(n["hint"])
                    notes.append(j)
                clip = {"id": c["id"], "kind": "midi", "start": "", "startTick": _r3(c["start"]), "lengthTicks": _r3(c["length"]), "length": "", "end": "",
                        "notes": notes}
                if c.get("loop"):
                    clip["loopTicks"] = _r3(c["loop"])
                clips.append(clip)
            tracks.append({"id": t["id"], "name": t["name"], "kind": "midi", "muted": t["muted"], "soloed": False,
                           "devices": [{"id": f"d{t['id']}", "type": "finnwave", "typeId": 2, "params": {}}, {"id": f"m{t['id']}", "type": "mix", "typeId": 9, "params": {}}],
                           "clips": clips, **({"clefs": list(t["clefs"])} if t.get("clefs") else {})})
        return json.loads(json.dumps({"rev": self.rev, "meta": {"ppq": PPQ, "sampleRate": 48000, "key": self.key}, "regions": self.regions,
                                      "markers": copy.deepcopy(self.markers), "tracks": tracks, "master": {"devices": []}, "samples": {}, "name": self.name}))

    # --- writes

    def apply(self, ops: list[dict]) -> dict:
        """All or nothing, one revision, like the server: a bad op leaves the project as it was."""
        before = (copy.deepcopy(self.tracks), copy.deepcopy(self.markers), copy.deepcopy(self.regions), self._ids)
        results: list = []
        try:
            for i, op in enumerate(ops):
                try:
                    results.append(getattr(self, "_" + op["op"])(op, results))
                except OpError as e:
                    raise OpError(f"op {i}: {e}") from None
        except Exception:
            self.tracks, self.markers, self.regions, self._ids = before
            raise
        self.rev += 1
        return {"seq": self.rev, "results": results, "ids": results}

    def _ref(self, v, results):
        if isinstance(v, str) and v.startswith("$"):
            a, _, b = v[1:].partition(".")
            r = results[int(a)]
            return r[int(b)] if b else r
        return v

    def _track(self, v, results) -> dict:
        tid = self._ref(v, results)
        return next((t for t in self.tracks if t["id"] == tid), None) or self._fail(f"no track {tid!r}")

    def _fail(self, msg):
        raise OpError(msg)

    def _clefs(self, v):
        if not (isinstance(v, list) and 1 <= len(v) <= 8 and all(c in CLEFS for c in v)):
            raise OpError(f"bad clefs {v!r}")
        return list(v)

    def _addTrack(self, op, results):
        t = {"id": self._id("t"), "name": op["name"], "muted": False, "clips": []}
        if op.get("clefs") is not None:
            t["clefs"] = self._clefs(op["clefs"])
        self.tracks.append(t)
        return t["id"]

    def _updateTrack(self, op, results):
        t = self._track(op["id"], results)
        if "clefs" in op:
            if op["clefs"] is None:
                t.pop("clefs", None)
            else:
                t["clefs"] = self._clefs(op["clefs"])
        if op.get("muted") is not None:
            t["muted"] = op["muted"]
        return t["id"]

    def _addMidiClip(self, op, results):
        t = self._track(op["trackId"], results)
        c = {"id": self._id("c"), "start": op["start"], "length": op["length"], "notes": []}
        if op.get("loop"):
            c["loop"] = op["loop"]
        t["clips"].append(c)
        return c["id"]

    def _clip(self, v, results) -> dict:
        cid = self._ref(v, results)
        return next((c for t in self.tracks for c in t["clips"] if c["id"] == cid), None) or self._fail(f"no clip {cid!r}")

    def _updateClip(self, op, results):
        c = self._clip(op["id"], results)
        if op.get("start") is not None:
            c["start"] = op["start"]
        if "length" in op:
            c["length"] = op["length"]
        if "loop" in op:
            if op["loop"]:
                c["loop"] = op["loop"]
            else:
                c.pop("loop", None)
        return c["id"]

    def _addRegion(self, op, results):
        """A region at a bar replaces the one there (the agent view's fields only: no beatTicks / barTicks)."""
        r = {"id": f"r{op['bar']}", "bar": op["bar"], **({"kind": "free", "seconds": op["free"]} if op.get("free") else
             {"kind": "metered", "bpm": op["bpm"], "meter": op["meter"], **({"rampTo": op["rampTo"]} if op.get("rampTo") else {})})}
        self.regions = sorted([x for x in self.regions if x["bar"] != op["bar"]] + [r], key=lambda x: x["bar"])
        return r["id"]

    def _removeRegion(self, op, results):
        if op["bar"] == 1 or not any(x["bar"] == op["bar"] for x in self.regions):
            raise OpError(f"no removable region at bar {op['bar']}")
        self.regions = [x for x in self.regions if x["bar"] != op["bar"]]
        return op["bar"]

    def _updateMarker(self, op, results):
        m = next((m for m in self.markers if m["id"] == op["id"]), None) or self._fail(f"no marker {op['id']!r}")
        if op.get("bar") is not None:
            m["bar"] = op["bar"]
        return m["id"]

    def _addNotes(self, op, results):
        c = self._clip(op["clipId"], results)
        ids = []
        for n in op["notes"]:
            if not isinstance(n["p"], int) or not 0 <= n["p"] <= 127:
                raise OpError(f"bad pitch {n['p']!r}")
            if not n["t"] < c["length"]:
                raise OpError(f"t={n['t']} is past the end of the clip")
            if not n["d"] > 0:
                raise OpError("d (length) must be > 0")
            note = {"id": self._id("n"), "tick": n["t"], "dur": n["d"], "pitch": n["p"], "velocity": round(n.get("v", 100)) / 127}
            if n.get("hint") is not None:
                note["hint"] = check_hint(n["hint"], [note["tick"], note["dur"], note["pitch"]], "hint")
            c["notes"].append(note)
            ids.append(note["id"])
        return ids

    def _updateNotes(self, op, results):
        ids = []
        for u in op["notes"]:
            nid = self._ref(u["id"], results)
            note = next((n for t in self.tracks for c in t["clips"] for n in c["notes"] if n["id"] == nid), None)
            if note is None:
                raise OpError(f"no note {nid!r}")
            if "p" in u:
                note["pitch"] = u["p"]
            if "t" in u:
                note["tick"] = u["t"]
            if "d" in u:
                note["dur"] = u["d"]
            if "v" in u:
                note["velocity"] = round(u["v"]) / 127
            if u.get("hint") is not None:
                note["hint"] = check_hint(u["hint"], [note["tick"], note["dur"], note["pitch"]], "hint")
            elif "hint" in u:
                note.pop("hint", None)
            ids.append(nid)
        return ids

    def _removeNotes(self, op, results):
        ids = [self._ref(i, results) for i in op["ids"]]
        for t in self.tracks:
            for c in t["clips"]:
                c["notes"] = [n for n in c["notes"] if n["id"] not in ids]
        return ids
