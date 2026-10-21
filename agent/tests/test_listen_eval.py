"""tools/listen-eval.py: label parsing, scoring against a label, and a run over a small folder of synthetic takes."""
import importlib.util
import os
import sys
import tempfile
import unittest
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import numpy as np
    import soundfile as sf
    import synth
    spec = importlib.util.spec_from_file_location("listen_eval", os.path.join(HERE, "..", "..", "tools", "listen-eval.py"))
    le = importlib.util.module_from_spec(spec)
    sys.modules["listen_eval"] = le                  # dataclasses look their module up
    spec.loader.exec_module(le)
except ImportError:  # the audio extra is optional
    np = None

CHORDS = """# a comment
bpm: 100
meter: 3/4
offset: 0.5
key: A minor / C major
tuning: 12

Am        # one chord
F | G     # two share the bar
N
"""


@unittest.skipIf(np is None, "numpy/scipy/soundfile not installed")
class TestListenEval(unittest.TestCase):
    def write(self, d, name, text):
        with open(os.path.join(d, name), "w") as f:
            f.write(text)
        return os.path.join(d, name)

    def test_chord_symbols(self):
        for sym, want in (("Am", (9, "min")), ("F#m7", (6, "m7")), ("Bbmaj7", (10, "maj7")), ("E5", (4, "5")), ("D/F#", (2, "maj")),
                          ("Dsus4", (2, "sus4")), ("G7", (7, "7")), ("Cadd9", (0, "maj")), ("Bm7b5", (11, "dim")), ("N", (0, "N"))):
            self.assertEqual(le.chord_of(sym), want, sym)
        with self.assertRaises(le.LabelError):
            le.chord_of("H7")

    def test_label_and_truth_beats(self):
        with tempfile.TemporaryDirectory() as d:
            lab = le.read_label(self.write(d, "t.chords.txt", CHORDS))
        self.assertEqual((lab.bpm, lab.num, lab.den, lab.offset, lab.tuning), (100, 3, 4, 0.5, 12))
        self.assertEqual(lab.keys, [(9, "minor"), (0, "major")])
        self.assertEqual([s for _, _, s in le.truth_beats(lab)], ["Am", "Am", "Am", "F", "F", "G", "N", "N", "N"])
        g = lab.grid()
        self.assertEqual(len(g.beats), 9)
        self.assertAlmostEqual(g.beats[3] - g.beats[0], 3 * 0.6)
        self.assertEqual(g.bar_starts[:4], [True, False, False, True])

    def test_compound_meter_counts_dotted_quarters(self):
        with tempfile.TemporaryDirectory() as d:
            lab = le.read_label(self.write(d, "t.chords.txt", "bpm: 90\nmeter: 6/8\nAm\nG\n"))
        self.assertEqual((lab.per_bar, lab.beat_q), (2, Fraction(3, 2)))

    def test_bad_label_says_where(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(le.LabelError, "line 3.*cannot read the chord symbol"):
                le.read_label(self.write(d, "t.chords.txt", "bpm: 100\nmeter: 4/4\nAm Hm\n"))

    def test_notes_truth(self):
        with tempfile.TemporaryDirectory() as d:
            lab = le.read_label(self.write(d, "t.notes.txt", "bpm: 90\nmeter: 4/4\nA3.q C4.e R.e G4.h\nE4.w\n"))
        self.assertEqual(le.truth_notes(lab), [(Fraction(0), Fraction(1), 57), (Fraction(1), Fraction(3, 2), 60),
                                               (Fraction(2), Fraction(4), 67), (Fraction(4), Fraction(8), 64)])

    def test_a_run_over_a_folder(self):
        bars = ["Am", "F", "C", "G"]
        with tempfile.TemporaryDirectory() as d:
            sf.write(os.path.join(d, "good.wav"), synth.render(bars, 100, seed=3), synth.SR)
            self.write(d, "good.chords.txt", "bpm: 100\nmeter: 4/4\nkey: A minor\ntuning: 0\n" + "\n".join(bars) + "\n")
            self.write(d, "wrong.chords.txt", "bpm: 100\nmeter: 4/4\nkey: C major\ntuning: 0\nAm\nF\nC\nD\n")      # same audio, the last bar mislabelled
            sf.write(os.path.join(d, "wrong.wav"), synth.render(bars, 100, seed=3), synth.SR)
            self.write(d, "orphan.chords.txt", "bpm: 100\nAm\n")                                                    # no audio: skipped
            out = os.path.join(d, "out")
            self.assertEqual(le.main([d, "--label", "mini", "--out", out]), 0)
            with open(os.path.join(out, "report.md")) as f:
                text = f.read()
            with open(os.path.join(out, "bars.csv")) as f:
                csv_lines = f.read().splitlines()
        self.assertIn("2 takes, 32 beats", text)
        self.assertIn("root right on **88%**", text)                      # 28 of 32
        self.assertIn("D -> G x4", text)
        self.assertIn("wrong bar 4: label `D`, heard `G`", text)
        self.assertIn("| good | 4 | 100 4/4 | 100% | 100% |", text)
        self.assertIn("key right on **1/2**", text)
        self.assertEqual(len(csv_lines), 1 + 8)
        self.assertTrue(csv_lines[0].startswith("take,bar,label,heard"))


if __name__ == "__main__":
    unittest.main()
