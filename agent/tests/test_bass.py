"""badmidi.bass: draft bass lines from heard chords, and the heard-part data they read."""
import unittest
from fractions import Fraction as F

from badmidi import HeardChord, Rhythm, Score, bass
from badmidi.heard import TONES, voicing

try:
    from badmidi.audio import hear
except ImportError:                                      # the audio extra is optional
    hear = None


def chord(bar, sym, root, bass_pc, q="maj", n=1):
    return HeardChord(F(4 * (bar - 1)), F(4 * (bar - 1 + n)), sym, root, bass_pc, q)


AM, FM, CE, G = chord(1, "Am", 9, 9, "min"), chord(2, "F", 5, 5), chord(3, "C/E", 0, 4), chord(4, "G", 7, 7)
CHORDS = [AM, FM, CE, G]
LO, HI = 28, 55                                           # E1..G3


def notes(motif):
    return [(on, n.pitch.midi, n) for on, n in motif.timed() if not n.is_rest]


def pcs(chord_):
    return set(chord_.tones())


def chord_at(t):
    return next(c for c in CHORDS if c.start <= t < c.end)


class TestStyles(unittest.TestCase):
    def check_range(self, m, lo=LO, hi=HI):
        for _, midi, _ in notes(m):
            self.assertTrue(lo <= midi <= hi, midi)

    def test_roots(self):
        m = bass.line(CHORDS, style="roots")
        ns = notes(m)
        self.assertEqual([(on, p % 12) for on, p, _ in ns], [(F(0), 9), (F(4), 5), (F(8), 4), (F(12), 7)])   # the inversion's bass
        self.assertEqual(m.dur, 16)
        self.check_range(m)
        steps = [abs(b[1] - a[1]) for a, b in zip(ns, ns[1:])]
        self.assertLessEqual(max(steps), 6, "the octave nearest the last note")

    def test_roots_strike_again_on_each_bar_of_a_long_chord(self):
        m = bass.line([chord(1, "Am", 9, 9, "min", 2), chord(3, "F", 5, 5)])
        self.assertEqual([on for on, _, _ in notes(m)], [0, 4, 8])

    def test_root_fifth(self):
        m = bass.line(CHORDS, style="root-fifth")
        ns = notes(m)
        self.assertEqual(len(ns), 16)
        for on, p, _ in ns:
            c = chord_at(on)
            if on % 2 == 0:
                self.assertEqual(p % 12, c.bass, on)
            else:
                self.assertEqual(p % 12, c.fifth() if c.fifth() != c.bass else c.root, on)
        self.check_range(m)

    def test_pulse_follows_the_rhythm(self):
        slots = [0.0] * 16
        for i in (0, 3, 6, 10):
            slots[i] = 0.9
        rh = Rhythm(F(1, 4), 1, {F(4 * k): slots for k in range(4)})
        m = bass.line(CHORDS, rh, "pulse")
        ns = notes(m)
        ons = {on for on, _, _ in ns}
        for k in range(4):
            for i in (0, 3, 6, 10):
                self.assertIn(F(4 * k) + F(i, 4), ons, "every strong heard onset gets a bass onset")
        self.assertEqual(len(ns), 4 * (8 + 1), "8ths plus the one off-8th hit (slot 3) per bar")   # slot 6, 10 are on 8ths
        self.assertEqual({(on, ">") for on, _, n in ns if ">" in n.art}, {(F(4 * k) + F(i, 4), ">") for k in range(4) for i in (0, 3, 6, 10)})
        for on, p, _ in ns:
            self.assertEqual(p % 12, chord_at(on).bass)

    def test_pulse_without_rhythm_is_eighths(self):
        ns = notes(bass.line(CHORDS, style="pulse"))
        self.assertEqual(len(ns), 32)

    def test_kick_is_added_in_pulse_and_snapped_to_in_others(self):
        k = [F(0), F(3, 4), F(9, 2)]
        pulse = {on for on, _, _ in notes(bass.line(CHORDS, style="pulse", kick=k))}
        self.assertTrue(set(k) <= pulse)
        rf = {on for on, _, _ in notes(bass.line(CHORDS, style="root-fifth", kick=[F(5, 4) - F(1, 8)]))}
        self.assertIn(F(9, 8), rf)                       # the beat at 1 moved onto the kick, a 32nd early
        self.assertNotIn(F(1), rf)

    def test_kick_from_a_drum_part(self):
        s = Score("t")
        d = s.part("drums")
        d.at(1, "C2.q D2.q C2.q D2.q |")
        self.assertEqual(bass.kicks(d), [0, 2])

    def test_walk(self):
        m = bass.line(CHORDS, style="walk", key="A minor")
        ns = notes(m)
        self.assertEqual(len(ns), 16)
        self.check_range(m)
        for on, p, _ in ns:
            c = chord_at(on)
            if on % 4 == 0:
                self.assertEqual(p % 12, c.bass, "downbeats are the chord's bass")
            elif on % 4 in (1, 2):
                self.assertIn(p % 12, pcs(c), "the inner beats are chord tones")
        for bar in range(3):
            last = ns[4 * bar + 3][1]
            nxt = ns[4 * bar + 4][1]
            self.assertIn(abs(nxt - last), (1, 2), "an approach note a step from the next change")
        steps = [abs(b[1] - a[1]) for a, b in zip(ns, ns[1:])]
        self.assertLessEqual(max(steps), 9)

    def test_walk_approach_is_diatonic_in_a_key_and_chromatic_without(self):
        dia = bass.line(CHORDS[:2], style="walk", key="A minor")
        a_minor = {9, 11, 0, 2, 4, 5, 7}
        self.assertIn(notes(dia)[3][1] % 12, a_minor)
        chrom = bass.line([chord(1, "Am", 9, 9, "min"), chord(2, "Bb", 10, 10)], style="walk")
        self.assertEqual(abs(notes(chrom)[3][1] - notes(chrom)[4][1]), 1)

    def test_a_chord_that_is_silent_is_a_rest(self):
        n = HeardChord(F(4), F(8), "N", 0, 0, "N")
        m = bass.line([AM, n, chord(3, "F", 5, 5)], style="roots")
        self.assertEqual([x.is_rest for x in m.notes], [False, True, False])

    def test_custom_range_and_part(self):
        for style in bass.STYLES:
            m = bass.line(CHORDS, style=style, key="A minor", range=("C2", "C3"))
            self.check_range(m, 36, 48)
        s = Score("t", key="A minor")
        s.part("bass guitar").at(1, bass.line(CHORDS, style="walk", key=s.key))
        self.assertNotIn("ERROR", s.check())

    def test_heard_part_gives_rhythm_and_key(self):
        from badmidi import HeardPart
        h = HeardPart("Guitar", "guitar (heard)", "A minor", 0, "on the grid", 1, CHORDS)
        self.assertEqual(bass.line(h, style="walk").text(), bass.line(CHORDS, style="walk", key="A minor").text())
        self.assertEqual(h["chords"], CHORDS)

    def test_errors(self):
        with self.assertRaisesRegex(ValueError, "style"):
            bass.line(CHORDS, style="slap")
        with self.assertRaises(ValueError):
            bass.line([])


class TestHeard(unittest.TestCase):
    def test_voicing_has_the_bass_note_lowest(self):
        for c in CHORDS + [chord(1, "E5", 4, 4, "5"), chord(1, "G7", 7, 7, "7")]:
            v = voicing(c)
            self.assertEqual(v[0] % 12, c.bass)
            self.assertTrue(40 <= v[0] < 52 and all(40 <= x <= 66 for x in v), v)
            self.assertEqual({x % 12 for x in v}, set(c.tones()) | ({c.bass} if c.quality != "5" else set()))

    def test_rhythm_lookup(self):
        r = Rhythm(F(1, 4), 1, {0: [1, 0, 0.6, 0], 4: [0.5, 0, 0, 0]})
        self.assertEqual(r.at(F(1, 2)), 0.6)
        self.assertEqual(r.at(F(1, 8)), 0.0)
        self.assertEqual([t for t, _ in r.onsets(0, 8)], [0, F(1, 2), 4])

    @unittest.skipIf(hear is None, "numpy/scipy not installed")
    def test_tones_match_the_hearing_templates(self):
        for q, iv in TONES.items():
            self.assertEqual(tuple(i for i, _ in hear.QUALITIES[q][1]), iv, q)


if __name__ == "__main__":
    unittest.main()
