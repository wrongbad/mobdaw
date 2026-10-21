"""badmidi test suite.  Run with:  python -m unittest discover tests

Covers the notation (pitches, durations, string parser, transformations,
spelling), the score model (time, anchors, ties, checks), the performance
layer (dynamics, tempo, pedal, couplers), the MIDI and LilyPond writers, and
the example pieces (they must pass check and survive a melody-view round trip).
"""
import shutil
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

import badmidi as bm
from badmidi import (A4, B3, B4, Bb3, C4, C5, D3, D5, E4, E5, Fs4, G4, G5, M, R, Score,
                     key, spelling)
from badmidi.cli import load_score
from badmidi.core import NotationError, Pitch
from badmidi.lilypond import EngraveError, engrave, lilypond, score_notes, verify
from badmidi.midi import midi_bytes, read_notes
from badmidi.perform import Dynamics, LEVELS, HAIRPIN_STEP, PEDAL_LIFT, pedal_events, tempo_map
from badmidi.views import _bar_cells, _issues, has_errors

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def issues(score, level=None):
    return [i for i in _issues(score) if level is None or i[0] == level]


class TestPitches(unittest.TestCase):
    def test_constants_and_arithmetic(self):
        self.assertEqual(E4.midi, 64)
        self.assertEqual(E4 + 7, B4)
        self.assertEqual(B4 - E4, 7)
        self.assertEqual(Pitch.parse("F#4").midi, 66)
        self.assertEqual(Pitch.parse("Fs4"), Pitch.parse("Gb4"))

    def test_written_spelling_is_kept(self):
        self.assertEqual(repr(Bb3), "Bb3")
        self.assertEqual(Pitch.parse("B#3").midi, 60)
        self.assertEqual(Pitch.parse("B#3").name, "B#3")
        self.assertEqual(Pitch.parse("Cb4").name, "Cb4")
        self.assertEqual(repr(M("Ds4.q As3.q").octave(1).pitches), "[Ds5, As4]")   # octaves keep it
        self.assertEqual(Pitch.parse("Ds4") + 3, Pitch.parse("Fs4"))
        self.assertIsNone((Pitch.parse("Ds4") + 3).spell)                          # other intervals don't

    def test_transposition_is_spelled_as_an_interval(self):
        subject = M("C3.h G3.q A3.q | F3.qd E3.e D3.e E3.e C3.q |")
        self.assertEqual(subject.transpose(6).text(),
                         "Fs3.h Cs4.q Ds4.q | B3.qd As3.e Gs3.e As3.e Fs3.q |")
        self.assertEqual(M("E4.q G4.q").transpose(3).text(), "G4.q Bb4.q")
        self.assertEqual(M("C4.q G4.q A4.q F4.q").invert(around=A4).text(), "Fs5.q B4.q A4.q Cs5.q")
        self.assertEqual(M("Cs4.q D4.q").transpose(4, scale=key("A major")).text(), "Gs4.q A4.q")
        self.assertEqual(M("Ab3.q").unbarred(), M("Ab3.q |").unbarred())

    def test_key_spelling_of_computed_pitches(self):
        with spelling(key("C minor")):
            self.assertEqual(str(C4 + 6), "F#4")
            self.assertEqual(str(C4 + 1), "Db4")
            self.assertEqual(str(C4 + 11), "B4")
        self.assertEqual(key("C minor").names,
                         ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"])
        self.assertIn("F##", key("G# minor").names)

    def test_key_signatures(self):
        self.assertEqual(key("Bb major").signature, -2)
        self.assertEqual(key("F# minor").signature, 3)
        self.assertEqual(key("D dorian").signature, 0)
        self.assertTrue(key("Em").minor)


class TestDurations(unittest.TestCase):
    def test_codes(self):
        self.assertEqual(E4.q.dur, 1)
        self.assertEqual(E4.qd.dur, Fraction(3, 2))
        self.assertEqual(E4.e3.dur, Fraction(1, 3))
        self.assertEqual((E4 * 1.5).dur, Fraction(3, 2))
        self.assertEqual(E4.q.dot.dur, Fraction(3, 2))

    def test_pitch_without_duration_is_an_error(self):
        with self.assertRaises(TypeError):
            M(E4, G4.q)


class TestParser(unittest.TestCase):
    def test_strings_equal_python(self):
        self.assertEqual(M("E4.q G4.e A4.e B4.h"), M(E4.q, G4.e, A4.e, B4.h))
        self.assertEqual(M("[C4 E4 G4].h").notes[0].pitches, (C4, E4, G4))
        self.assertEqual(M("R.q").notes[0].is_rest, True)

    def test_ties_and_articulations(self):
        n = M("E4.q>'~").notes[0]
        self.assertTrue(n.tied)
        self.assertEqual(n.art, ">'")
        self.assertEqual(E4.q.accent.staccato, n.with_tied(False))

    def test_marks(self):
        kinds = [(m.kind, m.value) for m in M('p < E4.q ! "dolce" ped E4.q *').items if isinstance(m, bm.Mark)]
        self.assertEqual(kinds, [("dyn", "p"), ("cresc", None), ("end", None),
                                 ("text", "dolce"), ("ped", None), ("pedup", None)])

    def test_text_and_repr_round_trip(self):
        m = M('p "con fuoco" E4.q> G4.e\' A4.e < B4.h_~ | B4.q ff ped [C4 E4].h^ * R.q@ ! |14')
        self.assertEqual(M(m.text()), m)
        self.assertEqual(eval(repr(m), vars(bm)), m)

    def test_errors_point_at_the_token(self):
        for bad in ["E4.x", "H4.q", "R.q~", "E4", "[ ].h", "E4.q%"]:
            with self.assertRaises(NotationError, msg=bad):
                M(bad)
        with self.assertRaises(NotationError) as cm:
            M("E4.q | H4.q")
        self.assertIn("in bar 2", str(cm.exception))


class TestTransformations(unittest.TestCase):
    theme = M("E4.q G4.e A4.e B4.h")

    def test_invert_transpose(self):
        self.assertEqual(self.theme.invert(around=A4).transpose(5).pitches,
                         [G5, E5, D5, C5])

    def test_diatonic(self):
        self.assertEqual(self.theme.transpose(2, scale=key("E minor")).text(), "G4.q B4.e C5.e D5.h")
        self.assertEqual(self.theme.invert(scale=key("E minor")).text(), "E4.q C4.e B3.e A3.h")

    def test_sequence_augment_fragment(self):
        seq = M("E4.q").sequence([-1, -1], scale=key("E minor"))
        self.assertEqual(seq.text(), "E4.q D4.q C4.q")
        self.assertEqual(self.theme.augment(2).dur, 8)
        self.assertEqual(self.theme.fragment(0, 2).text(), "E4.q G4.e")

    def test_retrograde_moves_ties_and_drops_marks(self):
        r = M("p C4.q D4.h~ D4.e E4.e").retrograde()
        self.assertEqual(r.text(), "E4.e D4.e~ D4.h C4.q")

    def test_double(self):
        self.assertEqual(M("C5.q R.q").double(-12).text(), "[C4 C5].q R.q")

    def test_rhythm_and_pitches(self):
        self.assertEqual(self.theme.rhythm(1).durations, [1, 1, 1, 1])
        self.assertEqual(self.theme.with_pitches(C4).pitches, [C4] * 4)


class TestScore(unittest.TestCase):
    def test_time_and_position(self):
        s = Score(meter=(3, 4))
        self.assertEqual(s.time(2, 2), 4)
        self.assertEqual(s.position(Fraction(4)), (2, 2))
        self.assertEqual(s.time(1, 2.5), Fraction(3, 2))

    def test_miscount_is_reported_once_and_locally(self):
        s = Score()
        s.part("violin").at(1, "E4.q G4.e A4.e B4.h | C5.h B4.e A4.q | G4.w |4")
        errs = issues(s, "ERROR")
        self.assertEqual(len(errs), 1)
        self.assertIn("bar 2 has 3.5 beats, expected 4 beats: an eighth (.e) too short", errs[0][3])

    def test_second_voice_on_a_staff(self):
        s = Score()
        rh, _ = s.piano()
        rh.at(1, "C5.w")
        rh.at(1, "E4.h F4.h")
        self.assertIn("rh.voice(name)", issues(s, "ERROR")[0][3])
        alto = rh.voice("alto")
        self.assertEqual((alto.staff, alto.group, alto.channel, alto.instrument), ("rh", "Piano", "Piano", "piano"))
        s2 = Score()
        r2, _ = s2.piano()
        r2.at(1, "C5.w")
        r2.voice("alto").at(1, "E4.h F4.h")
        self.assertEqual(issues(s2, "ERROR"), [])

    def test_wrong_bar_number(self):
        s = Score()
        s.part("violin").at(1, "E4.w | C5.w |4")
        self.assertIn("not bar 4", issues(s, "ERROR")[0][3])

    def test_pickup_placement_is_fine(self):
        s = Score()
        s.part("violin").at(1, "E4.q G4.q | A4.w |3", beat=3)
        self.assertEqual(issues(s, "ERROR"), [])

    def test_overlap_and_range(self):
        s = Score()
        s.part("violin").at(1, "C5.w").at(1, "E5.h", beat=3).at(2, "C3.q")
        self.assertTrue(any("overlaps" in i[3] for i in issues(s, "ERROR")))
        self.assertTrue(any("below the violin range" in i[3] for i in issues(s, "WARN")))

    def test_ties_merge_into_one_sounding_event(self):
        s = Score()
        p = s.part("violin").at(1, "E4.w~ | E4.q")
        self.assertEqual([(t, n.dur) for t, n in p.events()], [(0, 5)])
        self.assertEqual(len(p.events(merge_ties=False)), 2)

    def test_marking_warnings(self):
        s = Score()
        s.part("violin").at(1, "p < E4.w | * E4.w")
        msgs = [i[3] for i in issues(s, "WARN")]
        self.assertTrue(any("runs to the end" in i[3] for i in issues(s, "NOTE")))
        self.assertTrue(any("no pedal down" in m for m in msgs))

    def test_parallel_fifths_are_noted(self):
        s = Score()
        s.part("upper", "violin").at(1, "G4.q A4.q")
        s.part("lower", "cello").at(1, "C3.q D3.q")
        self.assertEqual([o.kind for o in s.observe()], ["parallel fifths"])
        self.assertEqual(issues(s, "ERROR") + issues(s, "WARN"), [])   # an observation, not a problem

    def test_staff_order(self):
        s = Score()
        rh, lh = s.piano()
        inner = s.part("rh2", "piano", group="Piano", staff="rh")
        self.assertEqual(s.ordered_parts(), [rh, inner, lh])


class TestPerformance(unittest.TestCase):
    def test_hairpin_ramps_to_next_dynamic(self):
        s = Score()
        rh, _ = s.piano()
        rh.at(1, "p E4.q < E4.q E4.q E4.q | f E4.w")
        d = Dynamics(rh)
        self.assertEqual(d.level(Fraction(0)), LEVELS["p"])
        self.assertEqual(d.level(Fraction(1)), LEVELS["p"])
        self.assertAlmostEqual(d.level(Fraction(5, 2)), (LEVELS["p"] + LEVELS["f"]) / 2)
        self.assertEqual(d.level(Fraction(4)), LEVELS["f"])

    def test_open_hairpin(self):
        s = Score()
        p = s.part("violin").at(1, "p < E4.w ! E4.w")
        self.assertEqual(Dynamics(p).level(Fraction(6)), LEVELS["p"] + HAIRPIN_STEP)

    def test_dynamics_shared_by_group(self):
        s = Score()
        rh, lh = s.piano()
        rh.at(1, "ff E4.w")
        lh.at(1, "C3.w")
        self.assertEqual(Dynamics(lh).level(Fraction(0)), LEVELS["ff"])

    def test_tempo_and_fermata(self):
        s = Score(tempo=120)
        s.part("violin").at(1, "E4.w | E4.w@")
        self.assertAlmostEqual(s.seconds(Fraction(4)), 2.0)
        self.assertAlmostEqual(s.seconds(Fraction(8)), 6.0)    # the fermata bar takes twice as long

    def test_rit(self):
        s = Score(tempo=120)
        s.part("violin").at(1, "E4.w | E4.w | E4.w")
        s.rit(2, 3, to=60)
        tm = tempo_map(s)
        self.assertEqual(tm[0], (0, 120.0))
        self.assertEqual(tm[-1], (8, 60.0))
        self.assertGreater(s.seconds(Fraction(8)), 4.0)

    def test_pedal_changes(self):
        s = Score()
        _, lh = s.piano()
        lh.at(1, "ped C3.w | ped C3.w | *")
        self.assertEqual(pedal_events(lh), [(0, 127), (4, 0), (4 + PEDAL_LIFT, 127), (8, 0)])


class TestOutput(unittest.TestCase):
    def test_midi_structure(self):
        s = Score()
        s.part("violin").at(1, "E4.w")
        data = midi_bytes(s)
        self.assertEqual(data[:4], b"MThd")
        self.assertEqual(int.from_bytes(data[10:12], "big"), 2)   # conductor + 1 part

    def test_couplers_sound_extra_octaves(self):
        s = Score()
        s.part("pedal", "pedal", couplers=(0, -12)).at(1, "D3.w")
        data = midi_bytes(s)
        self.assertIn(bytes([0x90, D3.midi]), data)
        self.assertIn(bytes([0x90, D3.midi - 12]), data)

    def test_registration_changes_program(self):
        s = Score()
        p = s.part("organ").at(1, "C4.w | C4.w")
        p.registration(2, "Sw.", "percussive organ")
        self.assertIn(bytes([0xC0, 17]), midi_bytes(s))

    def test_lilypond_notation(self):
        s = Score("t", key="C minor")
        rh, lh = s.piano()
        rh.at(1, 'p C5.q> D5.e3 Eb5.e3 F5.e3 < G5.h~ | G5.w@ f')
        lh.at(1, "ped C3.w | * C3.w")
        s.rit(2, 3, to=60)
        ly = lilypond(s)
        for snippet in ["\\key c \\minor", "\\tuplet 3/2", "->", "~", "\\fermata", "\\p",
                        "\\<", "\\f", "\\sustainOn", "\\sustainOff", "\\startTextSpan",
                        "\\new PianoStaff", '\\bar "|."']:
            self.assertIn(snippet, ly, snippet)

    def test_triplets_bracketed_per_beat(self):
        s = Score()
        s.part("violin").at(1, " ".join(["G4.e3"] * 6) + " G4.h |")
        ly = lilypond(s)
        self.assertEqual(ly.count("\\tuplet 3/2"), 2)

    def test_lilypond_splits_notes_at_barlines(self):
        s = Score()
        s.part("violin").at(1, "R.h E4.w R.h")
        self.assertIn("e'2~ | e'2", lilypond(s).replace("\n", " ").replace("    ", ""))

    def test_organ_layout(self):
        s = Score()
        man1, man2, ped = s.organ()
        man1.at(1, "C5.w")
        man2.at(1, "C4.w")
        ped.at(1, "C3.w")
        ly = lilypond(s)
        self.assertIn('instrumentName = "Ped."', ly)
        self.assertLess(ly.index("\\new PianoStaff"), ly.index('instrumentName = "Ped."'))


class TestEngravingRules(unittest.TestCase):
    def test_ottava_for_far_off_bars(self):
        s = Score()
        _, lh = s.piano()
        lh.at(1, "[C1 C2].w | C3.w")
        ly = lilypond(s)
        self.assertIn("\\ottava #-1", ly)
        self.assertIn("\\ottava #0", ly)

    def test_duplicate_registrations_merge(self):
        s = Score()
        rh, lh, ped = s.organ()
        alto = s.part("alto", "organ", group="Organ", staff="rh")
        rh.at(1, "C5.w").registration(1, "Gt.")
        alto.at(1, "C4.w").registration(1, "Gt.")
        self.assertEqual(lilypond(s).count('"Gt."'), 1)

    def test_text_beside_dynamic(self):
        s = Score()
        s.part("violin").at(1, 'p "dolce" E4.w')
        self.assertIn('#:dynamic "p" #:normal-text #:italic "dolce"', lilypond(s))


class TestVerification(unittest.TestCase):
    def test_reader_reads_our_own_midi(self):
        sc = load_score(str(EXAMPLES / "prelude.py"))
        self.assertEqual(read_notes(midi_bytes(sc)), score_notes(sc))   # no couplers or staccato there

    def test_verify_reports_differences(self):
        s = Score()
        s.part("violin").at(1, "E4.w")
        other = Score()
        other.part("violin").at(1, "F4.w")
        self.assertEqual(verify(s, midi_bytes(s)), [])
        problems = verify(s, midi_bytes(other))
        self.assertEqual(len(problems), 2)
        self.assertIn("missing from the engraving: E4 at 1:1", problems[0])

    @unittest.skipUnless(shutil.which("lilypond"), "lilypond not installed")
    def test_examples_engrave_and_verify(self):
        with tempfile.TemporaryDirectory() as tmp:
            for f in [_p for _p in sorted(EXAMPLES.glob("*.py")) if _p.name != "bass_for_take.py"]:
                with self.subTest(piece=f.name):
                    engrave(load_score(str(f)), str(Path(tmp) / (f.stem + ".pdf")))   # raises on any mismatch


class TestMeters(unittest.TestCase):
    def setUp(self):
        self.s = Score(meter=(4, 4))
        self.s.meter_change(2, "3/4").meter_change(3, "2+2+3/8").free_bar(4, 9).meter_change(6, (6, 8))

    def test_time_across_changes(self):
        s = self.s
        self.assertEqual([s.bar_start(b) for b in range(1, 8)], [0, 4, 7, Fraction(21, 2), Fraction(39, 2), 23, 26])
        self.assertEqual(s.time(3, 3), 8)                       # eighth-note beats in 7/8
        self.assertEqual(s.position(Fraction(23)), (6, 1))
        self.assertEqual(s.meter_at(5).text, "2+2+3/8")          # the meter resumes after a free bar
        with self.assertRaises(ValueError):
            s.time(2, 4)                                         # no beat 4 in 3/4

    def test_metric_levels(self):
        s = self.s
        self.assertEqual(s.metric_level(s.time(3)), 3)
        self.assertEqual(s.metric_level(s.time(3, 3)), 2)        # an additive group starts
        self.assertEqual(s.metric_level(s.time(3, 2)), 0)
        self.assertEqual(s.metric_level(s.time(6, 4)), 2)        # 6/8: the second dotted quarter
        self.assertEqual(Score().metric_level(Fraction(2)), 2)   # beat 3 of 4/4
        self.assertEqual(Score().metric_level(Fraction(1)), 1)       # every beat is a pulse in 4/4
        self.assertEqual(Score().metric_level(Fraction(1, 2)), -1)

    def test_check_counts_each_bar_in_its_own_meter(self):
        self.s.part("violin").at(1, "C5.w | D5.h E5.q | F5.e G5.e A5.e G5.e F5.q |")
        self.assertIn("bar 3 has 6 beats, expected 7 beats", issues(self.s, "ERROR")[0][3])

    def test_views_and_outputs_show_meters(self):
        s = self.s
        s.part("violin").at(1, "C5.w | D5.h E5.q | F5.e G5.e A5.e G5.e F5.qd |", "C5.q " * 9 + "|",
                            "G5.q G5.q G5.qd | C5.qd D5.qd |7")
        self.assertEqual(issues(s, "ERROR"), [])
        self.assertIn("3 2+2+3/8", s.melody())
        self.assertIn("-- 4 free", s.grid())
        ly = lilypond(s)
        for snippet in ["\\time 3/4", "\\compoundMeter #'((2 2 3 8))", "measureLength = #(ly:make-moment 9/4)",
                        '\\bar ""', "\\time 6/8"]:
            self.assertIn(snippet, ly)
        self.assertEqual(midi_bytes(s).count(bytes([0xFF, 0x58])), 6)

    def test_entry_mid_bar_keeps_its_own_barlines(self):
        subject = M("C4.h G4.q A4.q | F4.qd E4.e D4.e E4.e C4.q |")
        s = Score()
        s.part("violin").at(1, subject, "E4.h |", beat=3)          # enters at the half bar
        self.assertEqual(issues(s, "ERROR"), [])
        bad = Score()
        bad.part("violin").at(1, M("C4.h G4.q | F4.w |"), beat=3)  # its first bar is short
        self.assertTrue(issues(bad, "ERROR"))

    @unittest.skipUnless(shutil.which("lilypond"), "lilypond not installed")
    def test_meters_and_tuplets_engrave(self):
        s = self.s
        s.part("violin").at(1, "C5.s5 D5.s5 E5.s5 F5.s5 G5.s5 A5.e3 G5.e3 F5.e3 E5.e7 D5.e7 C5.e7 B4.e7 C5.e7 D5.e7 E5.e7 |",
                            "C5.q5:3 D5.q5:3 E5.q5:3 F5.q5:3 G5.q5:3 |", "F5.e G5.e A5.e G5.e F5.qd |",
                            "C5.q " * 9 + "|", "G5.q G5.q G5.qd | C5.qd D5.qd |7")
        with tempfile.TemporaryDirectory() as tmp:
            engrave(s, str(Path(tmp) / "m.pdf"))
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), ["m.pdf"])   # no stray .ly


class TestTuplets(unittest.TestCase):
    def test_codes(self):
        self.assertEqual(bm.duration("s5"), Fraction(1, 5))
        self.assertEqual(bm.duration("e7"), Fraction(2, 7))
        self.assertEqual(bm.duration("q5:3"), Fraction(3, 5))
        self.assertEqual(bm.duration("e3"), Fraction(1, 3))
        self.assertEqual(C4.s5, M("C4.s5")[0])
        with self.assertRaises(ValueError):
            bm.duration("q4")

    def test_round_trip(self):
        m = M("C4.s5 D4.e7 E4.q5:3 F4*(2/9)")
        self.assertEqual(M(m.text()), m)
        self.assertEqual(m.text(), "C4.s5 D4.e7 E4.q5:3 F4.s9")

    def test_written_ratio_is_kept(self):
        m = M("C4.q5:3 D4.q5:3 E4.q5:3 F4.q5:3 G4.q5:3")
        self.assertEqual(m.notes[0].tuplet, (5, 3))
        self.assertEqual(m.augment(2).text().split()[0], "C4.h5:3")
        self.assertEqual(m.rhythm(1).text().split()[0], "C4.q")       # plain lengths need no tuplet
        self.assertEqual(M("C4*(3/5)").text(), "C4.q5:3")
        s = Score(meter=(3, 4))
        s.part("violin").at(1, m, "|")
        self.assertIn("\\tuplet 5/3 { c'4", lilypond(s))

    def test_lilypond_brackets(self):
        s = Score()
        s.part("violin").at(1, "C5.s5 " * 5 + "C5.e7 " * 7 + "C5.q |")
        ly = lilypond(s)
        self.assertEqual(ly.count("\\tuplet 5/4"), 1)
        self.assertEqual(ly.count("\\tuplet 7/4"), 1)


class TestAnalysis(unittest.TestCase):
    def test_set_classes(self):
        self.assertEqual(bm.prime_form({0, 4, 7}), (0, 3, 7))
        self.assertEqual(bm.prime_form([C4, E4, G4 + 1]), (0, 4, 8))
        self.assertEqual(bm.prime_form({0, 1, 3, 6, 7, 9}), (0, 1, 3, 6, 7, 9))
        self.assertEqual(bm.interval_vector({0, 1, 4, 6}), (1, 1, 1, 1, 1, 1))
        self.assertEqual(bm.set_label([C4, E4, G4, Fs4 + 12, Fs4 + 16, Fs4 + 19]), "6-30 (013679) Petrushka")
        self.assertEqual(bm.set_label([C4, G4]), "ic5")

    def lens(self, upper, lower, meter=(4, 4)):
        s = Score(meter=meter)
        s.part("upper", "violin").at(1, upper)
        s.part("lower", "cello").at(1, lower)
        return [(s.where(o.t), o.where, o.kind) for o in s.observe()]

    def test_dissonances_are_named_by_how_they_move(self):
        self.assertEqual(self.lens("E4.q F4.q G4.h", "C3.w"), [("1:2", "upper", "passing")])
        self.assertEqual(self.lens("E4.q F4.q E4.h", "C3.w"), [("1:2", "upper", "neighbour")])
        self.assertEqual(self.lens("C4.q F4.q E4.h", "C3.w"), [("1:2", "upper", "appoggiatura")])
        self.assertEqual(self.lens("E4.q F4.q A4.h", "C3.w"), [("1:2", "upper", "escape tone")])
        self.assertEqual(self.lens("C4.h D4.h", "C3.h C3.h"), [("1:3", "upper", "unresolved")])
        self.assertEqual(self.lens("C4.h G4.q D4.q | G4.w", "C3.w | C3.w"), [("1:4", "upper", "free dissonance")])
        self.assertEqual(self.lens("C4.h D4.h E4.w", "C3.h C3.h C3.w"), [("1:3", "upper", "accented passing")])

    def test_suspensions(self):
        obs = Score()
        obs.part("upper", "violin").at(1, "G4.h C5.h~ | C5.h B4.h |")
        obs.part("lower", "cello").at(1, "C3.h E3.h | D3.w |")
        [o] = obs.observe()
        self.assertEqual((o.kind, o.detail), ("suspension", "C5: m7->M6 with lower D3"))
        held = self.lens("G4.h C5.h~ | C5.h D5.h |", "C3.h E3.h | D3.w |")
        self.assertEqual(held, [("2:1", "upper", "retardation")])

    def test_lens_view(self):
        s = Score()
        s.part("upper", "violin").at(1, "G4.q A4.q E4.q F4.q G4.w |")
        s.part("lower", "cello").at(1, "C3.q D3.q C3.h | C3.w |")
        text = s.lens()
        self.assertIn("parallel fifths", text)
        self.assertIn("passing", text)
        self.assertNotIn("passing", s.lens(kinds=["parallel"]))
        self.assertIn("3-12 (048) augmented", Score().part("v", "piano").at(1, "[C4 E4 Gs4].w").score.grid())
        self.assertIn("Am", Score().part("v", "piano").at(1, "[A3 C4 E4].w").score.grid())

    def test_isorhythm(self):
        m = bm.isorhythm("C4 D4 E4", [1, 2])
        self.assertEqual(m.text(), "C4.q D4.h E4.q C4.h D4.q E4.h")
        m = bm.isorhythm([C4, E4], M("C4.q R.q C4.h>"), notes=3)
        self.assertEqual(m.text(), "C4.q R.q E4.h> C4.q")

    def test_stretti(self):
        subject = M("C4.h G4.q A4.q | F4.qd E4.e D4.e E4.e C4.q |")
        found = bm.stretti(subject, intervals=(12, 7), offsets=[2, 4, 7])
        self.assertEqual([(x.offset, x.interval) for x in found], [(2, 12), (2, 7), (4, 12), (4, 7), (7, 12), (7, 7)])
        self.assertEqual(found[-1].summary(), "consonant throughout")
        self.assertEqual(found[0].follower, M(*subject.notes).transpose(12))
        self.assertIn("what happens", str(found))
        sc = Score()
        a, b = sc.part("a", "violin"), sc.part("b", "viola")
        found[2].place(a, b, 3)
        self.assertEqual(b.events()[0][0], sc.time(4))


CELL = "E4.s Fs4.s B4.s Cs5.s D5.s Fs4.s E4.s Cs5.s B4.s Fs4.s D5.s Cs5.s |"
needs_lilypond = unittest.skipUnless(shutil.which("lilypond"), "lilypond not installed")


class TestTwelveInEleven(unittest.TestCase):
    """A bar of 12/16 squeezed twelve notes into eleven sixteenths."""

    def score(self):
        s = Score("Drift", meter=(12, 16))
        cell = M(CELL)
        squeezed = cell.unbarred().diminish(Fraction(12, 11))
        s.part("a", "marimba").at(1, cell, cell, cell)
        s.part("b", "marimba").at(1, cell, M(squeezed, "R.s |"))      # then a rest bar for the silent bars
        s.part("c", "marimba").at(5, cell)                            # three bars of rest before it
        return s

    def test_spelled_as_a_compressed_tuplet(self):
        m = M(CELL).unbarred().diminish(Fraction(12, 11))
        self.assertTrue(m.text().startswith("E4.s12:11 Fs4.s12:11"))
        self.assertEqual(M(m.text()), m)                              # and it reads back

    def test_engraved_as_one_bracket(self):
        ly = self.score().lilypond()
        self.assertIn("\\tuplet 12/11 { e'16 fs'16 b'16 cs''16 d''16 fs'16 e'16 cs''16 b'16 fs'16 d''16 cs''16 } r16 |", ly)
        self.assertNotIn("4*11/48", ly)
        self.assertNotIn("\\tuplet 3/2 { e'16~ }", ly)

    @needs_lilypond
    def test_engraves_without_warnings_and_verifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            engrave(self.score(), str(Path(tmp) / "d.pdf"))           # raises on warnings or mismatch

    def test_other_tuplets_still_pick_their_own_ratio(self):
        s = Score(meter=(5, 8))
        s.part("v").at(1, "C4.s5 " * 5 + "C4.e3 " * 3 + "C4.e5:3 " * 3 + "|")
        ly = s.lilypond()
        for snippet in ("\\tuplet 5/4", "\\tuplet 3/2", "\\tuplet 5/3"):
            self.assertIn(snippet, ly)


class TestSections(unittest.TestCase):
    def score(self):
        s = Score("S", meter=(4, 4))
        a, b = s.part("a", "violin"), s.part("b", "cello")
        a.at(1, "C5.w | E5.w | G5.w | C6.w |")
        b.at(1, "C3.w |")
        b.at(5, "C3.w | G2.w |")
        a.at(5, "p E5.q E5.q E5.h | f R.w |")
        s.section(1, "A", "opening").section(3, "B").section(5, "C")
        return s

    def test_section_bars(self):
        s = self.score()
        self.assertEqual(s.section_bars("B"), (3, 4))
        self.assertEqual(s.section_bars("B-C"), (3, 6))
        self.assertEqual(s.section_bars("C"), (5, 6))
        with self.assertRaises(ValueError):
            s.section_bars("Z")
        with self.assertRaises(ValueError):
            s.section(3, "X")
        with self.assertRaises(ValueError):
            s.section(9, "A")

    def test_views_take_a_section(self):
        s = self.score()
        text = s.melody(section="B")
        self.assertIn("3 [B]", text)
        self.assertIn("G5.w", text)
        self.assertNotIn("C5.w", text)
        self.assertEqual(s.grid(section="B"), s.grid(bars=(3, 4)))
        self.assertEqual(s.lens(section="C"), s.lens(bars=(5, 6)))

    def test_cli_section_flag(self):
        import contextlib, io
        from badmidi.cli import main
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "piece.py"
            path.write_text("from badmidi import *\nscore = Score(meter=(4,4))\n"
                            "score.part('violin').at(1, 'C5.w | D5.w | E5.w |')\n"
                            "score.section(1, 'A').section(3, 'B')\n")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                main([str(path), "melody", "--section", "B"])
            self.assertIn("E5.w", out.getvalue())
            self.assertNotIn("D5.w", out.getvalue())
            with self.assertRaises(SystemExit):
                main([str(path), "melody", "--section", "Q"])

    def test_engraved_as_rehearsal_marks(self):
        ly = self.score().lilypond()
        self.assertIn('\\mark \\markup { \\box "A" }', ly)
        self.assertIn('\\box "B"', ly)
        self.assertIn('\\italic "opening"', ly)

    @needs_lilypond
    def test_sections_engrave_and_verify(self):
        with tempfile.TemporaryDirectory() as tmp:
            engrave(self.score(), str(Path(tmp) / "s.pdf"))


class TestForm(unittest.TestCase):
    def score(self):
        s = Score("F", meter=(4, 4), key="C major")
        a, b = s.part("a", "violin"), s.part("b", "cello")
        a.at(1, "p C5.q D5.q E5.q F5.q | G5.w |")
        b.at(3, "f C3.w | G2.w |")
        a.at(3, "E5.e E5.e E5.e E5.e E5.e E5.e E5.e E5.e | Fs5.w |")
        s.section(1, "A", "alone").section(3, "B", "joined")
        return s

    def test_rows_per_section(self):
        lines = self.score().form().splitlines()
        row_a = next(l for l in lines if l.startswith("A "))
        row_b = next(l for l in lines if l.startswith("B "))
        self.assertIn("1-2", row_a)
        self.assertIn("a ", row_a + " ")
        self.assertIn("C5-G5", row_a)
        self.assertIn("0.6", row_a)                  # 5 onsets in 8 beats
        self.assertIn("(alone)", "\n".join(lines))
        self.assertIn("all", row_b)
        self.assertIn("+b", row_b)                   # the cello enters
        self.assertIn("lo -", row_b)                 # and the lowest note drops
        self.assertIn("dyn p->f", row_b)
        self.assertIn("pcs", row_b)

    def test_every_n_bars_overrides_sections(self):
        text = self.score().form(every=1)
        self.assertEqual(sum(1 for l in text.splitlines() if l.startswith("-")), 4)
        self.assertNotIn("alone", text)

    def test_without_sections_defaults_to_eight_bars(self):
        s = Score(meter=(4, 4))
        s.part("v", "violin").at(1, "C5.w | " * 10)
        rows = [l for l in s.form().splitlines() if l.startswith("-")]
        self.assertEqual([r.split()[1] for r in rows], ["1-8", "9-10"])

    def test_cli_form(self):
        import contextlib, io
        from badmidi.cli import main
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            main([str(EXAMPLES / "phase_study.py"), "form"])
        self.assertIn("the second marimba slips", out.getvalue())


class TestRestructuring(unittest.TestCase):
    marked = M('p C4.q> "x" D4.q E4.q ped F4.q | G4.q *')

    def test_rotate_keeps_markings_with_their_notes(self):
        self.assertEqual(self.marked.rotate(1).text(), '"x" D4.q E4.q ped F4.q G4.q p C4.q> *')
        self.assertEqual(self.marked.rotate(-1).text(), 'G4.q p C4.q> "x" D4.q E4.q ped F4.q *')
        self.assertEqual(self.marked.rotate(5).text(), self.marked.rotate(0).text())
        self.assertEqual(self.marked.rotate(0).text(), 'p C4.q> "x" D4.q E4.q ped F4.q G4.q *')   # bars dropped
        self.assertEqual(M().rotate(2), M())

    def test_events_and_restructure(self):
        evs = self.marked.events()
        self.assertEqual([e.note.pitch for e in evs], [C4, bm.D4, E4, bm.F4, G4])
        self.assertEqual(evs[0].marks, (bm.dyn("p"),))
        self.assertEqual(evs[1].marks, (bm.text("x"),))
        self.assertEqual(self.marked.tail, (bm.PED_UP,))
        rev = self.marked.restructure(lambda es: es[::-1])
        self.assertEqual(rev.text(), 'G4.q ped F4.q E4.q "x" D4.q p C4.q> *')
        self.assertEqual(len(self.marked.restructure(lambda es: es + es)), 10)
        self.assertEqual(M.from_events([C4.q, E4.q]).text(), "C4.q E4.q")
        self.assertEqual(M.from_events(evs[:2], tail=[bm.PED_UP]).text(), 'p C4.q> "x" D4.q *')

    def test_dangling_tie_dropped(self):
        m = M("C4.q~ C4.q D4.q")
        self.assertEqual(m.restructure(lambda es: es).text(), "C4.q~ C4.q D4.q")
        self.assertEqual(m.restructure(lambda es: [es[0], es[2], es[1]]).text(), "C4.q D4.q C4.q")
        self.assertEqual(m.rotate(1).text(), "C4.q D4.q C4.q")

    def test_timed_and_map_timed(self):
        m = M("C4.q D4.e R.e E4.h")
        self.assertEqual([t for t, _ in m.timed()], [0, 1, Fraction(3, 2), 2])
        got = []
        self.assertEqual(m.map_timed(lambda n, i, t: got.append((i, t)) or n), m)
        self.assertEqual(got[-1], (3, 2))
        self.assertEqual(M("p C4.q D4.q |").map_timed(lambda n, i, t: n.with_dur(1 + i)).text(), "p C4.q D4.h |")

    def test_pipe(self):
        double = lambda m, k: m * k
        self.assertEqual(M("C4.q").pipe(double, 3).transpose(2).text(), "D4.q D4.q D4.q")
        self.assertEqual(M("C4.q").pipe(double, k=2).dur, 2)


class TestRebarExpect(unittest.TestCase):
    def errors(self, motif, beat=1, meter=(4, 4)):
        s = Score(meter=meter)
        s.part("p").at(1, motif, beat=beat)
        return issues(s, "ERROR")

    def test_rebar_splits_with_ties(self):
        m = M("C4.hd D4.hd E4.h").rebar("4/4")
        self.assertEqual(m.text(), "C4.hd D4.q~ | D4.h E4.h |")
        self.assertEqual(self.errors(m), [])

    def test_rebar_marks_stay_and_rests_split(self):
        m = M('p C4.h R.w@ "x" D4.q ped').rebar("4/4")
        self.assertEqual(m.text(), 'p C4.h R.h | R.h@ "x" D4.q ped')
        self.assertEqual(self.errors(m), [])

    def test_rebar_replaces_old_bars(self):
        self.assertEqual(M("C4.h D4.h | E4.h").rebar("4/4").text(), "C4.h D4.h | E4.h")
        self.assertEqual(M("C4.h D4.h E4.h F4.h").rebar("2/4").text(), "C4.h | D4.h | E4.h | F4.h |")
        self.assertEqual(M("C4.q D4.q").rebar("4/4").text(), "C4.q D4.q")

    def test_rebar_pickup_and_other_meters(self):
        m = M("C4.q D4.h D4.h E4.q").rebar("3/4", start=2)        # begins on beat 3
        self.assertEqual(m.text(), "C4.q | D4.h D4.q~ | D4.q E4.q")
        self.assertEqual(self.errors(m, beat=3, meter=(3, 4)), [])
        m = M("C4.e D4.e E4.e F4.e G4.e A4.e B4.e C5.e").rebar("2+2+3/8")
        self.assertEqual(m.text().count("|"), 1)
        with self.assertRaises(ValueError):
            M("C4.q").rebar("4/4", start=4)

    def test_rebar_fermata_and_articulation_split(self):
        self.assertEqual(M("C4.q C4.wd>@").rebar("4/4").text(), "C4.q C4.hd>~ | C4.hd@")

    def test_expect(self):
        m = M("C4.q D4.q E4.q F4.q")
        self.assertIs(m.expect(bars=1), m)
        self.assertIs(m.expect(dur=4), m)
        with self.assertRaisesRegex(NotationError, "an eighth .* too long"):
            M("C4.q D4.q E4.q F4.q G4.e").expect(bars=1)
        with self.assertRaisesRegex(NotationError, "too short"):
            M("C4.w").expect(bars=2, meter="3/4")
        with self.assertRaisesRegex(NotationError, "a quarter .* too short"):
            m.expect(dur=5)
        with self.assertRaisesRegex(NotationError, "bar 1 has .* an eighth .* too long"):
            M("C4.q D4.q E4.q F4.q G4.e | C4.w").expect(bars=2)
        M("D4.h E4.q |").expect(bars=1, start=1)                  # a pickup of one beat
        with self.assertRaises(ValueError):
            m.expect()

    def test_generated_material_checks(self):
        cell = M("C4.q D4.q E4.q F4.q")
        gen = M(*(cell[:n] for n in range(1, 5))).rebar("4/4").expect(dur=10)
        self.assertEqual(self.errors(gen), [])


class TestDrift(unittest.TestCase):
    def build(self, ahead=Fraction(1, 4)):
        s = Score("d", meter=(4, 4), tempo=120)
        a, b = s.part("a", "marimba"), s.part("b", "marimba")
        for p in (a, b):
            p.at(1, M("C4.q D4.q E4.q F4.q |") * 8)
        b.drift(2, 6, ahead=ahead)
        return s, a, b

    def test_warp_function(self):
        from badmidi.perform import warp
        s, a, b = self.build()
        w = warp(b)
        self.assertEqual(w(Fraction(4)), 4)
        self.assertEqual(w(Fraction(12)), 12 + Fraction(1, 8))
        self.assertEqual(w(Fraction(20)), 20 + Fraction(1, 4))
        self.assertEqual(w(Fraction(28)), 28 + Fraction(1, 4))       # stays offset
        self.assertEqual(warp(a)(Fraction(12)), 12)

    def test_midi_is_warped_and_score_is_not(self):
        s, a, b = self.build()
        before = [(t, n) for t, n in b.events()]
        notes = read_notes(midi_bytes(s))
        ons = sorted(t for t, p, d in notes if t >= 20)
        # a plays on the beat; b ten bars later is a sixteenth (1/4 quarter) ahead
        self.assertIn(Fraction(20), ons)
        self.assertIn(Fraction(21, 1) + Fraction(1, 4), ons)
        self.assertEqual(before, [(t, n) for t, n in b.events()])
        self.assertTrue(all(t.denominator == 1 for t, p, d in score_notes(s)))   # written time is whole beats

    def test_behind_and_backwards(self):
        s, a, b = self.build(ahead=-Fraction(1, 4))
        notes = read_notes(midi_bytes(s))
        self.assertIn(Fraction(21) - Fraction(1, 4), [t for t, p, d in notes])
        with self.assertRaises(ValueError):
            b.drift(10, 11, ahead=-5)
        self.assertEqual(len(b.drifts), 1)               # the bad one was not kept
        with self.assertRaises(ValueError):
            b.drift(5, 5, ahead=1)

    def test_drift_returns_and_pedal_follows(self):
        s, a, b = self.build()
        b.drift(6, 8, ahead=-Fraction(1, 4))
        from badmidi.perform import warp
        self.assertEqual(warp(b)(Fraction(40)), 40)

    def test_written_views_unchanged_and_check_notes_it(self):
        s, a, b = self.build()
        s2, _, _ = self.build()
        s2.parts[1].drifts.clear()
        self.assertEqual(s.melody(), s2.melody())
        self.assertEqual(s.grid(), s2.grid())
        notes = [i for i in issues(s, "NOTE") if "drift" in i[3]]
        self.assertEqual(len(notes), 1)
        self.assertEqual(issues(s, "ERROR"), [])
        self.assertIn("1/16 ahead", notes[0][3])

    def test_engraving_and_verification(self):
        s, a, b = self.build()
        ly = lilypond(s)
        self.assertIn("gradually accel. (to 1/16 ahead)", ly)
        self.assertIn("\\startTextSpan", ly)
        s.parts[1].drifts[0].text = "slipping"
        self.assertIn('\\italic "slipping"', lilypond(s))
        d = tempfile.mkdtemp()
        try:
            engrave(s, str(Path(d) / "t.pdf"))          # raises if verification fails
            self.assertTrue((Path(d) / "t.pdf").exists())
        finally:
            shutil.rmtree(d)
        # verification compares the written rhythm, not the warped playback
        self.assertTrue(verify(s, midi_bytes(s)))          # the warped playback would not pass
        s.parts[1].drifts.clear()
        self.assertEqual(verify(s, midi_bytes(s)), [])      # unwarped playback is the written rhythm

    def test_drift_inside_a_loop_writes_it_out(self):
        s = Score(meter=(4, 4))
        a, b = s.part("a", "marimba"), s.part("b", "marimba")
        a.loop(1, "C4.w |", times=4)
        b.loop(1, "C4.w |", times=4)
        self.assertIn("repeat volta", lilypond(s))
        b.drift(2, 4, ahead=0.25)
        self.assertNotIn("repeat volta", lilypond(s))


class TestCollapse(unittest.TestCase):
    def score(self):
        s = Score(meter=(4, 4))
        a, b = s.part("a", "violin"), s.part("b", "cello")
        a.at(1, "G4.q A4.q E4.q F4.q | " * 6 + "G4.w |")
        b.at(1, "C3.q D3.q C3.h | " * 6 + "C3.w |")
        return s

    def test_lens_collapses_by_default(self):
        s = self.score()
        text = s.lens()
        self.assertIn("bars 2-6: same as 1", text)
        self.assertEqual(text.count("passing"), s.lens(bars=(1, 1)).count("passing"))
        full = s.lens(collapse=False)
        self.assertNotIn("same as", full)
        self.assertGreater(len(full.splitlines()), 3 * len(text.splitlines()) // 2)

    def test_lens_collapse_keeps_whatever_differs(self):
        s = Score(meter=(4, 4))
        s.part("a", "violin").at(1, "G4.q A4.q E4.q F4.q | " * 3 + "G4.q A4.q E4.q E4.q | G4.q A4.q E4.q F4.q |")
        s.part("b", "cello").at(1, "C3.q D3.q C3.h | " * 5)
        text = s.lens()
        self.assertIn("bars 2-3: same as 1", text)
        self.assertIn("-- 4 ", text)
        self.assertIn("-- 5 ", text)

    def test_grid_collapse(self):
        s = self.score()
        text = s.grid(collapse=True)
        self.assertIn("bars 2-6: same as 1", text)
        self.assertIn("-- 7 ", text)
        self.assertNotIn("same as", s.grid())
        self.assertEqual(s.grid(collapse=True, bars=(7, 7)).count("\n"), s.grid(bars=(7, 7)).count("\n"))

    def test_melody_collapse(self):
        s = self.score()
        text = s.melody(collapse=True)
        self.assertIn("bars 2-6: same as 1", text)
        self.assertIn("G4.w", text)
        self.assertNotIn("same as", s.melody())

    def test_cli_flags(self):
        import contextlib, io
        from badmidi.cli import main
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "piece.py"
            path.write_text("from badmidi import *\nscore = Score(meter=(4,4))\n"
                            "score.part('v','violin').at(1, 'G4.q A4.q E4.q F4.q | ' * 4)\n"
                            "score.part('c','cello').at(1, 'C3.q D3.q C3.h | ' * 4)\n")
            def run(*args):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    main([str(path), *args])
                return out.getvalue()
            self.assertIn("same as 1", run("lens"))
            self.assertNotIn("same as", run("lens", "--all"))
            self.assertNotIn("same as", run("grid"))
            self.assertIn("same as 1", run("grid", "--collapse"))
            self.assertIn("same as 1", run("melody", "--collapse"))


class TestLoops(unittest.TestCase):
    def pair(self, a_times=8, b_times=8, b_cell=CELL):
        s = Score("L", meter=(12, 16))
        a, b = s.part("a", "marimba"), s.part("b", "marimba")
        a.loop(1, CELL, times=a_times)
        b.loop(1, b_cell, times=b_times)
        return s, a, b

    def test_loops_play_and_show_in_full(self):
        s, a, b = self.pair()
        self.assertEqual(s.bars, 8)
        self.assertEqual(len([e for e in a.events() if not e[1].is_rest]), 8 * 12)
        self.assertEqual(s.melody().count("E4.s"), 2 * 8 * 2)
        self.assertEqual(s.time(9), s.end)
        self.assertEqual(len(read_notes(midi_bytes(s))), 2 * 8 * 12)
        self.assertEqual(issues(s, "ERROR"), [])

    def test_loop_chains_and_keeps_position(self):
        s = Score(meter=(4, 4))
        p = s.part("v", "violin")
        p.loop(2, "C4.w |", times=3).then("D4.w |")
        self.assertEqual([s.where(t) for t, _ in p.events()], ["2:1", "3:1", "4:1", "5:1"])

    def test_loop_validation(self):
        p = Score().part("v", "violin")
        with self.assertRaises(ValueError):
            p.loop(1, "C4.w |", times=1)
        with self.assertRaises(ValueError):
            p.loop(1, "C4.w |4", times=2)
        with self.assertRaises(ValueError):
            p.loop(1, times=2)

    def test_engraved_as_a_repeat(self):
        s, _, _ = self.pair()
        ly = s.lilypond()
        self.assertEqual(ly.count("\\repeat volta 8"), 4)          # global, tempo line, two staves
        self.assertIn('\\bold "\u00d78"', ly)
        self.assertIn("\\unfoldRepeats \\music", ly)
        self.assertEqual(ly.count("e'16 fs'16 b'16 cs''16 d''16 fs'16 e'16 cs''16 b'16 fs'16 d''16 cs''16 |"), 2)

    def test_plain_scores_keep_one_score_block(self):
        s = Score()
        s.part("v", "violin").at(1, "C4.w |")
        ly = s.lilypond()
        self.assertEqual(ly.count("\\score"), 1)
        self.assertNotIn("repeat", ly)

    @needs_lilypond
    def test_repeat_engraving_verifies_against_lilypond(self):
        with tempfile.TemporaryDirectory() as tmp:
            engrave(self.pair()[0], str(Path(tmp) / "r.pdf"))

    def test_bar_numbers_after_a_repeat_count_every_pass(self):
        s, a, b = self.pair()
        a.at(9, CELL)
        b.at(9, CELL)
        self.assertIn("\\set Score.currentBarNumber = #9", s.lilypond())

    def test_mismatched_parts_fall_back_to_writing_out(self):
        s, _, _ = self.pair(b_times=4)
        s["b"].at(5, CELL.replace("E4.s Fs4.s", "Fs4.s E4.s"), CELL, CELL, CELL)   # not the same as the first four
        notes = [m for lv, _, w, m in _issues(s) if lv == "NOTE" and "written out" in m]
        self.assertTrue(notes)
        self.assertEqual(issues(s, "ERROR"), [])
        ly = s.lilypond()
        self.assertEqual(ly.count("\\repeat volta 8"), 0)
        self.assertEqual(ly.count("\\repeat volta 4"), 4)           # the 4-pass loops the parts share

    def test_parts_may_play_different_things_if_each_repeats(self):
        rot = CELL.replace("E4.s Fs4.s", "Fs4.s E4.s")
        s, _, _ = self.pair(b_cell=rot)
        self.assertEqual(s.lilypond().count("\\repeat volta 8"), 4)
        self.assertNotIn("written out", check_text(s))

    def test_one_part_looping_while_another_plays_on(self):
        s = Score(meter=(4, 4))
        s.part("a", "violin").loop(1, "C5.w |", times=4)
        s.part("b", "cello").at(1, "C3.w | D3.w | E3.w | F3.w |")
        self.assertIn("written out", check_text(s))
        self.assertNotIn("\\repeat", s.lilypond())

    def test_loop_that_is_not_whole_bars(self):
        s = Score(meter=(4, 4))
        s.part("a", "violin").loop(1, "C5.h C5.h C5.h", times=4)     # 3 half notes: bars don't line up
        self.assertIn("barlines", check_text(s))
        self.assertNotIn("\\repeat", s.lilypond())

    def test_a_dynamic_at_the_start_does_not_spoil_the_repeat(self):
        s, a, b = self.pair()
        a.mark(1, "p")
        self.assertIn("\\repeat volta 8", s.lilypond())
        a.mark(3, "f")                       # one in the middle does
        self.assertNotIn("\\repeat volta 8", s.lilypond())

    def test_a_section_inside_a_loop_writes_it_out(self):
        s, _, _ = self.pair()
        s.section(1, "A").section(4, "B")
        self.assertNotIn("\\repeat volta 8", s.lilypond())
        self.assertIn("written out", check_text(s))

    @needs_lilypond
    def test_long_loops_engrave_quickly_and_verify(self):
        import time
        s = Score("Long", meter=(12, 16))
        for name in ("a", "b"):
            s.part(name, "marimba").loop(1, CELL, times=200)
        with tempfile.TemporaryDirectory() as tmp:
            t = time.time()
            engrave(s, str(Path(tmp) / "long.pdf"))
            self.assertLess(time.time() - t, 8)


def check_text(score):
    return score.check()


class TestExamples(unittest.TestCase):
    def test_examples_check_clean_and_round_trip(self):
        files = [_p for _p in sorted(EXAMPLES.glob("*.py")) if _p.name != "bass_for_take.py"]
        self.assertTrue(files)
        for f in files:
            with self.subTest(piece=f.name):
                sc = load_score(str(f))
                self.assertFalse(has_errors(sc))
                for p in sc.parts:
                    text = " | ".join(" ".join(c) for c in _bar_cells(sc, p, sc.bars))
                    copy = Score(sc.title, sc.meter, sc.tempo, sc.key).part(p.name, p.instrument).at(1, text)
                    sounding = lambda part: [(t, n.pitches, n.dur, n.art) for t, n in part.events() if not n.is_rest]
                    self.assertEqual(sounding(p), sounding(copy), p.name)
                    marks = lambda part: [(t, m) for t, m in part.marks(bm.Mark)]
                    self.assertEqual(marks(p), marks(copy), p.name)


if __name__ == "__main__":
    unittest.main()
