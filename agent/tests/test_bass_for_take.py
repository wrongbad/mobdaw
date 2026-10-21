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

    def test_reply_passes_on_the_timing_warnings(self):
        w = ["the take sits +35 ms behind the beats: move the clip 35 ms earlier. The bass is on the project's grid either way"]
        text = b.reply_text(b.Result("Am | F", "8 notes", 7, [], w))
        self.assertIn("timing: the take sits +35 ms behind the beats: move the clip 35 ms earlier", text)
        self.assertNotIn("tempo", text)
        self.assertIn("revert with history seq 7.", text, "in case A a revert undoes just the bass")

    def test_reply_says_the_project_tempo_was_set_and_that_a_revert_undoes_both(self):
        note = "I set the project tempo to 92 bpm 4/4 (pickup 0.4 s) to match the take (the project had no click or MIDI to follow)."
        text = b.reply_text(b.Result("G | Am | F", "12 notes", 9, [], ["tempo 92 bpm, or 184: tell me if it's double (confidence 0.30)"], note))
        self.assertIn("I set the project tempo to 92 bpm 4/4 (pickup 0.4 s) to match the take", text)
        self.assertIn("timing: tempo 92 bpm, or 184: tell me if it's double", text)
        self.assertIn("revert with history seq 9 (it undoes the tempo change and the bass together)", text)

    def test_map_note(self):
        from badmidi.audio.propose import MapProposal
        p = MapProposal([{"id": "map1", "bar": 1, "kind": "free", "seconds": 0.4}, {"id": "map2", "bar": 2, "kind": "metered", "bpm": 92.0, "meter": "4/4"}],
                        "steady", 92.0, "4/4", 0.4, 0.4)
        got = SimpleNamespace(proposal=p)
        self.assertEqual(b.map_note(got, True), "I set the project tempo to 92 bpm 4/4 (pickup 0.4 s) to match the take (the project had no click or MIDI to follow).")
        self.assertTrue(b.map_note(got, False).startswith("would set the project tempo to 92 bpm"))
        self.assertEqual(b.map_note(SimpleNamespace(proposal=None), True), "")

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
