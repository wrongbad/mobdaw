"""to_source rebuilds a score as readable source; Part.clear replaces a passage."""
import glob
from fractions import Fraction
import os
import tempfile
import unittest

from badmidi import *
from badmidi.cli import load_score
from badmidi.core import spelling
from badmidi.source import to_source, write_source
from badmidi.views import has_errors

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES = sorted(glob.glob(os.path.join(ROOT, "examples", "*.py")))


def sounding(p):
    return [(t, tuple(map(str, n.pitches)), n.dur, n.art) for t, n in p.events() if not n.is_rest]


def rebuild(score, **kw):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "piece.py")
        write_source(score, path, **kw)
        return load_score(path)


def attrs(p):
    return (p.name, p.instrument, p.program, p.range, p.group, p.staff, p.clef, p.brace,
            p.balance, tuple(p.couplers), p.channel, p.pan,
            p.registrations, [(d.start, d.end, d.ahead, d.text) for d in p.drifts])


def tempo(score):
    return [(m.start, m.text, m.bpm, m.end) for m in score.tempo_marks]


class RoundTrip(unittest.TestCase):
    def same(self, a, b):
        self.assertEqual(a.title, b.title)
        self.assertEqual(a.composer, b.composer)
        self.assertEqual(a.key.name, b.key.name)
        self.assertEqual(a.tempo, b.tempo)
        self.assertEqual([p.name for p in a.parts], [p.name for p in b.parts])
        self.assertEqual(a.bars, b.bars)
        for bar in range(1, a.bars + 2):
            self.assertEqual(a.meter_at(bar), b.meter_at(bar), f"meter at bar {bar}")
        self.assertEqual([(s.bar, s.label, s.description) for s in a.sections],
                         [(s.bar, s.label, s.description) for s in b.sections])
        self.assertEqual(tempo(a), tempo(b))
        for p, q in zip(a.parts, b.parts):
            self.assertEqual(attrs(p), attrs(q), p.name)
            self.assertEqual(sounding(p), sounding(q), p.name)
            self.assertEqual(p.marks(Mark), q.marks(Mark), p.name)
        self.assertFalse(has_errors(b), b.check())

    def test_examples(self):
        for path in EXAMPLES:
            with self.subTest(os.path.basename(path)):
                score = load_score(path)
                self.same(score, rebuild(score))

    def test_report_and_phrase(self):
        score = load_score(os.path.join(ROOT, "examples", "chorale.py"))
        src = to_source(score, report="3 notes quantized\nno lyrics", phrase=2)
        self.assertIn("    3 notes quantized", src)
        self.assertIn("Imported", src.split('"""')[1])
        self.assertIn("|3", src)

    def test_awkward_score(self):
        s = Score('A "quoted" title', meter="2+2+3/8", key="Bb major", tempo=72.5, tempo_text="Lento")
        s.meter_change(3, (3, 4))
        s.free_bar(5, Fraction(7, 2))
        s.tempo_mark((2, 2), "meno", 60)
        s.rit(6, 7, to=40)
        s.section(1, "A", "start")
        s.section(4, "B")
        flute, other = s.part("flute"), s.part("Part 2!", "violin", clef="treble", balance=3, pan=20)
        key_ = s.part("key", "viola", range=(C3, C6))
        flute.at(1, "p Bb4.e C5.e D5.e Eb5.e F5.e G5.e A5.e | Bb5.q Bb5.e3 A5.e3 G5.e3 Bb5.q~ Bb5.e |")
        flute.registration(2, "Flutes 8'", "flute", beat=2)
        other.at(3, "C4.q D4.q E4.q | R.hd | R*3.5 |")
        other.at(6, "E4.q F4.e3 G4.e3 A4.e3 G4.q | Bb4.hd@ |8")
        key_.at(6, "R.q f Ab3.q~ Ab3.q | < Gb3.hd p |8")
        flute.drift(1, 4, ahead=Fraction(1, 8))
        t = rebuild(s)
        self.same(s, t)
        self.assertEqual([p.name for p in t.parts], ["flute", "Part 2!", "key"])

    def test_loops_and_empty_parts(self):
        s = Score("L")
        a, b = s.part("violin"), s.part("cello")
        a.loop(2, "C5.q D5.q E5.q F5.q |", times=3)
        a.at(1, "R.w |")
        a.at(5, "G5.w |")
        t = rebuild(s)
        self.same(s, t)
        self.assertEqual(len(t.loops), 1)
        self.assertEqual(sounding(b), [])

    def test_piano_and_organ(self):
        s = Score("P")
        rh, lh = s.piano()
        r2, l2, ped = s.organ("man1", "man2", "pedal")
        rh.at(1, "C5.w |")
        ped.at(1, "C2.w |")
        src = to_source(s)
        self.assertIn("= score.piano()", src)
        self.assertIn("score.organ(", src)
        self.same(s, rebuild(s))


class Clear(unittest.TestCase):
    def piece(self):
        s = Score("C")
        p = s.part("violin")
        p.at(1, "p C4.w | D4.w | f E4.w | F4.w | G4.w |6")
        return s, p

    def names(self, p):
        return [(t, str(n.pitches[0]) if n.pitches else "R", n.dur) for t, n in p.events() if not n.is_rest]

    def test_middle_span(self):
        s, p = self.piece()
        self.assertIs(p.clear(2, 3), p)
        self.assertEqual([x[1] for x in self.names(p)], ["C4", "F4", "G4"])
        self.assertEqual([m.token for _, m in p.marks(Mark)], ["p"])
        self.assertNotIn("ERROR", s.check())

    def test_single_bar_default(self):
        s, p = self.piece()
        p.clear(3)
        self.assertEqual([x[1] for x in self.names(p)], ["C4", "D4", "F4", "G4"])

    def test_crossing_in(self):
        s = Score("C")
        q = s.part("violin")
        q.at(1, "C4.w | R.h G4.h~ | G4.h A4.h |")
        q.clear(3)
        self.assertEqual(self.names(q)[:2], [(0, "C4", 4), (6, "G4", 2)])
        self.assertFalse(q.events(merge_ties=False)[1][1].tied)

    def test_crossing_out(self):
        s = Score("C")
        p = s.part("violin")
        p._place(s.time(1, 3), ["E4.w"])           # sounds from beat 3 of bar 1 to beat 3 of bar 2
        p.clear(1)
        self.assertEqual(self.names(p), [(4, "E4", 2)])
        s = Score("C")
        p = s.part("violin")
        p._place(s.time(1, 3), ["E4.w@"])
        p.clear(1)
        self.assertEqual(p.events()[0][1].art, "@")

    def test_crossing_both_ways(self):
        s = Score("C")
        p = s.part("violin")
        p._place(s.time(1, 3), ["E4*10>"])
        p.clear(2)
        ev = p.events(merge_ties=False)
        self.assertEqual([(t, n.dur, n.art) for t, n in ev], [(2, 2, ">"), (8, 4, "")])
        self.assertEqual(p.events()[0][1].dur, 2)

    def test_marks_loops_and_chaining(self):
        s = Score("C")
        p, q = s.part("violin"), s.part("viola")
        p.loop(1, "C4.w |", times=4)
        q.loop(1, "D4.w |", times=4)
        p.mark(3, "<")
        p.clear(2, 3).at(2, "E4.h F4.h | G4.w |")
        self.assertEqual(len(s.loops), 1)
        self.assertIs(s.loops[0].part, q)
        self.assertEqual(p.marks(Mark), [])
        self.assertEqual([x[1] for x in self.names(p)], ["C4", "E4", "F4", "G4", "C4"])
        self.assertNotIn("ERROR", s.check())
        self.assertEqual(rebuild(s).parts[0].events()[1][0], 4)

    def test_bad_span(self):
        _, p = self.piece()
        with self.assertRaises(ValueError):
            p.clear(4, 2)


if __name__ == "__main__":
    unittest.main()
