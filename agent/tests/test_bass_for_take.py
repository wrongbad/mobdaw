import os
import sys
import unittest

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


if __name__ == "__main__":
    unittest.main()
