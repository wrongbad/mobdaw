"""badmidi.audio.timing on synthetic guitar (tests/synth.py): swing and triplets, a laid-back/rushing/dragging take against a click,
audio-only beats, meter and pickups, rubato, sparse chords. Nothing here may raise or refuse; a wrong reading must say it is unsure."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))     # synth.py, whichever way the tests are started

try:
    import numpy as np
    import synth
    from badmidi.audio import hear, timing
    from badmidi.audio.hear import SR, Grid, onsets
    from scipy.signal import resample_poly  # noqa: F401  (the audio extra)
except ImportError:  # the audio extra is optional
    np = None

SLOW = unittest.skipUnless(os.environ.get("SLOW"), "set SLOW=1")
BARS = ["Am", "F", "C", "G"] * 2
_CACHE: dict = {}


def take(bars=BARS, **kw):
    """(audio, clock) rendered once per test run."""
    clock = kw.pop("clock", None) or synth.Clock(87)
    key = repr((bars, clock, sorted(kw.items())))
    if key not in _CACHE:
        _CACHE[key] = (synth.render(bars, clock=clock, **kw), clock)
    return _CACHE[key]


def beat_hits(times, truth, tol=0.03):
    """Share of true beats that a tracked beat lies within `tol` of."""
    return float(np.mean([np.abs(times - b).min() < tol for b in truth]))


@unittest.skipIf(np is None, "needs numpy/scipy")
class TestBeats(unittest.TestCase):
    def check(self, n, bpm, **kw):
        x, clock = take(**kw)
        bt = timing.beats(timing.features(x))
        self.assertGreater(len(bt.times), n * 0.8)
        right = abs(bt.bpm / bpm - 1) <= 0.02
        if not right:                                                # half/double: named, and not claimed with confidence
            self.assertLess(bt.confidence, timing.UNSURE)
            self.assertTrue(any(abs(a.bpm / bpm - 1) <= 0.03 for a in bt.alternatives), (bt.bpm, bt.alternatives))
        else:
            self.assertGreaterEqual(beat_hits(bt.times, clock(np.arange(n))), 0.9)
        return bt, right

    def test_steady_44(self):
        bt, right = self.check(32, 87)
        self.assertTrue(right)
        self.assertGreater(bt.confidence, 0.7)
        self.assertLess(bt.variation, 0.02)
        self.assertTrue(bt.alternatives and bt.alternatives[0].ratio in (0.5, 2.0))       # the half/double reading is offered

    def test_rubato_4_percent(self):
        bt, right = self.check(32, 87, clock=synth.Clock(87, rubato=0.04, period=17))
        self.assertTrue(right)
        self.assertGreater(bt.variation, 0.02)                                             # it reports that the tempo moves
        self.assertLess(abs(bt.tempo_curve.max() / bt.tempo_curve.min() - 1.08), 0.05)

    def test_accelerando_3_percent(self):
        bt, right = self.check(32, 87, clock=synth.Clock(87, accel=0.03, beats=32))
        self.assertTrue(bt.tempo_curve[-1] > bt.tempo_curve[0])

    def test_waltz_and_other_tempi(self):
        for bpm in (120,):
            self.check(24, bpm, clock=synth.Clock(bpm), per_bar=3)

    def test_hint_forces_the_reading(self):
        x, clock = take()
        bt = timing.beats(timing.features(x), hint_bpm=174)
        self.assertAlmostEqual(bt.bpm / 174, 1, delta=0.05)
        self.assertGreater(beat_hits(bt.times, clock(np.arange(0, 32, 0.5)[:60]), 0.04), 0.8)

    def test_sparse_whole_notes_are_honest(self):
        x, clock = take(pattern="whole")
        bt = timing.beats(timing.features(x))                                 # one hit per bar: any beat divides the bar
        self.assertTrue(abs(bt.bpm / 87 - 1) <= 0.02 or bt.confidence < timing.UNSURE)
        self.assertLess(bt.confidence, timing.UNSURE)

    def test_never_raises_on_nothing(self):
        for x in (np.zeros(0, np.float32), np.zeros(22050, np.float32), np.zeros(5 * SR, np.float32),
                  np.random.default_rng(1).normal(size=3000).astype(np.float32),
                  0.05 * np.random.default_rng(2).normal(size=8 * SR).astype(np.float32)):
            t = timing.analyze(x)
            self.assertLess(t.beats.confidence, 0.6)
            self.assertIn(t.feel.kind, ("straight16", "triplet8", "triplet16", "swing8"))


@unittest.skipIf(np is None, "needs numpy/scipy")
class TestFeel(unittest.TestCase):
    def feel(self, **kw):
        x, clock = take(**kw)
        o = onsets(x)
        return timing.feel(o.times, clock(np.arange(32)), o.strengths), x, clock

    def test_straight(self):
        f, *_ = self.feel(pattern="eighths")
        self.assertEqual(f.kind, "straight16")
        self.assertGreater(f.confidence, 0.7)
        self.assertLess(abs(f.offset_s), 0.015)

    def test_swing_ratios(self):
        for r in (0.6, 0.7):
            f, *_ = self.feel(pattern="shuffle", swing=r)
            self.assertEqual(f.kind, "swing8", r)
            self.assertAlmostEqual(f.swing_ratio, r, delta=0.05)

    def test_triplet_swing_is_a_triplet_feel(self):
        f, *_ = self.feel(pattern="shuffle", swing=0.667)
        self.assertIn(f.kind, ("swing8", "triplet8"))
        self.assertAlmostEqual(f.swing_ratio, 0.667, delta=0.05)

    def test_triplet_8ths(self):
        f, *_ = self.feel(pattern="triplet", slot=1 / 3)
        self.assertEqual(f.kind, "triplet8")
        self.assertGreater(f.confidence, 0.5)

    def test_on_tracked_beats(self):
        x, clock = take(pattern="shuffle", swing=0.6)
        t = timing.analyze(x)
        self.assertEqual(t.feel.kind, "swing8")
        self.assertAlmostEqual(t.feel.swing_ratio, 0.6, delta=0.05)

    def test_sparse_onsets_default_straight(self):
        B = np.arange(0, 20) * 0.6
        f = timing.feel([0.01, 1.2, 2.4], B)
        self.assertEqual((f.kind, f.swing_ratio), ("straight16", 0.5))
        self.assertLess(f.confidence, 0.2)
        self.assertEqual(timing.feel([], B).kind, "straight16")
        self.assertEqual(timing.feel([1.0, 2.0], []).kind, "straight16")

    def test_laid_back_offset_against_the_beats(self):
        x, clock = take(clock=synth.Clock(87, lag=0.035))
        o = onsets(x)
        f = timing.feel(o.times, synth.Clock(87)(np.arange(32)), o.strengths)
        self.assertAlmostEqual(f.offset_s, 0.035, delta=0.015)
        self.assertEqual(f.kind, "straight16")

    def test_irregular_beats(self):
        x, clock = take(clock=synth.Clock(87, rubato=0.04, period=17), pattern="shuffle", swing=0.6)
        o = onsets(x)
        f = timing.feel(o.times, clock(np.arange(32)), o.strengths)
        self.assertEqual(f.kind, "swing8")
        self.assertAlmostEqual(f.swing_ratio, 0.6, delta=0.05)


@unittest.skipIf(np is None, "needs numpy/scipy")
class TestMeter(unittest.TestCase):
    def read(self, **kw):
        x, clock = take(**kw)
        t = timing.analyze(x)
        return t, clock

    def test_44(self):
        t, clock = self.read()
        m = t.meter
        self.assertEqual((m.signature, m.downbeat_index), ((4, 4), 0))
        self.assertGreater(m.confidence, timing.UNSURE)
        self.assertAlmostEqual(m.first_downbeat_s, 0.0, delta=0.05)

    def test_34(self):
        t, _ = self.read(per_bar=3)
        self.assertEqual((t.meter.signature, t.meter.downbeat_index), ((3, 4), 0))
        self.assertGreater(t.meter.confidence, timing.UNSURE)

    def test_68(self):
        t, clock = self.read(per_bar=2, pattern="six8", slot=1 / 3)
        self.assertEqual(t.feel.kind, "triplet8")
        self.assertEqual(t.meter.signature, (6, 8))
        self.assertEqual(t.meter.downbeat_index, 0)
        self.assertGreater(t.meter.confidence, 0.4)
        self.assertIsNotNone(t.meter.runner_up)                               # 6/8 vs 2/4 is named

    def test_pickup(self):
        x, clock = take(pickup=2)
        t = timing.analyze(x)
        m = t.meter
        self.assertEqual((m.signature, m.pickup_beats), ((4, 4), 2))
        self.assertAlmostEqual(m.first_downbeat_s, float(clock(2)), delta=0.05)

    def test_ambiguous_is_unsure_with_a_runner_up(self):
        x, _ = take(bars=["Am"] * 8, pattern="eighths")
        m = timing.analyze(x).meter                                          # one chord, equal strokes: no bar line to find
        self.assertLess(m.confidence, timing.UNSURE)
        self.assertIsNotNone(m.runner_up)

    def test_rubato_44(self):
        x, clock = take(clock=synth.Clock(87, rubato=0.04, period=17))
        t = timing.analyze(x)
        self.assertEqual((t.meter.signature, t.meter.downbeat_index), ((4, 4), 0))

    def test_chord_changes_given(self):
        x, clock = take()
        f = timing.features(x)
        bt = timing.beats(f)
        m = timing.meter(f, bt.times, chord_changes=clock(np.arange(0, 32, 4)))
        self.assertEqual((m.beats_per_bar, m.downbeat_index), (4, 0))

    def test_short_input(self):
        m = timing.meter(timing.features(np.zeros(SR, np.float32)), [0.0, 0.5, 1.0])
        self.assertEqual(m.confidence, 0.0)


REF = synth.Clock(100, offset=0.5)(np.arange(32)) if np is not None else None


@unittest.skipIf(np is None, "needs numpy/scipy")
class TestAlign(unittest.TestCase):
    """A take against a fixed click at 100 bpm."""
    TAKES = {"tight": synth.Clock(100, offset=0.5) if np is not None else None}

    def setUp(self):
        if np is not None and len(self.TAKES) == 1:
            self.TAKES.update({"laid back": synth.Clock(100, offset=0.5, lag=0.035), "early": synth.Clock(100, offset=0.5, lag=-0.04),
                               "rushing": synth.Clock(103, offset=0.5), "dragging": synth.Clock(100, offset=0.5, rubato=-0.03, period=20, beats=32)})

    def read(self, name):
        clock = self.TAKES[name]
        x, _ = take(clock=clock)
        o = onsets(x)
        bt = timing.beats(timing.features(x))
        al = timing.align(o.times, REF, bt.times, o.strengths)
        truth = clock(np.arange(32)) - REF
        self.assertEqual(len(al.offset_curve), 32)
        return x, o, al, truth, clock

    def test_kinds_and_curve(self):
        want = {"tight": "tight", "laid back": "feel", "early": "feel", "rushing": "drifting", "dragging": "drifting"}
        for name, kind in want.items():
            _, _, al, truth, _ = self.read(name)
            self.assertEqual(al.kind, kind, (name, al.kind, al.mean_offset, al.drift))
            self.assertLess(np.abs(al.offset_curve - truth).max(), 0.015, (name, np.abs(al.offset_curve - truth).max()))
            self.assertGreater(al.confidence, 0.5, name)
            self.assertTrue(np.allclose(al.played_beats, REF + al.offset_curve))

    def test_summary(self):
        _, _, al, truth, _ = self.read("laid back")
        self.assertAlmostEqual(al.mean_offset, 0.035, delta=0.01)
        self.assertEqual(al.method, "onsets")
        _, _, al, truth, _ = self.read("rushing")
        self.assertEqual(al.method, "beats")                                  # past a third of a beat: matched on the audio's beats
        self.assertLess(al.drift, -0.5)
        self.assertLess(al.offset_curve[-1], al.offset_curve[0])

    def test_chord_changes_map_to_project_beats(self):
        for name in self.TAKES:
            x, o, al, truth, clock = self.read(name)
            changes = clock(np.arange(0, 32, 4))
            heard = [o.times[int(np.abs(np.array(o.times) - c).argmin())] for c in changes]       # the onsets the detector found there
            for g, k in zip(timing.to_grid(heard, al), range(0, 32, 4)):
                self.assertEqual((g.beat, g.slot), (k, 0), (name, k, g))
                self.assertLess(abs(g.error_s), 0.04)

    def test_to_grid_uses_the_feel_slots(self):
        al = timing.align([], REF)                                             # nothing to read: zero offset, still maps
        self.assertEqual((al.kind, al.confidence), ("tight", 0.0))
        sw = timing.Feel("swing8", 0.667, 0.0, 1.0)
        t = [REF[2] + 0.667 * 0.6, REF[3] + 0.02, REF[4] - 0.02]
        got = [(g.beat, g.slot, str(g.position)) for g in timing.to_grid(t, al, sw)]
        self.assertEqual(got, [(2, 1, "5/2"), (3, 0, "3"), (4, 0, "4")])
        tr = timing.Feel("triplet8", 0.667, 0.0, 1.0)
        self.assertEqual([(g.beat, g.slot) for g in timing.to_grid([REF[1] + 0.6 / 3, REF[1] + 1.2 / 3], al, tr)], [(1, 1), (1, 2)])
        self.assertEqual(timing.to_grid([1.0], timing.align([], REF[:1])), [])

    def test_never_raises(self):
        for on in ([], [1.0], list(np.linspace(0, 10, 7)), list(np.random.default_rng(3).uniform(0, 20, 60))):
            al = timing.align(on, REF, REF + 0.1)
            self.assertIn(al.kind, ("tight", "feel", "drifting"))
            self.assertTrue(np.all(np.isfinite(al.offset_curve)))
        timing.align([1.0, 2.0, 3.0, 4.0, 5.0], REF[:2])


@unittest.skipIf(np is None, "needs numpy/scipy")
class TestHearOnPlayedBeats(unittest.TestCase):
    """hear_chords / hear_notes take explicit, irregular beats."""

    def test_chords_on_the_beats_as_played(self):
        x, clock = take(clock=synth.Clock(103, offset=0.5))
        o = onsets(x)
        al = timing.align(o.times, REF, timing.beats(timing.features(x)).times, o.strengths)
        ref_grid = Grid(list(map(float, REF)), [i % 4 == 0 for i in range(32)], float(REF[-1] + 0.6))
        want = [s for _, _, s in synth.expected_beats(BARS)]
        played = hear.hear_chords(x, SR, timing.played_grid(al, ref_grid))
        played_got = [c.symbol for c in played.chords for _ in range(c.start_beat, c.end_beat)]
        self.assertEqual(len(played_got), 32)
        self.assertGreaterEqual(np.mean([a == b for a, b in zip(played_got, want)]), 0.9)
        late = hear.hear_chords(x, SR, ref_grid)                              # on the click's beats the same take is read late
        got = [c.symbol for c in late.chords for _ in range(c.start_beat, c.end_beat)]
        self.assertLessEqual(np.mean([a == b for a, b in zip(got, want)]), np.mean([a == b for a, b in zip(played_got, want)]))

    def test_chords_on_the_audio_grid_with_rubato(self):
        x, clock = take(clock=synth.Clock(87, rubato=0.04, period=17))
        t = timing.analyze(x)
        g = timing.audio_grid(t.beats, t.meter)
        self.assertEqual(g.bars()[0][0], 0)
        h = hear.hear_chords(x, SR, g)
        syms = [c.symbol for c in h.chords if c.end_beat - c.start_beat >= 3]
        self.assertEqual(syms[:8], ["Am", "F", "C", "G", "Am", "F", "C", "G"])

    def test_notes_on_irregular_beats(self):
        import test_hear_notes as thn
        bpm = 100
        beat = 60 / bpm
        x = thn.sung(bpm)
        steady = hear.hear_notes(x, SR, Grid.regular(bpm, 4, 16))
        a = 0.01                                                              # the song speeds up by 1% over its length
        T = len(x) / SR
        src = np.linspace(0, T, 4000)
        out = src + a * src ** 2 / (2 * T)                                     # source time -> time in the warped take
        tau = np.arange(int(out[-1] * SR)) / SR
        s = np.interp(tau, out, src)
        y = np.interp(s * SR, np.arange(len(x)), x).astype(np.float32)
        edges = np.arange(17) * beat
        warped = Grid(list(np.interp(edges, src, out)[:-1]), [i % 4 == 0 for i in range(16)], float(np.interp(edges[-1], src, out)))
        h = hear.hear_notes(y, SR, warped)
        a_, b_ = [(n.pitch, n.start_beat) for n in steady.notes], [(n.pitch, n.start_beat) for n in h.notes]
        self.assertGreaterEqual(len(set(a_) & set(b_)) / len(a_), 0.85)


@unittest.skipIf(np is None, "needs numpy/scipy")
class TestGrids(unittest.TestCase):
    def test_audio_grid_bars(self):
        bt = timing.BeatTrack(np.arange(10) * 0.5 + 0.2, np.full(10, 120.0), 120.0, 1.0)
        mt = timing.Meter(3, "4", 1, 0.7, 1.0)
        g = timing.audio_grid(bt, mt)
        self.assertEqual(g.bar_starts, [False, True, False, False, True, False, False, True, False, False])
        self.assertEqual(g.position(5), 1)
        self.assertAlmostEqual(g.end, 5.2)

    def test_subdivisions_and_notation(self):
        B = [0.0, 1.0, 2.0]
        self.assertEqual(list(np.round(timing.subdivisions(B, timing.Feel("swing8", 0.6, 0, 1)), 3)), [0, 0.6, 1, 1.6, 2])
        self.assertEqual([str(f) for f in timing.notated(timing.Feel("triplet8", 0.667, 0, 1))], ["0", "1/3", "2/3"])
        self.assertEqual([str(f) for f in timing.notated(timing.Feel("swing8", 0.6, 0, 1))], ["0", "1/2"])


@unittest.skipIf(np is None, "needs numpy/scipy")
@SLOW
class TestSweep(unittest.TestCase):
    def test_tempi_patterns_rubato(self):
        bad = []
        for bpm in (70, 87, 100, 120, 140):
            for pat, pb in (("folk", 4), ("quarters", 4), ("ballad", 4), ("folk", 3)):
                for rub in (0.0, 0.04):
                    c = synth.Clock(bpm, rubato=rub, period=17)
                    x = synth.render(BARS, clock=c, per_bar=pb, pattern=pat if pb == 4 else None)
                    bt = timing.beats(timing.features(x))
                    ok = abs(bt.bpm / bpm - 1) <= 0.02 and beat_hits(bt.times, c(np.arange(8 * pb))) >= 0.9
                    if not ok and bt.confidence >= timing.UNSURE:
                        bad.append((bpm, pat, pb, rub, round(bt.bpm, 1), round(bt.confidence, 2)))
        self.assertEqual(bad, [])


@unittest.skipIf(np is None, "needs numpy/scipy")
class TestOverrideMeter(unittest.TestCase):
    """A person's `--meter` / `--downbeat-beat` replace the tracker's reading, and the proposed map follows them."""
    BEATS = 0.5 * np.arange(24)                                  # 120 bpm
    READ = timing.Meter(4, "4", 0, 0.0, 0.3, timing.Reading(4, "4", 2, 0.2))

    def propose(self, **kw):
        from badmidi.audio.propose import propose
        return propose(self.BEATS, timing.override_meter(self.READ, self.BEATS, **kw))

    def test_no_override_is_the_reading(self):
        self.assertIs(timing.override_meter(self.READ, self.BEATS), self.READ)

    def test_meter_changes_the_bars_of_the_map(self):
        p = self.propose(meter_text="3/4")
        self.assertEqual((p.meter, p.bars, p.regions[0]["meter"]), ("3/4", 8, "3/4"))
        self.assertEqual(self.propose().meter, "4/4")
        self.assertEqual(self.propose().bars, 6)
        m = timing.override_meter(self.READ, self.BEATS, "6/8")
        self.assertEqual((m.signature, m.confidence, m.runner_up), ((6, 8), 1.0, None))
        self.assertEqual(self.propose(meter_text="6/8").meter, "6/8")

    def test_downbeat_beat_is_that_many_beats_later(self):
        late = self.READ.runner_up.downbeat_index - self.READ.downbeat_index
        p, q = self.propose(), self.propose(downbeat_beat=late)
        self.assertEqual((p.pickup_s, q.pickup_s), (0.0, 1.0))               # the free bar before the first bar line: 2 beats of 0.5 s
        self.assertEqual((q.first_bar, q.downbeat_s), (2, 1.0))
        m = timing.override_meter(self.READ, self.BEATS, downbeat_beat=1)
        self.assertEqual((m.downbeat_index, m.first_downbeat_s, m.confidence), (1, 0.5, 0.3))

    def test_meter_keeps_the_pickup_within_the_new_bar(self):
        m = timing.override_meter(timing.Meter(4, "4", 3, 1.5, 0.9), self.BEATS, "3/4")
        self.assertEqual(m.downbeat_index, 0)

    def test_nonsense_is_refused(self):
        for kw in ({"meter_text": "5/4"}, {"meter_text": "waltz"}, {"downbeat_beat": -1}, {"downbeat_beat": 23}):
            with self.subTest(kw), self.assertRaises(ValueError):
                timing.override_meter(self.READ, self.BEATS, **kw)


if __name__ == "__main__":
    unittest.main()
