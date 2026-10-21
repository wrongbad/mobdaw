import os
import sys
import unittest
from fractions import Fraction as F
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "examples"))
import bass_for_take as b  # noqa: E402


class RequestTest(unittest.TestCase):
    def test_parse(self):
        p = b.parse_request
        self.assertEqual(p("@k(api) bass for Guitar", "X", "roots"), ("Guitar", "roots", None))
        self.assertEqual(p("@k(api) make a bass for Guitar, bars 1-8, walk", "X", "roots"), ("Guitar", "walk", (1, 8)))
        self.assertEqual(p("bass for Electric Guitar bar 3.", "X", "pulse"), ("Electric Guitar", "pulse", (3, 3)))
        self.assertIsNone(p("@k(api) how are you", "X", "roots"))

    def test_reply(self):
        text = b.reply_text(b.Result("Am | F", "8 notes", 7, ["bar 2: F or F5"]))
        self.assertIn("heard: Am | F", text)
        self.assertIn("revert with history seq 7", text)
        self.assertIn("bar 2: F or F5", text)

    def test_chart_and_asks_use_the_hear_rule(self):
        """One rule (`HeardChord.is_unsure`, the chart's `<- unsure`): a clear chord with a faint rival is not asked about, a
        chord with a rival over half as likely is, and so is one under 0.5 with any rival."""
        from badmidi.heard import HeardChord, HeardPart
        chords = [HeardChord(F(0), F(4), "Am", 9, 9, "min", 0.95, "", 0.0),
                  HeardChord(F(4), F(8), "F", 5, 5, "maj", 0.80, "F5", 0.12),
                  HeardChord(F(8), F(12), "C", 0, 0, "maj", 0.60, "Am", 0.40),
                  HeardChord(F(12), F(16), "G", 7, 7, "maj", 0.46, "Em", 0.30)]
        got = SimpleNamespace(part=HeardPart("Guitar", "guitar (heard)", "C major", 0, "on the grid", 1, chords, None), bars=(1, 4))
        self.assertEqual(b.chart_line(got), "Am | F | C? | G?")


if __name__ == "__main__":
    unittest.main()
