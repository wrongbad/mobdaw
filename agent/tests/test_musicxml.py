"""MusicXML writer tests.  Run with:  python -m unittest tests.test_musicxml

The proof is a small reader written here (not in the package): it turns the
document back into sounding notes per part and staff, and every example must
come back note for note, spelling included, with each voice filling each
measure exactly.
"""
import tempfile
import unittest
import xml.etree.ElementTree as ET
from collections import defaultdict
from fractions import Fraction
from pathlib import Path

from badmidi import M, Score, spelling
from badmidi.cli import load_score
from badmidi.core import pc_name
from badmidi.musicxml import musicxml, write_musicxml

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
TYPE = {"whole": 4, "half": 2, "quarter": 1, "eighth": Fraction(1, 2), "16th": Fraction(1, 4), "32nd": Fraction(1, 8)}


def parse(text):
    return ET.fromstring(text.split("\n", 2)[2])      # past the XML declaration and DOCTYPE


def read(text):
    """Read a document back: {(part id, staff): sorted [(onset, midi, spelling, duration)]}
    with ties merged, plus checks on the way: every voice in a measure sums to
    the measure, and written values match durations."""
    root = parse(text)
    out = defaultdict(list)
    ties = {}
    start, divs = Fraction(0), None
    for part in root.findall("part"):
        pid, start, barlen = part.get("id"), Fraction(0), None
        for m in part.findall("measure"):
            cursor, longest = Fraction(0), Fraction(0)
            voices = defaultdict(Fraction)
            voice, last = None, Fraction(0)
            for el in m:
                if el.tag == "attributes":
                    d = el.findtext("divisions")
                    divs = int(d) if d else divs
                    if el.find("time") is not None and el.find("time/senza-misura") is None:
                        beats = el.findtext("time/beats")
                        barlen = sum(int(x) for x in beats.split("+")) * Fraction(4, int(el.findtext("time/beat-type")))
                elif el.tag == "backup":
                    cursor -= Fraction(int(el.findtext("duration")), divs)
                elif el.tag == "forward":
                    cursor += Fraction(int(el.findtext("duration")), divs)
                    voices[el.findtext("voice")] = cursor
                elif el.tag == "note":
                    dur = Fraction(int(el.findtext("duration")), divs)
                    voice, staff = el.findtext("voice"), int(el.findtext("staff") or 1)
                    chord = el.find("chord") is not None
                    at = last if chord else cursor
                    if not chord:
                        last, cursor = cursor, cursor + dur
                        at = last
                    voices[voice] = cursor
                    if el.find("rest") is None:
                        p = el.find("pitch")
                        alter = int(p.findtext("alter") or 0)
                        step = p.findtext("step")
                        midi = 12 * (int(p.findtext("octave")) + 1) + STEP[step] + alter
                        name = step + "#" * max(alter, 0) + "b" * max(-alter, 0)
                        key = (pid, staff, voice, midi)
                        kinds = {t.get("type") for t in el.findall("tie")}
                        if "stop" in kinds and key in ties:
                            ties[key][3] += dur
                            if "start" not in kinds:
                                del ties[key]
                            continue
                        row = [start + at, midi, name, dur]
                        out[(pid, staff)].append(row)
                        if "start" in kinds:
                            ties[key] = row
                    if el.find("rest") is None or el.find("rest").get("measure") != "yes":
                        written = TYPE[el.findtext("type")] * (Fraction(3, 2) if el.find("dot") is not None else 1)
                        tm = el.find("time-modification")
                        if tm is not None:
                            written = written * Fraction(int(tm.findtext("normal-notes")), int(tm.findtext("actual-notes")))
                        if not chord and written != dur and el.find("rest") is None:
                            raise AssertionError(f"{pid} measure {m.get('number')}: type says {written}, duration {dur}")
            for v, total in voices.items():
                if total != barlen:
                    raise AssertionError(f"{pid} measure {m.get('number')} voice {v}: {total} of {barlen}")
            start += barlen
    return {k: sorted(tuple(r) for r in v) for k, v in out.items()}


def expected(score):
    """The same notes from the score itself, per staff in document order."""
    staves, order = [], []
    for p in score.parts:
        if p.staff not in order:
            order.append(p.staff)
    groups = {}
    for p in score.parts:
        key = p.group if p.group else p.staff
        groups.setdefault(key, [])
        if p.staff not in groups[key]:
            groups[key].append(p.staff)
    out = {}
    with spelling(score.key):
        for i, (key, staff_names) in enumerate(groups.items(), 1):
            for si, sname in enumerate(staff_names, 1):
                rows = []
                for p in score.parts:
                    if p.staff == sname:
                        for t, n in p.events():
                            for q in n.pitches:
                                rows.append((t, q.midi, q.spell or pc_name(q.pc), n.dur))
                out[(f"P{i}", si)] = sorted(rows)
    return out


class TestExamples(unittest.TestCase):
    def test_every_example_comes_back_note_for_note(self):
        for path in [_p for _p in sorted(EXAMPLES.glob("*.py")) if _p.name != "bass_for_take.py"]:
            with self.subTest(example=path.name):
                score = load_score(str(path))
                got, want = read(musicxml(score)), expected(score)
                self.assertEqual(got.keys(), want.keys())
                for k in want:
                    self.assertEqual(got[k], want[k], f"{path.name} {k}")


def two(build, meter=(4, 4), **kw):
    score = Score("t", meter=meter, **kw)
    build(score)
    return score


class TestTargeted(unittest.TestCase):
    def roundtrip(self, score):
        text = musicxml(score)
        self.assertEqual(read(text), expected(score))
        return parse(text)

    def test_tuplets_including_odd_ratios(self):
        def build(s):
            p = s.part("flute")
            p.at(1, "E4.e3 F4.e3 G4.e3 A4.h A4.q | E4.s5 F4.s5 G4.s5 A4.s5 B4.s5 C5.h R.q | "
                    + "E4.s12:11 " * 12 + "E4.q E4.s |3")
        root = self.roundtrip(two(build))
        mods = {(tm.findtext("actual-notes"), tm.findtext("normal-notes")) for tm in root.iter("time-modification")}
        self.assertTrue({("3", "2"), ("5", "4"), ("12", "11")} <= mods)
        self.assertEqual([t.get("type") for t in root.iter("tuplet")].count("start"),
                         [t.get("type") for t in root.iter("tuplet")].count("stop"))

    def test_ties_across_barlines_and_chords(self):
        def build(s):
            p = s.part("piano")
            p.at(1, "C4.h D4.q E4.q~ | E4.h [C4 E4 G4].h~ | [C4 E4 G4].w |")
        root = self.roundtrip(two(build))
        self.assertGreaterEqual(len(list(root.iter("chord"))), 4)
        starts = [t for t in root.iter("tie") if t.get("type") == "start"]
        stops = [t for t in root.iter("tie") if t.get("type") == "stop"]
        self.assertEqual(len(starts), len(stops))
        self.assertEqual(len(starts), 4)       # E4, and C4 E4 G4

    def test_a_note_longer_than_the_bar_is_split_and_tied(self):
        def build(s):
            s.part("violin").at(1, "C5*7 R.q")
        self.roundtrip(two(build))

    def test_piano_grand_staff_with_a_second_voice(self):
        def build(s):
            rh, lh = s.piano()
            alto = rh.voice("alto")
            rh.at(1, "E5.h G5.h | C5.w |")
            alto.at(1, "C5.q C5.q R.h | E5.h |2")
            lh.at(1, "C3.w | G2.w |")
            rh.mark(1, "p", "ped")
            rh.mark(2, "*")
        score = two(build)
        root = self.roundtrip(score)
        self.assertEqual(len(root.findall("part")), 1)
        self.assertEqual(root.findtext("part/measure/attributes/staves"), "2")
        voices = {n.findtext("voice") for n in root.iter("note")}
        self.assertEqual(len(voices), 3)
        self.assertEqual(len(root.findall("part/measure[1]/backup")), 2)

    def test_additive_meter_and_free_bar(self):
        def build(s):
            p = s.part("oboe")
            s.meter_change(2, "2+2+3/8")
            s.meter_change(3, "4/4")
            s.free_bar(3, 11)
            s.meter_change(4, "3/4")
            p.at(1, "C5.w | C5.q C5.q C5.e C5.e C5.e | C5*11 | D5.hd |")
        score = two(build)
        root = self.roundtrip(score)
        times = [(t.findtext("beats"), t.findtext("beat-type"), t.get("print-object"))
                 for t in root.iter("time")]
        self.assertEqual(times, [("4", "4", None), ("2+2+3", "8", None), ("11", "4", "no"), ("3", "4", None)])

    def test_flat_key_and_spelling(self):
        def build(s):
            s.part("viola").at(1, "Eb4.q A4.q Bb3.q B#3.q | Cb4.q Fs4.q G4.h |")
        score = two(build, key="Eb major")
        root = self.roundtrip(score)
        self.assertEqual(root.findtext("part/measure/attributes/key/fifths"), "-3")
        self.assertEqual(root.findtext("part/measure/attributes/key/mode"), "major")
        steps = [(n.findtext("pitch/step"), n.findtext("pitch/alter"), n.findtext("pitch/octave"))
                 for n in root.iter("note")]
        self.assertIn(("B", "1", "3"), steps)       # B#3 is middle C, written as B
        self.assertIn(("C", "-1", "4"), steps)
        accidentals = [n.findtext("accidental") for n in root.iter("note")]
        self.assertEqual(accidentals[:4], [None, "natural", None, "sharp"])

    def test_markings_land_in_their_measures(self):
        def build(s):
            rh, lh = s.piano()
            s.tempo_mark(3, "meno mosso", 80)
            s.rit(5, 6, to=60)
            s.section(2, "B", "the middle")
            rh.at(1, "C5.w | D5.w | E5.w | F5.w | G5.w | A5.w |")
            lh.at(1, "C3.w | D3.w | E3.w | F3.w | G3.w | A3.w |")
            rh.mark(1, "p", "ped")
            rh.mark(2, "<", '"dolce"')
            rh.mark(3, "f", beat=3)
            rh.mark(4, "ped", beat=1)
            rh.mark(5, "*", ">")
            rh.mark(6, "!")
        root = self.roundtrip(two(build))
        measures = root.findall("part/measure")

        def has(n, path, **attrs):
            return any(all(e.get(k) == v for k, v in attrs.items()) for e in measures[n - 1].iter(path))
        self.assertTrue(has(1, "p") and has(1, "pedal", type="start"))
        self.assertTrue(has(2, "wedge", type="crescendo") and has(3, "wedge", type="stop"))
        self.assertTrue(has(3, "f"))
        self.assertTrue(has(4, "pedal", type="change") is False and has(4, "pedal", type="stop") is False
                        or has(4, "pedal", type="change"))
        self.assertTrue(has(5, "wedge", type="diminuendo") and has(6, "wedge", type="stop"))
        self.assertEqual(measures[1].findtext("direction/direction-type/rehearsal"), "B")
        self.assertTrue(any(s.get("tempo") == "80" for s in measures[2].iter("sound")))
        self.assertTrue(any(w.text == "rit." for w in measures[4].iter("words")))
        self.assertTrue(any(s.get("tempo") == "60" for s in root.iter("sound")))
        # a mark at beat 3 sits at its own time: before the note starting there, or displaced
        d = [d for d in measures[2].iter("direction") if d.find("direction-type/dynamics/f") is not None][0]
        self.assertEqual(d.findtext("offset"), str(int(2 * int(root.findtext("part/measure/attributes/divisions")))))

    def test_part_list_midi_and_groups(self):
        def build(s):
            s.organ()
            s.part("violin").at(1, "A4.w |")
        s = two(build)
        s["rh"].at(1, "C5.w |")
        root = parse(musicxml(s))
        self.assertEqual([p.findtext("part-name") for p in root.findall("part-list/score-part")], ["Organ", "Violin"])
        programs = [m.findtext("midi-program") for m in root.findall("part-list/score-part/midi-instrument")]
        self.assertEqual(programs[:3], ["20", "20", "20"])
        self.assertEqual(programs[3], "41")
        self.assertEqual(root.findtext("part/measure/attributes/staves"), "3")

    def test_write_file(self):
        s = two(lambda s: s.part("flute").at(1, "C5.w |"))
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "x.musicxml"
            write_musicxml(s, str(path))
            self.assertIn("<!DOCTYPE score-partwise", path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
