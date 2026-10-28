"""Listening follows the timing of the take (AUDIO-PLAN, Phase 7), on synthetic guitar with a fake client.

Case A (the project has a click track or MIDI notes): a take that is tight, laid back, rushing or dragging is never refused; the
heard chords and the bass drafted from them sit on the project's grid at the beats the take played them as. Case B (audio only):
the audio defines the map, which goes in the same push batch as the bass. Nothing here may raise for the timing of a take."""
import hashlib
import os
import shutil
import sys
import tempfile
import unittest
from fractions import Fraction as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    import soundfile as sf
    import synth
    from badmidi.audio import listen as L
    from test_listen import CLICK, FakeClient, PPQ, state_for
    from test_timing import BARS, take
except ImportError:                                       # the audio extra is optional
    np = None

from badmidi import HeardTiming, bass
from badmidi.bridge import BridgeError, Timeline, plan, pull, read_snapshot, snapshot_path, write_pulled
from badmidi.cli import load_score
from badmidi.views import has_errors

SYMS = ["Am", "F", "C", "G"] * 2
MIDI_TRACK = {"id": "k1", "name": "Keys", "kind": "midi", "devices": [], "clips": [
    {"id": "c1", "kind": "midi", "start": "1.1.0", "startTick": 0, "lengthTicks": 4 * PPQ, "length": "1 bar", "end": "2.1.0",
     "notes": [{"id": "n1", "p": "C4", "pitch": 60, "t": 0, "d": PPQ, "v": 100}]}]}


TRIAD = {"Am": {9, 0, 4}, "F": {5, 9, 0}, "C": {0, 4, 7}, "G": {7, 11, 2}}          # a bass note may be an inversion's


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class Rig:
    """Renders a take (once per run), writes it to disk and listens to it as a project's Guitar track."""
    tmp = None

    @classmethod
    def start(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cache = os.path.join(cls.tmp, "cache")

    @classmethod
    def stop(cls):
        shutil.rmtree(cls.tmp)

    @classmethod
    def listen(cls, clock, bars=BARS, click=True, bpm=100, tracks=(), name="t", **kw):
        keep = {k: kw.pop(k) for k in ("case", "keep_map", "mode", "meter", "downbeat_beat") if k in kw}
        x, _ = take(bars, clock=clock, **kw)
        wav = os.path.join(cls.tmp, f"{abs(hash(repr((bars, clock, sorted(kw.items()))))):x}.wav")
        sf.write(wav, x, synth.SR, subtype="PCM_16")
        h = sha(wav)
        st = state_for(h, len(x) / synth.SR - 0.5, bpm=bpm, click=click, extra_tracks=list(tracks))
        res = L.listen(FakeClient({h: wav}), "pid", st, "Guitar", cache_dir=cls.cache, **keep)
        return res, st


def bass_notes(res, st, style="roots"):
    """The bass drafted from the heard part, in the Score pulled with the proposal: (pulled, [(onset in quarters, midi)])."""
    pulled = pull(st, "P", None, [res.part], res.proposal)
    score = pulled.score
    score.part("bass guitar").at(res.part.bar, bass.line(res.part, style=style, key=score.key))
    assert not has_errors(score), score.check()
    return pulled, [(on, n.pitch.midi) for on, n in score["bass guitar"].events() if not n.is_rest]


@unittest.skipIf(np is None, "numpy/scipy/soundfile not installed")
class TestTheCase(unittest.TestCase):
    def test_a_click_track_or_midi_notes_is_a_timing_reference(self):
        ref = L.timing_reference
        base = state_for("h", 4, click=False)
        self.assertIsNone(ref(base))
        self.assertEqual(ref(state_for("h", 4)), "a click track")
        self.assertEqual(ref(state_for("h", 4, click=False, extra_tracks=[{**CLICK, "muted": True}])), "a click track", "muted or not: it exists")
        self.assertEqual(ref(state_for("h", 4, click=False, extra_tracks=[MIDI_TRACK])), "MIDI notes on 'Keys'")
        empty = {**MIDI_TRACK, "clips": [{**MIDI_TRACK["clips"][0], "notes": []}]}
        self.assertIsNone(ref(state_for("h", 4, click=False, extra_tracks=[empty])), "an empty clip is no timing reference")


@unittest.skipIf(np is None, "numpy/scipy/soundfile not installed")
class TestCaseA(unittest.TestCase):
    """A take against a click at 100 bpm: followed in every shape, the bass on the project's grid."""
    TAKES = {}

    @classmethod
    def setUpClass(cls):
        Rig.start()
        cls.TAKES = {"tight": synth.Clock(100), "laid back": synth.Clock(100, lag=0.035), "rushing": synth.Clock(103),
                     "dragging": synth.Clock(100, rubato=-0.03, period=20, beats=32)}
        cls.res = {k: Rig.listen(c) for k, c in cls.TAKES.items()}

    tearDownClass = classmethod(lambda cls: Rig.stop())

    def test_never_refused_and_the_changes_are_on_the_beats_they_were_played_as(self):
        tl = Timeline(self.res["tight"][1])
        for name, (res, st) in self.res.items():
            with self.subTest(name):
                self.assertEqual(res.timing.case, "a")
                self.assertIsNone(res.proposal, "case A never touches the map")
                self.assertEqual([c.symbol for c in res.part.chords], SYMS)
                self.assertEqual([c.start for c in res.part.chords], [4 * i for i in range(8)], "one change per bar, on the bar line")
                _, notes = bass_notes(res, st)
                self.assertTrue(all((on * PPQ).denominator == 1 and on * PPQ % PPQ == 0 for on, _ in notes), "every bass note is on a project beat")
                changes = [(on, m) for on, m in notes if on % 4 == 0 and on < 32]
                self.assertEqual(len(changes), 8)
                for (on, m), sym in zip(changes, SYMS):
                    self.assertIn(m % 12, TRIAD[sym], (on, m, sym))
                for on, _ in changes:                                         # the project's seconds, not the take's
                    self.assertAlmostEqual(tl.seconds_at(on * PPQ), on * 0.6, places=6)

    def test_tight(self):
        t = self.res["tight"][0].timing
        self.assertEqual((t.alignment, t.feel), ("tight", "straight16"))
        self.assertNotIn("move the clip", " ".join(t.warnings))
        self.assertIn("on the grid", self.res["tight"][0].chart().splitlines()[0])

    def test_laid_back_reports_the_offset_and_how_to_fix_it(self):
        res = self.res["laid back"][0]
        t = res.timing
        self.assertEqual(t.alignment, "feel")
        self.assertAlmostEqual(t.offset_ms, 35, delta=10)
        text = " ".join(t.warnings)
        self.assertRegex(text, r"the take sits \+3\d ms behind the beats: move the clip 3\d ms earlier")
        self.assertIn("does not copy the offset", text)
        self.assertRegex(res.chart(), r"(?m)^warning: the take sits \+3\d ms behind")

    def test_rushing_says_where_it_gets_to(self):
        t = self.res["rushing"][0].timing
        self.assertEqual(t.alignment, "drifting")
        self.assertLess(t.drift_ms, -300)
        text = " ".join(t.warnings)
        self.assertRegex(text, r"rushes to -\d+ ms by bar 8")
        self.assertRegex(text, r"about 3% faster than the project's 100 bpm")
        self.assertRegex(text, r"set the project's tempo to about 10[23] bpm")
        self.assertIn("stays on the click", text)

    def test_dragging_then_catching_up_is_a_wander(self):
        t = self.res["dragging"][0].timing
        self.assertEqual(t.alignment, "drifting")
        self.assertRegex(" ".join(t.warnings), r"(wanders between -?\d+ and \+?\d+ ms|drags to \+\d+ ms)")

    def test_the_timing_is_in_the_piece(self):
        res, st = self.res["laid back"]
        pulled = pull(st, "P", None, [res.part])
        path = os.path.join(Rig.tmp, "a.py")
        write_pulled(pulled, path, "test")
        import runpy
        heard = runpy.run_path(path, run_name="__badmidi__")["HEARD"]["guitar"]
        self.assertEqual(heard.timing, res.timing)
        self.assertEqual(heard["timing"].case, "a")
        self.assertIn("(case A)", "\n".join(pulled.report))
        self.assertTrue(plan(load_score(path), read_snapshot(snapshot_path(path))).empty)

    def test_forced_case_b_on_a_project_with_a_click_proposes_a_map(self):
        res, _ = Rig.listen(synth.Clock(87), case="b")
        self.assertEqual(res.timing.case, "b")
        self.assertIsNotNone(res.proposal)
        self.assertIn("--case b", res.timing.reference)


@unittest.skipIf(np is None, "numpy/scipy/soundfile not installed")
class TestFeel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Rig.start()

    tearDownClass = classmethod(lambda cls: Rig.stop())

    def test_a_swung_take_gets_a_swung_bass(self):
        res, st = Rig.listen(synth.Clock(100), pattern="shuffle", swing=0.62)
        t = res.timing
        self.assertEqual(t.feel, "swing8")
        self.assertAlmostEqual(t.swing, 0.62, delta=0.05)
        self.assertIn("swing", res.chart().splitlines()[1])
        self.assertEqual(len(res.part.rhythm.bars[F(0)]), 8, "the rhythm is on the 8ths of the swing feel (2 slots a beat)")
        _, notes = bass_notes(res, st, "pulse")
        offbeats = [on % 1 for on, _ in notes if on % 1]
        self.assertTrue(offbeats)
        sw = F(round(t.swing * 48), 48)
        self.assertTrue(all(o == sw for o in offbeats), set(offbeats))
        self.assertNotEqual(sw, F(1, 2))
        self.assertTrue(all((o * PPQ).denominator == 1 for o in offbeats), "whole ticks")

    def test_a_triplet_take_gets_triplet_8ths(self):
        res, st = Rig.listen(synth.Clock(100), pattern=[(i, "D", 1.0 if i % 3 == 0 else 0.8) for i in range(12)], slot=1 / 3)
        self.assertEqual(res.timing.feel, "triplet8")
        self.assertEqual(len(res.part.rhythm.bars[F(0)]), 12)
        _, notes = bass_notes(res, st, "pulse")
        self.assertEqual({on % 1 for on, _ in notes}, {F(0), F(1, 3), F(2, 3)})


@unittest.skipIf(np is None, "numpy/scipy/soundfile not installed")
class TestCaseB(unittest.TestCase):
    """No click, no MIDI: the audio defines the time map, and the bass is on it."""

    @classmethod
    def setUpClass(cls):
        Rig.start()

    tearDownClass = classmethod(lambda cls: Rig.stop())

    def check_bass(self, res, st, clock, expect, first_beat, per_bar=4, tol=0.02, share=1.0):
        """The bass's chord-change notes land within `tol` seconds of where the take changed chords, under the proposed map.
        `expect`: the chord symbols in order (None: the chords are not the point, only the timing)."""
        if expect:
            self.assertEqual([c.symbol for c in res.part.chords if not c.silent], expect)
        pulled, notes = bass_notes(res, st)
        tl = Timeline({"meta": {"ppq": PPQ}, "regions": res.proposal.regions})
        pickup = first_beat
        n = len(expect or SYMS) - (1 if pickup and expect else 0)
        truth = ([float(clock(0))] if pickup else []) + [float(clock(pickup + per_bar * i)) for i in range(n)]
        starts = [c.start for c in res.part.chords if not c.silent]
        at = np.array([tl.seconds_at(s * PPQ) for s in starts])
        err = np.array([np.abs(at - t).min() for t in truth])                        # every change of the take has a bass note near it
        self.assertGreaterEqual(np.mean(err < tol), share, np.round(err * 1000, 1))
        ons = {on for on, _ in notes}
        self.assertTrue(set(starts) <= ons, "a bass note on every chord change")
        return pulled, tl

    def test_87_bpm_with_a_pickup(self):
        clock = synth.Clock(87)
        res, st = Rig.listen(clock, click=False, pickup=2)
        t = res.timing
        self.assertEqual(t.case, "b")
        p = res.proposal
        self.assertEqual(p.kind, "steady")
        self.assertAlmostEqual(p.bpm / 87, 1, delta=0.02)
        self.assertEqual(p.meter, "4/4")
        free, bar2 = p.regions
        self.assertEqual((free["kind"], free["bar"], bar2["bar"]), ("free", 1, 2))
        self.assertAlmostEqual(free["seconds"], float(clock(2)), delta=0.03)
        self.assertEqual((t.pickup_s, t.meter), (free["seconds"], "4/4"))
        self.assertEqual(t.map, [{k: v for k, v in r.items() if k != "id"} for r in p.regions])
        self.assertEqual(t.warnings, [])
        pulled, _ = self.check_bass(res, st, clock, ["G"] + SYMS, 2)
        chart = res.chart()
        self.assertIn("map: bar 1: free 1.", chart)
        self.assertRegex(chart, r"(?m)^timing: audio only .*87\.\d bpm 4/4, first downbeat at 1\.\d+ s \(a pickup of 1\.\d+ s\)")
        # the push: the map ops first, the bass after, one batch
        pl = plan(pulled.score, pulled.snapshot, sound="bass")
        ops = [o["op"] for o in pl.ops]
        self.assertEqual(ops[:2], ["addRegion", "addRegion"])
        self.assertEqual(pl.ops[0], {"op": "addRegion", "bar": 1, "free": free["seconds"]})
        self.assertEqual(pl.ops[1], {"op": "addRegion", "bar": 2, "bpm": bar2["bpm"], "meter": "4/4"})
        self.assertEqual(ops[2:], ["addTrack", "addDevice", "addMidiClip", "addNotes"])
        self.assertEqual(pl.ops[4]["trackId"], "$2", "the $ references are the batch's own indexes, after the map ops")
        self.assertEqual(pl.new_parts, {2: ["bass guitar"]})
        self.assertIn("time map: bar 1: free", "\n".join(pl.summary))

    def test_the_pickup_bar_has_a_rhythm_row_and_whole_tick_chords(self):
        clock = synth.Clock(87)
        res, st = Rig.listen(clock, click=False, pickup=2)
        r = res.part.rhythm
        free = res.proposal.regions[0]["seconds"] * 2                                  # quarters: a free bar borrows 120 bpm
        self.assertEqual(len(r.bars[F(0)]), round(free / float(r.slot)), "the pickup is on the slot grid, like the other bars")
        self.assertTrue(any(r.bars[F(0)]))
        bar2 = sorted(r.bars)[1]
        self.assertTrue(all((c.start * PPQ).denominator == 1 for c in res.part.chords if c.start < bar2))
        a, b, slot = F(0), F(1379, 500), F(1, 4)                                       # a chord that changes mid-way snaps to a slot
        chords = [bass.HeardChord(a, F(1, 3), "G", 7, 7, "M"), bass.HeardChord(F(1, 3), b, "C", 0, 0, "M")]
        rows, got = L._free_bar([[1.0, 0, 0.5, 0, 0, 0, 0.7, 0]], chords, a, b, slot)
        self.assertEqual([(c.start, c.end) for c in got], [(a, F(1, 4)), (F(1, 4), b)])
        self.assertEqual(len(rows[0]), 11)
        self.assertEqual(rows[0][0], 1.0)

    def test_the_piece_must_match_exactly_the_proposed_map(self):
        clock = synth.Clock(87)
        res, st = Rig.listen(clock, click=False, pickup=2)
        pulled = pull(st, "P", None, [res.part], res.proposal)
        path = os.path.join(Rig.tmp, "b.py")
        write_pulled(pulled, path, "test")
        snap = read_snapshot(snapshot_path(path))
        self.assertEqual(snap["regions"], res.proposal.regions)
        self.assertEqual(len(snap["map_ops"]), 2)
        score = load_score(path)
        self.assertFalse(has_errors(score), score.check())
        pl = plan(score, snap)
        self.assertEqual([o["op"] for o in pl.ops], ["addRegion", "addRegion"], "a map-only push is fine")
        score.tempo_mark(4, bpm=120)                                           # any other change to the map is refused
        with self.assertRaisesRegex(BridgeError, "its meter or tempo map differs"):
            plan(score, snap)
        score = load_score(path)
        score.meter_change(5, "3/4")
        with self.assertRaisesRegex(BridgeError, "its meter or tempo map differs"):
            plan(score, snap)

    def test_a_revert_has_one_entry_to_undo(self):
        res, st = Rig.listen(synth.Clock(87), click=False)
        pulled, _ = bass_notes(res, st)
        pl = plan(pulled.score, pulled.snapshot, sound="bass")
        self.assertEqual(pl.ops[0]["op"], "addRegion")
        self.assertEqual(sum(o["op"] == "addRegion" for o in pl.ops), 1, "no pickup: bar 1 only")
        self.assertNotIn("free", pl.ops[0])

    def test_3_4(self):
        clock = synth.Clock(100)
        res, st = Rig.listen(clock, click=False, per_bar=3, bpm=120)
        self.assertEqual(res.proposal.meter, "3/4")
        self.assertAlmostEqual(res.proposal.bpm / 100, 1, delta=0.02)
        self.assertEqual(res.timing.warnings, [])
        self.check_bass(res, st, clock, SYMS, 0, per_bar=3)

    def test_rubato_4_percent_follows_the_tempo(self):
        clock = synth.Clock(87, rubato=0.04, period=17)
        res, st = Rig.listen(clock, click=False)
        p = res.proposal
        self.assertNotEqual(p.kind, "steady")
        self.assertGreater(len(p.metered()), 2)
        self.assertTrue(any("rubato" in w for w in res.timing.warnings), res.timing.warnings)
        pulled, tl = self.check_bass(res, st, clock, SYMS, 0, tol=0.025)
        pl = plan(pulled.score, pulled.snapshot, sound="bass")
        self.assertEqual(sum(o["op"] == "addRegion" for o in pl.ops), len(p.regions))

    def test_sparse_whole_notes_warn_about_the_tempo(self):
        clock = synth.Clock(87)
        res, st = Rig.listen(clock, click=False, pattern="whole")
        self.assertTrue(any(w.startswith("tempo ") and " or " in w for w in res.timing.warnings), res.timing.warnings)
        self.assertRegex(res.chart(), r"(?m)^warning: tempo \d+ bpm, or \d+")
        self.check_bass(res, st, clock, None, 0, tol=0.025, share=0.6)         # one strum a bar: honest about it, not exact

    def test_meter_and_downbeat_given_override_the_reading_and_the_warning(self):
        clock = synth.Clock(87)
        base, _ = Rig.listen(clock, click=False)
        self.assertEqual((base.proposal.meter, base.proposal.pickup_s), ("4/4", 0.0))
        res, _ = Rig.listen(clock, click=False, meter="3/4", downbeat_beat=1)
        p = res.proposal
        self.assertEqual(p.meter, "3/4")
        self.assertGreater(p.pickup_s, 0.5 * 60 / 87, "one tracked beat before the first bar line is a free bar")
        self.assertTrue(any("as given (--meter)" in w for w in res.timing.warnings), res.timing.warnings)
        self.assertTrue(any("1 beat later than tracked" in w for w in res.timing.warnings), res.timing.warnings)
        self.assertFalse(any("could be" in w or "is a guess" in w for w in res.timing.warnings), res.timing.warnings)
        with self.assertRaises(BridgeError):
            Rig.listen(clock, click=False, meter="7/4")

    def test_keep_map_places_the_bass_on_the_old_map_and_says_so(self):
        clock = synth.Clock(87)
        res, st = Rig.listen(clock, click=False, pickup=2, keep_map=True)
        self.assertIsNone(res.proposal)
        self.assertTrue(res.timing.keep_map)
        self.assertTrue(res.timing.map, "the map it would have proposed is still reported")
        self.assertTrue(any("--keep-map" in w for w in res.warnings))
        pulled, notes = bass_notes(res, st)
        self.assertEqual(pulled.snapshot["map_ops"], [])
        self.assertEqual(pulled.snapshot["regions"], st["regions"])
        pl = plan(pulled.score, pulled.snapshot, sound="bass")
        self.assertEqual([o["op"] for o in pl.ops], ["addTrack", "addDevice", "addMidiClip", "addNotes"])
        old = Timeline(st)
        starts = [c.start for c in res.part.chords if not c.silent]
        for s, truth in zip(starts, [float(clock(0))] + [float(clock(2 + 4 * i)) for i in range(8)]):
            self.assertAlmostEqual(old.seconds_at(s * PPQ), truth, delta=0.02, msg="in the old map the notes sit where the audio was played")
            self.assertEqual((s * PPQ).denominator, 1, "whole ticks")

    def test_case_a_forced_on_an_audio_only_project_uses_its_map(self):
        res, _ = Rig.listen(synth.Clock(100), click=False, case="a")
        self.assertEqual(res.timing.case, "a")
        self.assertIsNone(res.proposal)

    def test_the_example_agent_sets_the_map_and_pushes_the_bass_in_one_batch(self):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "examples"))
        import bass_for_take as b
        x, _ = take(BARS, clock=synth.Clock(87), pickup=2)
        wav = os.path.join(Rig.tmp, "ex.wav")
        sf.write(wav, x, synth.SR, subtype="PCM_16")
        h = sha(wav)
        st = state_for(h, len(x) / synth.SR - 0.5, bpm=120, click=False)

        class Agent(FakeClient):
            sent = []
            _state = st

            def ops(self, pid, ops, label):
                self.sent.append((label, ops))
                return {"seq": 11, "ids": [None] * len(ops)}

        c = Agent({h: wav})
        dry = b.make_bass(c, "pid", "Guitar", "roots", apply=False, cache_dir=Rig.cache)
        self.assertEqual(c.sent, [])
        self.assertTrue(dry.map_note.startswith("would set the project tempo to 87 bpm 4/4 (pickup 1.4 s)"), dry.map_note)
        r = b.make_bass(c, "pid", "Guitar", "roots", cache_dir=Rig.cache)
        (label, ops), = c.sent
        self.assertEqual(label, "bass for Guitar")
        self.assertEqual([o["op"] for o in ops], ["addRegion", "addRegion", "addTrack", "addDevice", "addMidiClip", "addNotes"], "one batch: map, then bass")
        self.assertTrue(r.map_note.startswith("I set the project tempo to 87 bpm 4/4 (pickup 1.4 s)"))
        text = b.reply_text(r)
        self.assertIn("heard: G | Am | F | C | G | Am | F | C | G", text)
        self.assertIn("(it undoes the tempo change and the bass together)", text)
        kept = b.make_bass(c, "pid", "Guitar", "roots", cache_dir=Rig.cache, keep_map=True)
        self.assertEqual(kept.map_note, "")
        self.assertEqual([o["op"] for o in c.sent[1][1]][:1], ["addTrack"])
        self.assertTrue(any("--keep-map" in w for w in kept.warnings))

    def test_no_beat_in_the_audio_falls_back_to_the_old_map(self):
        x = np.zeros(4 * synth.SR, np.float32)
        wav = os.path.join(Rig.tmp, "silence.wav")
        sf.write(wav, x, synth.SR, subtype="PCM_16")
        h = sha(wav)
        st = state_for(h, 4.0, click=False)
        res = L.listen(FakeClient({h: wav}), "pid", st, "Guitar", cache_dir=Rig.cache)
        self.assertIsNone(res.proposal)
        self.assertIn("no steady beat", res.timing.warnings[0])


if __name__ == "__main__":
    unittest.main()
