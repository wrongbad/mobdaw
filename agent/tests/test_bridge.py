import os
import tempfile
import unittest
from fractions import Fraction

from badmidi import Score, M
from badmidi.bridge import BridgeError, plan, pull, snapshot_path, suggest_meter, write_snapshot, read_snapshot
from badmidi.cli import load_score
from badmidi.source import write_source
from badmidi.views import has_errors

PPQ = 960
NAME = {36: "C2", 60: "C4", 62: "D4", 64: "E4", 65: "F4", 67: "G4", 69: "A4"}


def note(i, pitch, t, d, v=100):
    return {"id": f"n{i}", "p": NAME.get(pitch, "C4"), "pitch": pitch, "t": t, "d": d, "v": v}


def state(meter="3/4", bar_ticks=2880, tracks=None, regions=None, markers=None):
    return {
        "rev": 7, "meta": {"ppq": PPQ, "sampleRate": 48000, "key": "D minor"},
        "regions": regions or [{"id": "default", "bar": 1, "kind": "metered", "bpm": 60, "meter": meter, "beatTicks": 960, "barTicks": bar_ticks}],
        "markers": markers or [],
        "tracks": tracks if tracks is not None else [
            {"id": "t1", "name": "Cello", "kind": "midi", "muted": False, "soloed": False,
             "devices": [{"id": "d1", "type": "bore", "typeId": 3, "name": "GM Cello", "params": {}}, {"id": "m1", "type": "mix", "typeId": 9, "params": {}}],
             "clips": [{"id": "c1", "kind": "midi", "start": "1.1.0", "startTick": 0, "lengthTicks": bar_ticks * 4, "length": "4 bars", "end": "5.1.0",
                        "notes": [note(i, 62 + (i % 3), i * bar_ticks, bar_ticks) for i in range(4)]}]},
        ],
        "master": {"devices": []}, "name": "Chaconne",
    }


def piece(p, tmp):
    path = os.path.join(tmp, "p.py")
    write_source(p.score, path, "\n".join(p.report))
    write_snapshot(snapshot_path(path), p.snapshot)
    return path


class Bridge(unittest.TestCase):
    def test_pull_is_exact_and_a_noop_push_is_empty(self):
        p = pull(state(), "P")
        self.assertFalse(has_errors(p.score), p.score.check())
        self.assertEqual(p.score.meter_at(1).text, "3/4")
        self.assertEqual(len(p.snapshot["notes"]), 4)
        with tempfile.TemporaryDirectory() as tmp:
            path = piece(p, tmp)
            score = load_score(path)
            self.assertTrue(plan(score, read_snapshot(snapshot_path(path))).empty)

    def test_edits_become_ops(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = piece(pull(state(), "P"), tmp)
            score = load_score(path)
            # a new part against the cello, bar 3 on; and the cello's last bar shortened
            vln = score.part("violin 3", "violin")
            vln.at(3, "A4.hd | G4.hd |")
            score["cello"].clear(4, 4).at(4, "F4.hd R.q |")
            snap = read_snapshot(snapshot_path(path))
            pl = plan(score, snap, like="Cello")
            kinds = [o["op"] for o in pl.ops]
            self.assertEqual(kinds.count("addTrack"), 1)
            self.assertEqual(pl.ops[kinds.index("addTrack")], {"op": "addTrack", "name": "violin 3", "like": "Cello"})
            self.assertEqual(pl.new_tracks, 1)
            clip = pl.ops[kinds.index("addMidiClip")]
            self.assertEqual(clip["start"], 2 * 2880)          # bar 3 in 3/4
            self.assertEqual(clip["length"], 2 * 2880)
            adds = next(o for o in pl.ops if o["op"] == "addNotes" and o["clipId"].startswith("$"))["notes"]
            self.assertIn({"op": "addNotes", "clipId": "c1", "notes": [{"p": 65, "t": 8640, "d": 2880}]}, pl.ops)
            self.assertEqual(pl.removes, 1)                          # the cello's old last note
            self.assertEqual([(n["p"], n["t"], n["d"]) for n in adds], [(69, 0, 2880), (67, 2880, 2880)])

    def test_filter_window_limits_the_diff(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = pull(state(), "P", {"fromBar": 2, "toBar": 3})
            path = piece(p, tmp)
            score = load_score(path)
            score.part("x", "violin").at(1, "C4.hd |")        # bar 1 is outside the pulled window
            with self.assertRaises(BridgeError):
                plan(score, read_snapshot(snapshot_path(path)))

    def test_timeline_mismatch_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = piece(pull(state(), "P"), tmp)
            score = load_score(path)
            score.meter_change(2, "4/4")
            with self.assertRaises(BridgeError) as e:
                plan(score, read_snapshot(snapshot_path(path)))
            self.assertIn("timeline", str(e.exception))

    def test_regions_free_bars_ramps_markers(self):
        regions = [
            {"id": "a", "bar": 1, "kind": "metered", "bpm": 100, "meter": "4/4", "rampTo": 80, "beatTicks": 960, "barTicks": 3840},
            {"id": "b", "bar": 3, "kind": "metered", "bpm": 80, "meter": "7/8", "groups": [2, 2, 3], "beatTicks": 480, "barTicks": 3360},
            {"id": "c", "bar": 5, "kind": "free", "seconds": 6},
            {"id": "d", "bar": 6, "kind": "metered", "bpm": 90, "meter": "7/8", "groups": [2, 2, 3], "beatTicks": 480, "barTicks": 3360},
        ]
        p = pull(state(regions=regions, markers=[{"id": "m", "bar": 3, "label": "B", "text": "odd"}], tracks=[]), "P")
        sc = p.score
        self.assertEqual(sc.meter_at(3).text, "2+2+3/8")
        self.assertEqual([s.label for s in sc.sections], ["B"])
        self.assertTrue(sc.tempo_marks[-1].bpm == 90 or any(m.bpm == 90 for m in sc.tempo_marks))
        from badmidi.bridge import Timeline
        tl = Timeline(state(regions=regions))
        for bar in range(1, 9):
            self.assertEqual(sc.bar_start(bar) * PPQ, tl.bar_start(bar), bar)

    def test_meter_hint(self):
        st = state(meter="4/4", bar_ticks=3840)
        for t in st["tracks"]:
            for c in t["clips"]:
                c["startTick"], c["lengthTicks"] = 0, 2880 * 4
                for i, n in enumerate(c["notes"]):
                    n["t"], n["d"] = i * 2880, 2880
        self.assertEqual(suggest_meter(st), "3/4")
        self.assertIsNone(suggest_meter(state()))

    def test_looped_and_drum_clips(self):
        st = state()
        st["tracks"][0]["clips"].append({"id": "c2", "kind": "midi", "start": "5.1.0", "startTick": 11520, "lengthTicks": 5760, "length": "x", "end": "x",
                                         "loopTicks": 2880, "notes": [note(9, 36, 0, 480)]})
        st["tracks"][0]["clips"].append({"id": "c3", "kind": "midi", "view": "drums", "start": "9.1.0", "startTick": 23040, "lengthTicks": 2880, "length": "x", "end": "x",
                                         "notes": [note(10, 36, 0, 480)]})
        p = pull(st, "P")
        self.assertTrue(any("loops" in r for r in p.report) and any("drum" in r for r in p.report))
        with tempfile.TemporaryDirectory() as tmp:
            path = piece(p, tmp)
            score = load_score(path)
            self.assertTrue(plan(score, read_snapshot(snapshot_path(path))).empty)
            score["cello"].clear(5, 5)
            with self.assertRaises(BridgeError):
                plan(score, read_snapshot(snapshot_path(path)))


if __name__ == "__main__":
    unittest.main()
