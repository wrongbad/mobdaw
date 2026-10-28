"""Notation hints through the bridge, offline: push writes them, pull reads them. A fake project (tests/fake_mobdaw.py) applies the ops
as the server does, hints validated and `at` added, and reads back as the state endpoint does."""
import os
import sys
import tempfile
import unittest
from fractions import Fraction as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))     # fake_mobdaw.py, whichever way the tests are started
from fake_mobdaw import FakeMobdaw, OpError, regions_of  # noqa: E402

from badmidi.bridge import plan, pull, read_snapshot, rebaseline, snapshot_path, write_pulled  # noqa: E402
from badmidi.cli import load_score  # noqa: E402
from badmidi.hints import note_hints  # noqa: E402
from badmidi.views import has_errors  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
WOVEN = os.path.join(HERE, "..", "examples", "woven_chaconne.py")
PPQ = 960


def written(score, name):
    """What a part writes, as the engraving sees it: onset, pitches with spelling, length, tuplet, articulations (no fermata:
    it is not a hint field)."""
    return [(t, tuple((p.midi, p.spell) for p in n.pitches), n.dur, n.tuplet, "".join(c for c in n.art if c != "@"))
            for t, n in score[name].events() if not n.is_rest]


def hint(on, ln, staff=1, voice=1, **kw):
    return {"on": on, "len": ln, "staff": staff, "voice": voice, **kw}


def one_staff_project():
    """4/4, one track: C5 Db5 quarters, a half D5 with an accent; bar 2 a whole E5, all with hints."""
    fake = FakeMobdaw([{"id": "r", "bar": 1, "kind": "metered", "bpm": 120, "meter": "4/4"}], "C major")
    fake.apply([
        {"op": "addTrack", "name": "Flute", "clefs": ["treble"]},
        {"op": "addMidiClip", "trackId": "$0", "start": 0, "length": 2 * 4 * PPQ},
        {"op": "addNotes", "clipId": "$1", "notes": [
            {"p": 72, "t": 0, "d": PPQ, "hint": hint([0, 1], [1, 1], spell="C5")},
            {"p": 73, "t": PPQ, "d": PPQ, "hint": hint([1, 1], [1, 1], spell="Db5")},
            {"p": 74, "t": 2 * PPQ, "d": 2 * PPQ, "hint": hint([2, 1], [2, 1], art=">")},
            {"p": 76, "t": 4 * PPQ, "d": 4 * PPQ, "hint": hint([4, 1], [4, 1])},
        ]},
    ])
    return fake


class Woven(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.score = load_score(WOVEN)
        cls.fake = FakeMobdaw(regions_of(cls.score), "E minor", "Woven")
        cls.empty = pull(cls.fake.state(), "P")
        cls.plan = plan(cls.score, cls.empty.snapshot)

    def notes_of(self, track, bar_from, bar_to):
        """The addNotes entries of the new track named `track` that start in bars [from, to) of 3/4 (absolute quarters)."""
        ops = self.plan.ops
        ref = next(f"${i}" for i, o in enumerate(ops) if o["op"] == "addTrack" and o["name"] == track)
        clip = next((i, o) for i, o in enumerate(ops) if o["op"] == "addMidiClip" and o["trackId"] == ref)
        notes = next(o for o in ops if o["op"] == "addNotes" and o["clipId"] == f"${clip[0]}")["notes"]
        origin = clip[1]["start"]
        return [n for n in notes if (bar_from - 1) * 3 * PPQ <= n["t"] + origin < (bar_to - 1) * 3 * PPQ]

    def test_bar_25_violin_1_is_a_staccato_hocket(self):
        notes = self.notes_of("violin 1", 25, 26)
        self.assertEqual(len(notes), 4)
        for n in notes:
            h = n["hint"]
            self.assertEqual(F(*h["on"]) % F(3, 4), 0, h)             # every third sixteenth
            self.assertEqual(h["len"], [1, 4])
            self.assertEqual(h["art"], "'")
            self.assertEqual((h["staff"], h["voice"]), (1, 1))
            self.assertNotIn("tup", h)
            self.assertNotIn("segs", h)
            self.assertEqual(n["d"], PPQ // 4)                          # the performed length is the written one: unchanged by hints
        self.assertEqual([F(*n["hint"]["on"]) for n in notes], [F(72), F(72) + F(3, 4), F(72) + F(3, 2), F(72) + F(9, 4)])

    def test_bar_57_quintuplets(self):
        notes = self.notes_of("violin 1", 57, 58)
        fives = [n for n in notes if n["hint"]["len"] == [1, 5]]
        self.assertEqual(len(fives), 15)                                  # three beats of five
        for k, n in enumerate(fives):
            self.assertEqual(n["hint"]["tup"], {"n": 5, "of": 4, "start": [168 + k // 5, 1], "span": [1, 1]})
            self.assertEqual(F(*n["hint"]["on"]), 168 + F(k, 5))
            self.assertEqual(n["t"], 168 * PPQ + k * PPQ // 5)
        first = fives[0]
        self.assertEqual(first["p"], 83)
        self.assertEqual(first["hint"]["art"], ">")
        self.assertEqual(first["hint"]["spell"], "B5")
        self.assertEqual(first["d"], 192)

    def test_tracks_get_their_clefs_and_the_server_accepts_every_hint(self):
        adds = {o["name"]: o for o in self.plan.ops if o["op"] == "addTrack"}
        self.assertEqual({k: v["clefs"] for k, v in adds.items()}, {"violin 1": ["treble"], "violin 2": ["treble"], "viola": ["treble"], "cello": ["bass"]})
        fake = FakeMobdaw(regions_of(self.score), "E minor")
        fake.apply(self.plan.ops)                                         # validates every hint like the server
        self.assertEqual(self.plan.hints, sum(len(o["notes"]) for o in self.plan.ops if o["op"] == "addNotes"))

    def test_without_hints_nothing_new_is_sent(self):
        pl = plan(self.score, self.empty.snapshot, hints=False)
        self.assertNotIn("clefs", str(pl.ops))
        self.assertNotIn("hint", str(pl.ops))

    def test_round_trip(self):
        """push -> project -> pull gives back the same notes, with the same lengths, spelling, tuplets, articulations and hints,
        every note placed from its hint; pushing the pulled piece again is a no-op."""
        fake = FakeMobdaw(regions_of(self.score), "E minor", "Woven")
        fake.apply(self.plan.ops)
        back = pull(fake.state(), "P")
        self.assertFalse(has_errors(back.score), back.score.check())
        total = sum(len(written(self.score, n)) for n in ("violin 1", "violin 2", "viola", "cello"))
        self.assertEqual((back.hinted, back.guessed), (total, 0))
        self.assertIn(f"notation hints: {total} of {total} notes placed from fresh hints", back.report[-1])
        for name in ("violin 1", "violin 2", "viola", "cello"):
            self.assertEqual(written(back.score, name), written(self.score, name), name)
            self.assertEqual(note_hints(back.score, [name]), note_hints(self.score, [name]), name)
        self.assertIn((F(168), ((83, None),), F(1, 5), (5, 4), ">"), written(back.score, "violin 1"))
        self.assertTrue(plan(back.score, back.snapshot).empty)
        with tempfile.TemporaryDirectory() as tmp:                        # through the piece file and its snapshot
            path = os.path.join(tmp, "p.py")
            write_pulled(back, path, "\n".join(back.report))
            self.assertTrue(plan(load_score(path), read_snapshot(snapshot_path(path))).empty)

    def test_a_pulled_piece_pushes_edits_with_hints(self):
        fake = FakeMobdaw(regions_of(self.score), "E minor", "Woven")
        fake.apply(self.plan.ops)
        back = pull(fake.state(), "P")
        cello = back.score["cello"]
        before = len(written(back.score, "cello"))
        cello.clear(2, 2).at(2, "Cs3.hd |")                              # the ground's D3 in bar 2, a C#3 instead
        pl = plan(back.score, back.snapshot)
        self.assertEqual((pl.adds, pl.removes), (1, 1))
        (add,) = [n for o in pl.ops if o["op"] == "addNotes" for n in o["notes"]]
        self.assertEqual((add["p"], add["d"], add["hint"]["on"], add["hint"]["len"], add["hint"]["spell"]), (49, 3 * PPQ, [3, 1], [3, 1], "C#3"))
        fake.apply(pl.ops)
        again = pull(fake.state(), "P")
        self.assertEqual((again.guessed, len(written(again.score, "cello"))), (0, before))
        self.assertEqual(written(again.score, "cello")[1][1], ((49, "C#"),))
        self.assertTrue(plan(again.score, again.snapshot).empty)


class Small(unittest.TestCase):
    def piece(self, fake, tmp):
        p = pull(fake.state(), "P")
        path = os.path.join(tmp, "p.py")
        write_pulled(p, path, "hdr")
        return p, path

    def edit(self, path, old, new):
        with open(path) as f:
            text = f.read()
        self.assertIn(old, text)
        with open(path, "w") as f:
            f.write(text.replace(old, new))

    def test_unedited_pull_pushes_nothing(self):
        fake = one_staff_project()
        p = pull(fake.state(), "P")
        self.assertEqual((p.hinted, p.guessed), (4, 0))
        self.assertFalse(has_errors(p.score), p.score.check())
        self.assertEqual([n.spell for n in p.score["flute"].events()[1][1].pitches], ["Db"])     # the spelling is the hint's, not the key's
        self.assertTrue(plan(p.score, p.snapshot).empty)

    def test_a_respelled_note_is_a_hint_only_update(self):
        fake = one_staff_project()
        with tempfile.TemporaryDirectory() as tmp:
            p, path = self.piece(fake, tmp)
            self.edit(path, "Db5.q", "Cs5.q")
            pl = plan(load_score(path), read_snapshot(snapshot_path(path)))
            note = next(n for n in fake.state()["tracks"][0]["clips"][0]["notes"] if n["pitch"] == 73)
            self.assertEqual(pl.ops, [{"op": "updateNotes", "notes": [{"id": note["id"], "hint": {
                "on": [1, 1], "len": [1, 1], "staff": 1, "voice": 1, "spell": "C#5"}}]}])
            fake.apply(pl.ops)
            note = next(n for n in fake.state()["tracks"][0]["clips"][0]["notes"] if n["pitch"] == 73)
            self.assertEqual(note["hint"]["spell"], "C#5")
            self.assertEqual(note["hint"]["at"], [PPQ, PPQ, 73])
            self.assertEqual(pull(fake.state(), "P").hinted, 4)

    def test_a_changed_length_sends_the_hint_with_it(self):
        fake = one_staff_project()
        with tempfile.TemporaryDirectory() as tmp:
            _, path = self.piece(fake, tmp)
            self.edit(path, "D5.h>", "D5.q> R.q")
            pl = plan(load_score(path), read_snapshot(snapshot_path(path)))
            (op,) = pl.ops
            (u,) = op["notes"]
            self.assertEqual((u["d"], u["hint"]["len"], u["hint"]["art"]), (PPQ, [1, 1], ">"))
            fake.apply(pl.ops)
            after = pull(fake.state(), "P")
            self.assertEqual((after.hinted, after.guessed), (4, 0))        # the hint is fresh again: not stale after the length change

    def test_a_stale_hint_is_guessed_and_the_rest_still_hinted(self):
        fake = one_staff_project()
        d5 = next(n for n in fake.state()["tracks"][0]["clips"][0]["notes"] if n["pitch"] == 74)
        fake.apply([{"op": "updateNotes", "notes": [{"id": d5["id"], "t": 2 * PPQ + 100, "d": PPQ}]}])      # moved in mobdaw: its hint is stale
        p = pull(fake.state(), "P")
        self.assertEqual((p.hinted, p.guessed), (3, 1))
        self.assertIn("1 of them have a stale hint", p.report[-1])
        self.assertFalse(has_errors(p.score), p.score.check())
        self.assertTrue(plan(p.score, p.snapshot).empty)
        # the untouched hinted notes keep their spelling
        self.assertEqual(written(p.score, "flute")[1][1], ((73, "Db"),))

    def test_two_staves_and_two_voices(self):
        fake = FakeMobdaw([{"id": "r", "bar": 1, "kind": "metered", "bpm": 120, "meter": "4/4"}], "C major")
        fake.apply([
            {"op": "addTrack", "name": "Piano", "clefs": ["treble", "bass"]},
            {"op": "addMidiClip", "trackId": "$0", "start": 0, "length": 4 * PPQ},
            {"op": "addNotes", "clipId": "$1", "notes": [
                {"p": 72, "t": 0, "d": 2 * PPQ, "hint": hint([0, 1], [2, 1])},
                {"p": 74, "t": 2 * PPQ, "d": 2 * PPQ, "hint": hint([2, 1], [2, 1])},
                {"p": 64, "t": 0, "d": 4 * PPQ, "hint": hint([0, 1], [4, 1], voice=2)},
                {"p": 48, "t": 0, "d": 4 * PPQ, "hint": hint([0, 1], [4, 1], staff=2)},
                {"p": 55, "t": 0, "d": 2 * PPQ},                      # no hint: guessed into the first voice
            ]},
        ])
        p = pull(fake.state(), "P")
        self.assertFalse(has_errors(p.score), p.score.check())
        self.assertEqual((p.hinted, p.guessed), (4, 1))
        parts = p.snapshot["tracks"][0]["parts"]
        self.assertEqual([p.score[n].staff for n in parts], ["piano", "piano", "piano", "piano staff 2"])    # voice 3: the guessed note, over voice 1
        self.assertEqual(p.snapshot["tracks"][0]["clefs"], ["treble", "bass"])
        self.assertEqual([p.score[n].clef for n in ("piano", "piano staff 2")], ["treble", "bass"])
        # voices and staves round-trip as hints
        hs = note_hints(p.score, parts)
        self.assertEqual({(m, h["staff"], h["voice"]) for (_, m), h in hs.items()}, {(72, 1, 1), (74, 1, 1), (64, 1, 2), (55, 1, 3), (48, 2, 1)})
        self.assertTrue(plan(p.score, p.snapshot).empty)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "p.py")
            write_pulled(p, path, "hdr")
            score = load_score(path)
            self.assertTrue(plan(score, read_snapshot(snapshot_path(path))).empty)
            # a new note on the bass staff goes out with staff 2 and no clef change
            score["piano staff 2"].at(2, "C3.w |")
            pl = plan(score, read_snapshot(snapshot_path(path)))
            added = [n for o in pl.ops if o["op"] == "addNotes" for n in o["notes"]]
            self.assertEqual([(n["p"], n["hint"]["staff"], n["hint"]["voice"]) for n in added], [(48, 2, 1)])
            self.assertFalse([o for o in pl.ops if o["op"] == "updateTrack"])

    def test_an_old_snapshot_without_hints_sends_none_for_untouched_notes(self):
        fake = one_staff_project()
        p = pull(fake.state(), "P")
        snap = p.snapshot
        for n in snap["notes"]:
            del n["hint"]
        self.assertTrue(plan(p.score, snap).empty)

    def test_rebaseline_after_a_push_diffs_against_it(self):
        fake = one_staff_project()
        with tempfile.TemporaryDirectory() as tmp:
            p, path = self.piece(fake, tmp)
            self.edit(path, "Db5.q", "Cs5.q")
            score, snap = load_score(path), read_snapshot(snapshot_path(path))
            pl = plan(score, snap)
            res = fake.apply(pl.ops)
            snap2 = rebaseline(score, snap, fake.state(), pl, res)
            self.assertTrue(plan(score, snap2).empty)

    def test_the_server_refuses_what_it_should(self):
        fake = one_staff_project()
        bad = {"op": "addNotes", "clipId": "c1", "notes": [{"p": 60, "t": 0, "d": 100, "hint": hint([0, 1], [1, 4], spell="D4")}]}
        clip = fake.state()["tracks"][0]["clips"][0]["id"]
        bad["clipId"] = clip
        with self.assertRaisesRegex(OpError, "does not name"):
            fake.apply([bad])


class ProposedMap(unittest.TestCase):
    """A map proposed from audio re-times markers and empty clips; the push moves them to keep their time."""

    def test_markers_and_empty_clips_keep_their_time(self):
        from badmidi.audio.propose import MapProposal
        from badmidi.bridge import Timeline
        fake = FakeMobdaw([{"id": "r", "bar": 1, "kind": "metered", "bpm": 120, "meter": "4/4"}], "C major")
        fake.apply([{"op": "addTrack", "name": "Keys"}, {"op": "addMidiClip", "trackId": "$0", "start": 4 * 4 * PPQ, "length": 4 * PPQ}])
        fake.markers = [{"id": "m1", "bar": 3, "label": "Verse"}, {"id": "m2", "bar": 1, "label": "Intro"}]
        old = Timeline(fake.state())
        regs = [{"id": "map1", "bar": 1, "kind": "free", "seconds": 1.0}, {"id": "map2", "bar": 2, "kind": "metered", "bpm": 60, "meter": "4/4"}]
        prop = MapProposal(regs, "steady", 60, "4/4", 1.0, 1.0, first_bar=2)
        pulled = pull(fake.state(), "P", None, None, prop)
        pl = plan(pulled.score, pulled.snapshot)
        self.assertEqual([o["op"] for o in pl.ops], ["addRegion", "addRegion", "updateMarker", "updateClip"])
        fake.apply(pl.ops)
        new = Timeline(fake.state())
        st = fake.state()
        self.assertEqual({m["id"]: m["bar"] for m in st["markers"]}, {"m1": 2, "m2": 1})     # 4 s: inside bar 2 of the new map
        clip = st["tracks"][0]["clips"][0]
        self.assertAlmostEqual(new.seconds_at(clip["startTick"]), old.seconds_at(4 * 4 * PPQ), delta=0.01)
        text = "\n".join(pl.summary)
        self.assertIn("moved with the map: marker 'Verse': bar 3 -> bar 2", text)
        self.assertIn("moved with the map: empty clip", text)
        self.assertNotIn("Intro", text)


if __name__ == "__main__":
    unittest.main()
