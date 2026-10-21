"""MusicXML reader tests.  Run with:  python -m unittest tests.test_musicxml_read

The proof: every example is written as MusicXML by our own writer, read back
by read_musicxml, built into a Score by build_score, and compared with the
original. Compared:

  * notes, per original part: the sounding events (onset, pitches with their
    spelling, duration, articulations; ties merged). Parts sharing a staff come
    back as voice lines of one track, so each original part is matched to the
    imported part with identical events (a one-to-one matching, not a union per staff);
  * markings, per group (a piano's hands share dynamics and pedal): dynamics
    exactly, hairpins as intervals, pedal as down/change/up, words;
  * tempo marks and ramps, sections (bar and description), the length of
    every bar, the key's signature and tonic, programs, clefs;
  * notes_moved == 0 and no ERROR from check.

Where exact equality is impossible the test says why, narrowly:
  * a section's label comes back as A, B, C... in order (MusicXML keeps the
    text, build_score names sections), so only bar and description compare;
  * a free bar is written with a hidden time signature of its own length, so it
    comes back as a metered bar of that length (same length, different Meter);
  * a harmonic or melodic minor key is written as "minor" (MusicXML has no
    such mode); the signature and tonic are what compare;
  * a drift (playback only) leaves its words over a dashed line, which come
    back as plain text at the start of the span; registration text likewise.
"""
import io
import unittest
import zipfile
from fractions import Fraction
from pathlib import Path

from badmidi import load_musicxml
from badmidi.cli import load_score
from badmidi.core import Mark, pc_name, spelling
from badmidi.ingest import build_score
from badmidi.lilypond import _clef
from badmidi.musicxml import import_musicxml, musicxml, read_musicxml, write_musicxml
from badmidi.views import has_errors

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def events(part, key):
    """(onset, ((midi, spelling) ...), duration, articulations) for a part, ties merged."""
    with spelling(key):
        return sorted((t, tuple(sorted((q.midi, q.spell or pc_name(q.pc)) for q in n.pitches)), n.dur,
                       "".join(sorted(n.art)))
                      for t, n in part.events() if not n.is_rest)


def match_parts(orig, got):
    """{original part: imported part} with identical events, one to one."""
    free = [(q, events(q, got.key)) for q in got.parts]
    out = {}
    for p in orig.parts:
        ev = events(p, orig.key)
        if not ev:
            continue
        for i, (q, qev) in enumerate(free):
            if qev == ev:
                out[p] = q
                del free[i]
                break
        else:
            raise AssertionError(f"no imported part has the events of {p.name!r}")
    return out


def hairpins(marks, total):
    """Hairpins as (start, end, kind), by the rule perform.py reads them with: a hairpin runs
    to the next dynamic, an explicit end, the next hairpin, or the end of the piece."""
    out, pending = [], None
    for t, m in sorted(marks, key=lambda x: x[0]):         # stable: a moment keeps its order
        if m.kind in ("dyn", "end", "cresc", "dim") and pending:
            if t > pending[0]:
                out.append((pending[0], t, pending[1]))
            pending = None
        if m.kind in ("cresc", "dim"):
            pending = (t, m.kind)
    if pending and total > pending[0]:
        out.append((pending[0], total, pending[1]))
    return out


def pedal(marks, total):
    out, down = [], False
    for t, m in sorted((x for x in marks if x[1].kind in ("ped", "pedup")), key=lambda x: x[0]):
        if m.kind == "ped":
            out.append((t, "change" if down else "down"))
            down = True
        elif down:
            out.append((t, "up"))
            down = False
    return out + ([(total, "up")] if down else [])


def group_marks(parts, extra=()):
    seen = []
    for p in parts:
        for tm in p.marks(Mark):
            if tm not in seen:
                seen.append(tm)
    return seen + list(extra)


def words_of(orig_parts, drifts=True):
    """Text marks, plus what the writer prints as words that are not marks: registration text
    (joined per staff and moment) and drift text."""
    out = []
    for p in orig_parts:
        out += [(t, m.value) for t, m in p.marks(Mark) if m.kind == "text"]
        if drifts:
            out += [(d.start, d.text) for d in p.drifts]
    staves = {}
    for p in orig_parts:
        for t, text, _ in p.registrations:
            staves.setdefault((p.staff, t), [])
            if text not in staves[(p.staff, t)]:
                staves[(p.staff, t)].append(text)
    return out + [(t, " / ".join(ts)) for (_, t), ts in staves.items()]


class TestExamples(unittest.TestCase):
    def check_example(self, path):
        orig = load_score(str(path))
        src = read_musicxml(musicxml(orig), "x")
        got, rep = build_score(src)
        self.assertEqual(rep.notes_moved, 0)
        self.assertFalse(has_errors(got))
        self.assertEqual(got.bars, orig.bars)
        mapping = match_parts(orig, got)

        # programs and clefs
        for p, q in mapping.items():
            self.assertEqual(q.program, p.program, p.name)
        with spelling(orig.key):
            for st in dict.fromkeys(p.staff for p in orig.parts):
                members = [p for p in orig.parts if p.staff == st]
                if members[0] in mapping:
                    q = mapping[members[0]]
                    self.assertEqual(_clef([x for x in got.parts if x.staff == q.staff]), _clef(members), st)

        # markings per group (a lone staff is its own group)
        total = orig.bar_start(orig.bars + 1)
        groups = {}
        for p in orig.parts:
            groups.setdefault(p.group or p.staff, []).append(p)
        for name, ps in groups.items():
            qs = list(dict.fromkeys(mapping[p] for p in ps if p in mapping))
            if not qs:
                continue
            want, have = group_marks(ps), group_marks(qs)
            dyns = lambda ms: sorted((t, m.value) for t, m in ms if m.kind == "dyn")
            self.assertEqual(dyns(have), dyns(want), f"{name}: dynamics")
            self.assertEqual(sorted(hairpins(have, total)), sorted(hairpins(want, total)), f"{name}: hairpins")
            self.assertEqual(pedal(have, total), pedal(want, total), f"{name}: pedal")
            tw = lambda ps_: sorted((t, w) for t, w in ps_)
            self.assertEqual(tw(words_of(qs, False)), tw(words_of(ps)), f"{name}: words")

        # tempo, sections, meters, key
        def tempos(score):
            """Tempo marks as written; one that repeats the tempo in force is only its words."""
            out, bpm = [], None
            for m in score.tempo_marks:
                new = m.bpm if m.bpm != bpm else None
                if m.gradual:
                    out.append((m.start, m.text, m.bpm, m.end))
                elif new or m.text or not out:
                    out.append((m.start, m.text, new, None))
                bpm = m.bpm or bpm
            return out
        self.assertEqual(tempos(got), tempos(orig))
        self.assertEqual([(s.bar, s.description or "") for s in got.sections],
                         [(s.bar, s.description or "") for s in orig.sections])
        for b in range(1, orig.bars + 1):
            a, c = orig.meter_at(b), got.meter_at(b)
            self.assertEqual(c.bar_len, a.bar_len, f"bar {b}")
            if a.free is None:
                self.assertEqual(c, a, f"bar {b}")
        self.assertEqual((got.key.signature, got.key.tonic), (orig.key.signature, orig.key.tonic))
        self.assertEqual(got.key.mode in ("minor",), orig.key.mode in ("minor", "harmonic minor", "melodic minor"))

    def test_every_example_comes_back(self):
        for path in [_p for _p in sorted(EXAMPLES.glob("*.py")) if _p.name != "bass_for_take.py"]:
            with self.subTest(example=path.name):
                self.check_example(path)


# --- another app's dialect -----------------------------------------------------------------

def el(tag, text=None, **attrs):
    a = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in attrs.items())
    return f"<{tag}{a}>{text}</{tag}>" if text is not None else f"<{tag}{a}/>"


def note(step, octave, dur, voice=1, staff=1, typ="quarter", alter=0, extra="", notations="", ties=()):
    pitch = el("step", step) + (el("alter", alter) if alter else "") + el("octave", octave)
    return ("<note>" + extra + f"<pitch>{pitch}</pitch>" + el("duration", dur)
            + "".join(f'<tie type="{t}"/>' for t in ties) + el("voice", voice) + el("type", typ)
            + el("staff", staff) + (f"<notations>{notations}</notations>" if notations else "") + "</note>")


def rest(dur, voice=1, staff=1, typ="quarter"):
    return f"<note><rest/>{el('duration', dur)}{el('voice', voice)}{el('type', typ)}{el('staff', staff)}</note>"


def direction(inner, staff=1, placement="below", extra=""):
    return f'<direction placement="{placement}"><direction-type>{inner}</direction-type>{extra}{el("staff", staff)}</direction>'


MUSESCORE_LIKE = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>Etude</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name>
      <midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument></score-part>
    <score-part id="P2"><part-name>Drums</part-name>
      <midi-instrument id="P2-I1"><midi-channel>10</midi-channel><midi-program>1</midi-program></midi-instrument></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>480</divisions><key><fifths>-3</fifths><mode>minor</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      %(rehearsal)s
      %(tempo)s
      %(mp)s
      %(cresc)s
      <note><grace/><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type><staff>1</staff></note>
      %(c5a)s
      %(c5b)s
      %(triplet)s
      %(cresc_stop)s
      <backup><duration>1920</duration></backup>
      %(g4)s
      %(g4rest)s
      <backup><duration>1920</duration></backup>
      %(ped)s
      %(c3)s
    </measure>
    <measure number="2">
      <attributes><key><fifths>2</fifths></key></attributes>
      %(bar2)s
      %(ped_up)s
    </measure>
  </part>
  <part id="P2">
    <measure number="1"><attributes><divisions>480</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1920</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2"><note><rest measure="yes"/><duration>1920</duration></note></measure>
  </part>
</score-partwise>
""" % dict(
    rehearsal=direction(el("rehearsal", "A"), placement="above"),
    tempo=direction("<metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome>", placement="above",
                    extra='<sound tempo="96"/>'),
    mp=direction("<dynamics><mp/></dynamics>"),
    cresc=direction('<wedge type="crescendo" number="1"/>'),
    c5a=note("C", 5, 480, ties=["start"], notations='<tied type="start"/><articulations><accent/></articulations>'),
    c5b=note("C", 5, 480, ties=["stop"], notations='<tied type="stop"/>'),
    triplet="".join(note("E", 5, 160, typ="eighth", extra="") .replace("<staff>", "<time-modification><actual-notes>3</actual-notes>"
                    "<normal-notes>2</normal-notes></time-modification><staff>") for _ in range(3))
            + note("F", 5, 480, alter=1, notations="<fermata/>"),
    cresc_stop=direction('<wedge type="stop" number="1"/>'),
    g4=note("G", 4, 960, voice=2, typ="half"),
    g4rest=rest(960, voice=2, typ="half"),
    ped=direction('<pedal type="start" line="yes"/>', staff=2),
    c3=note("C", 3, 1920, voice=5, staff=2, typ="whole"),
    bar2=note("B", 3, 1920, voice=5, staff=2, typ="whole", alter=-1, extra="") + "<backup><duration>1920</duration></backup>"
         + rest(1920, voice=1, typ="whole"),
    ped_up=direction('<pedal type="stop" line="yes"/>', staff=2),
)


def lines(score):
    return {p.name: events(p, score.key) for p in score.parts}


class TestForeign(unittest.TestCase):
    def setUp(self):
        self.src = read_musicxml(MUSESCORE_LIKE)
        self.score, self.rep = build_score(self.src)

    def test_structure(self):
        s, rep = self.score, self.rep
        self.assertEqual(s.title, "Etude")
        self.assertEqual([p.name for p in s.parts], ["piano 1", "piano 1 2", "piano 2"])
        self.assertEqual({p.group for p in s.parts}, {"Piano"})
        self.assertEqual((s.parts[0].clef, s.parts[2].clef), ("treble", "bass"))
        self.assertEqual((s.key.tonic, s.key.signature, s.key.mode), (0, -3, "minor"))   # C minor, first key only
        self.assertEqual(s.tempo, 96)
        self.assertEqual([(m.start, m.bpm) for m in s.tempo_marks], [(0, 96)])
        self.assertEqual([(x.bar, x.label) for x in s.sections], [(1, "A")])
        self.assertEqual(s.bars, 2)
        self.assertEqual(rep.notes_moved, 0)
        self.assertFalse(has_errors(s))
        self.assertTrue(any("1 grace notes" in n for n in rep.notes), rep.notes)
        self.assertTrue(any("drum" in n for n in rep.skipped), rep.skipped)
        self.assertTrue(any("key changes" in n for n in rep.notes), rep.notes)

    def test_notes(self):
        ev = lines(self.score)
        t = Fraction
        self.assertEqual(ev["piano 1"][0], (t(0), ((72, "C"),), t(2), ">"))       # tied pair is one half note
        self.assertEqual(ev["piano 1"][1:4], [(t(2) + t(k, 3), ((76, "E"),), t(1, 3), "") for k in range(3)])
        self.assertEqual(ev["piano 1"][4], (t(3), ((78, "F#"),), t(1), "@"))
        self.assertEqual(ev["piano 1 2"], [(t(0), ((67, "G"),), t(2), "")])         # voice 2 of staff 1
        self.assertEqual(ev["piano 2"], [(t(0), ((48, "C"),), t(4), ""), (t(4), ((58, "Bb"),), t(4), "")])

    def test_markings(self):
        top, low = self.score.parts[0], self.score.parts[2]
        self.assertEqual([(t, m.token) for t, m in top.marks(Mark)], [(0, "mp"), (0, "<"), (4, "!")])
        self.assertEqual([(t, m.token) for t, m in low.marks(Mark)], [(0, "ped"), (8, "*")])


class TestFormats(unittest.TestCase):
    def test_mxl(self):
        orig = load_score(str(EXAMPLES / "prelude.py"))
        data = musicxml(orig).encode("utf-8")
        for container in (True, False):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                if container:
                    z.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="deep/score.xml"/>'
                                                         "</rootfiles></container>")
                    z.writestr("deep/other.xml", "<nothing/>")
                    z.writestr("deep/score.xml", data)
                else:
                    z.writestr("META-INF/foo.xml", "<nothing/>")
                    z.writestr("score.musicxml", data)
            got = build_score(read_musicxml(buf.getvalue()))[0]
            self.assertEqual(lines(got), {k.replace("rh", "piano 1").replace("lh", "piano 2"): v
                                          for k, v in lines(orig).items()})

    def test_timewise_is_refused(self):
        with self.assertRaisesRegex(ValueError, "partwise"):
            read_musicxml('<?xml version="1.0"?><score-timewise version="4.0"><part-list/></score-timewise>')
        with self.assertRaisesRegex(ValueError, "not a MusicXML"):
            read_musicxml("<html/>")
        with self.assertRaisesRegex(ValueError, "not a MusicXML"):
            read_musicxml("garbage")

    def test_files_and_pickup(self):
        import tempfile
        xml = ('<score-partwise><part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>'
               '<part id="P1"><measure number="0" implicit="yes"><attributes><divisions>1</divisions>'
               '<time><beats>3</beats><beat-type>4</beat-type></time></attributes>' + note("A", 4, 1) + "</measure>"
               '<measure number="1">' + note("D", 5, 3, typ="half") + "</measure>"
               '<measure number="2">' + note("C", 5, 3, typ="half") + "</measure></part></score-partwise>")
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "tune.musicxml"
            path.write_text(xml, encoding="utf-8")
            score, rep = import_musicxml(str(path))
            self.assertIs(type(load_musicxml(str(path))), type(score))
        self.assertEqual(score.title, "tune")
        self.assertEqual([score.meter_at(b).text for b in (1, 2, 3)], ["1/4", "3/4", "3/4"])
        self.assertEqual(score.parts[0].instrument, "violin")
        self.assertFalse(has_errors(score))
        self.assertEqual(len(events(score.parts[0], score.key)), 3)

    def test_writer_output_is_valid_for_the_reader_after_write(self):
        import tempfile
        orig = load_score(str(EXAMPLES / "round.py"))
        with tempfile.TemporaryDirectory() as d:
            write_musicxml(orig, str(Path(d) / "r.musicxml"))
            got = load_musicxml(str(Path(d) / "r.musicxml"))
        self.assertEqual(sorted(lines(got).values()), sorted(events(p, orig.key) for p in orig.parts))


if __name__ == "__main__":
    unittest.main()
