"""badmidi listen / pull --listen / push of heard parts, on a synthetic recording served by a fake client."""
import contextlib
import hashlib
import io
import os
import shutil
import tempfile
import unittest
from fractions import Fraction
from unittest import mock

try:
    import numpy as np
    import soundfile as sf
    import test_hear as th
    import test_hear_notes as thn
    from badmidi.audio import listen as L
except ImportError:                                       # the audio extra is optional
    np = None

from badmidi import bass
from badmidi.bridge import BridgeError, SampleIncoming, plan, pull, read_snapshot, snapshot_path, write_pulled
from badmidi.cli import load_score
from badmidi.views import has_errors

def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def read(path):
    with open(path) as f:
        return f.read()


PROG = ["Am", "F", "C", "G"]
PPQ = 960
SLOT = (0, 6, 8, 12)


def state_for(file_hash, seconds, bpm=th.BPM if np else 100, extra_tracks=()):
    bar = 4 * PPQ
    return {
        "rev": 3, "meta": {"ppq": PPQ, "sampleRate": 48000}, "name": "Take",
        "regions": [{"id": "default", "bar": 1, "kind": "metered", "bpm": bpm, "meter": "4/4", "beatTicks": PPQ, "barTicks": bar}],
        "markers": [], "master": {"devices": []},
        "samples": {file_hash: {"name": "take.wav", "duration": seconds, "mime": "audio/wav"}},
        "tracks": [{"id": "g1", "name": "Guitar", "kind": "audio", "devices": [], "clips": [
            {"id": "a1", "kind": "audio", "start": "1.1.0", "startTick": 0, "startSeconds": 0, "lengthSeconds": seconds,
             "sourceOffsetSeconds": 0, "sourceHash": file_hash, "sample": "take.wav", "gain": 1}]}, *extra_tracks],
    }


class FakeClient:
    base = "http://localhost:1"

    def __init__(self, files, incoming=0):
        self.files, self.incoming, self.calls = files, incoming, 0

    def sample_url(self, pid, h):
        self.calls += 1
        if self.incoming:
            raise SampleIncoming("not yet")
        return "file://" + self.files[h]

    def project_id(self, ref):
        return "pid"

    def state(self, pid, tracks=None, bars=None):
        return self._state


@unittest.skipIf(np is None, "numpy/scipy/soundfile not installed")
class TestListen(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cache = os.path.join(cls.tmp, "cache")
        x = th.render(PROG, th.pluck_note, SLOT, tempo=th.BPM)
        cls.wav = os.path.join(cls.tmp, "take.wav")
        sf.write(cls.wav, x, th.SR, subtype="PCM_16")
        cls.hash = sha(cls.wav)
        cls.seconds = len(x) / th.SR
        cls.bars_seconds = len(PROG) * 4 * 60 / th.BPM
        cls.state = state_for(cls.hash, cls.bars_seconds)
        cls.client = FakeClient({cls.hash: cls.wav})
        cls.res = L.listen(cls.client, "pid", cls.state, "Guitar", cache_dir=cls.cache)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def test_the_chart(self):
        txt = self.res.chart()
        self.assertTrue(self.res.ok, txt)
        self.assertRegex(txt.splitlines()[0], r"^Guitar \(audio, 1 take\), 4 bars, heard as chords \(auto: no single clear pitch, \d+% of the sound\), tuning \+\d+ c, key A minor, on the grid")
        for n, sym in enumerate(PROG, 1):
            self.assertRegex(txt, rf"\n +{n}  {sym} 0\.\d\d")
        self.assertIn("rhythm bar 1: | x... ..x. ", txt)           # strums on slots 0, 6, 8, 12

    def test_score_time(self):
        p = self.res.part
        self.assertEqual([c.symbol for c in p.chords], PROG)
        self.assertEqual([(c.start, c.end) for c in p.chords], [(4 * i, 4 * i + 4) for i in range(4)])
        self.assertEqual((p.part, p.bar, p.key), ("guitar (heard)", 1, "A minor"))
        self.assertEqual(list(p.rhythm.bars), [0, 4, 8, 12])
        self.assertEqual(p.chords[0].bass, 9)

    def test_bars_range_and_cache(self):
        c2 = FakeClient({})                                # nothing can be fetched: the first call cached the whole-take analysis only
        again = L.listen(self.client, "pid", self.state, "Guitar", cache_dir=self.cache)
        self.assertEqual(again.part.chords, self.res.part.chords)
        calls = self.client.calls
        L.listen(self.client, "pid", self.state, "Guitar", cache_dir=self.cache)
        self.assertEqual(self.client.calls, calls, "the second ask never touches the sample")
        part = L.listen(self.client, "pid", self.state, "Guitar", (2, 3), cache_dir=self.cache).part
        self.assertEqual([(c.symbol, c.start) for c in part.chords], [("F", 4), ("C", 8)])
        self.assertEqual(part.bar, 2)
        with self.assertRaises(SampleIncoming):
            L.listen(c2.__class__({}, incoming=1), "pid", self.state, "Guitar", (1, 2), cache_dir=os.path.join(self.tmp, "other"))

    def test_unknown_mode_is_refused(self):
        with self.assertRaisesRegex(BridgeError, "unknown mode"):
            L.listen(self.client, "pid", self.state, "Guitar", mode="duet", cache_dir=self.cache)

    def test_the_last_bar_is_left_out_when_the_audio_only_rings_into_it(self):
        def bars(extra):
            return L.audio_bars(L.Timeline(state_for(self.hash, self.bars_seconds + extra)), state_for(self.hash, self.bars_seconds + extra)["tracks"][0]["clips"])
        self.assertEqual(bars(0.0), (1, 4))
        self.assertEqual(bars(1.0), (1, 4), "a tail of under half a bar (1.2 s here) is the previous bar's decay")
        self.assertEqual(bars(1.5), (1, 5), "more than half a bar of audio is a bar")
        st = state_for(self.hash, self.bars_seconds + 1.0)
        res = L.listen(self.client, "pid", st, "Guitar", cache_dir=self.cache)
        self.assertEqual(res.bars, (1, 4))
        self.assertEqual([c.symbol for c in res.part.chords], PROG, "no extra chord for the tail")
        self.assertEqual(L.listen(self.client, "pid", st, "Guitar", (1, 5), cache_dir=self.cache).bars, (1, 5), "--bars asks for it")

    def test_the_cache_key_follows_the_code(self):
        grid = self.res.grid
        clips = self.state["tracks"][0]["clips"]
        a = L._key(clips, "auto", grid, 0.0)
        with mock.patch.object(L, "_code_version", return_value="edited"):
            self.assertNotEqual(a, L._key(clips, "auto", grid, 0.0))
        self.assertEqual(a, L._key(clips, "auto", grid, 0.0))
        self.assertNotEqual(a, L._key(clips, "auto", grid, 0.0, 8), "snap is an option")

    def test_compound_meter_hears_the_dotted_quarter(self):
        # 6/8 at 80 quarters a minute: a bar is 2.25 s, and the chords change once a bar
        x = th.render(PROG, th.pluck_note, (0, 8), tempo=640 / 6)
        wav = os.path.join(self.tmp, "six8.wav")
        sf.write(wav, x, th.SR, subtype="PCM_16")
        h = sha(wav)
        st = state_for(h, 4 * 2.25)
        st["regions"] = [{"id": "default", "bar": 1, "kind": "metered", "bpm": 80, "meter": "6/8", "beatTicks": PPQ // 2, "barTicks": 3 * PPQ}]
        res = L.listen(FakeClient({h: wav}), "pid", st, "Guitar", mode="chords", cache_dir=self.cache)
        self.assertEqual(len(res.grid.beats), 8, "two beats a bar, not six")
        self.assertEqual(res.part.rhythm.beat, Fraction(3, 2))
        self.assertEqual(len(res.part.rhythm.bars[0]), 12, "six 16ths in each dotted quarter")
        self.assertEqual([(c.symbol, c.start) for c in res.part.chords], [(s, 3 * i) for i, s in enumerate(PROG)])

    def run_cli(self, client, *args):
        cache = tempfile.mkdtemp(dir=self.tmp)
        out = io.StringIO()
        with mock.patch.object(L, "Client", return_value=client), mock.patch.dict(os.environ, {"BADMIDI_CACHE": cache}), \
                contextlib.redirect_stdout(out):
            try:
                code = L.main(["Take", "--track", "Guitar", *args])
            except SystemExit as e:
                code = e.code
        return code, out.getvalue()

    def test_cli(self):
        c = FakeClient({self.hash: self.wav})
        c._state = self.state
        code, out = self.run_cli(c, "--bars", "1-4")
        self.assertEqual(code, 0)
        self.assertIn("Guitar (audio, 1 take), 4 bars, heard as chords", out)
        self.assertIn("  4  G ", out)

    def test_cli_take_still_uploading(self):
        c = FakeClient({self.hash: self.wav}, incoming=5)
        c._state = self.state
        code, _ = self.run_cli(c)
        self.assertIn("still uploading", str(code))

    def test_cli_off_the_grid_fails_with_advice(self):
        x = th.render(PROG[:2], th.pluck_note, SLOT, tempo=th.BPM * 1.04)
        wav = os.path.join(self.tmp, "fast.wav")
        sf.write(wav, x, th.SR, subtype="PCM_16")
        h = sha(wav)
        c = FakeClient({h: wav})
        c._state = state_for(h, 2 * 4 * 60 / (th.BPM * 1.04))
        code, out = self.run_cli(c, "--bars", "1-2")
        self.assertEqual(code, 1)
        self.assertIn("OFF the grid", out)
        self.assertIn("Re-record it to the click", out)
        self.assertIn("tempo from loop", out)


@unittest.skipIf(np is None, "numpy/scipy/soundfile not installed")
class TestHeardInThePiece(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = TestListen
        TestListen.setUpClass.__func__(cls)
        cls.keys = {"id": "k1", "name": "Keys", "kind": "midi", "devices": [{"id": "d", "type": "finnwave", "typeId": 2, "params": {}}], "clips": [
            {"id": "c1", "kind": "midi", "start": "1.1.0", "startTick": 0, "lengthTicks": 4 * PPQ, "length": "1 bar", "end": "2.1.0",
             "notes": [{"id": "n1", "p": "C4", "pitch": 60, "t": 0, "d": PPQ, "v": 100}]}]}
        cls.state = state_for(cls.hash, cls.bars_seconds, extra_tracks=[cls.keys])
        cls.res = L.listen(cls.client, "pid", cls.state, "Guitar", cache_dir=cls.cache)

    tearDownClass = classmethod(lambda cls: shutil.rmtree(cls.tmp))

    def piece(self):
        p = pull(self.state, "P", None, [self.res.part])
        path = os.path.join(self.tmp, "piece.py")
        write_pulled(p, path, "test")
        self.addCleanup(lambda: [os.remove(f) for f in (path, snapshot_path(path)) if os.path.exists(f)])
        return p, path

    def test_pull_writes_the_heard_part_and_HEARD(self):
        p, path = self.piece()
        src = read(path)
        self.assertIn("HEARD = {", src)
        self.assertIn("from badmidi import bass", src)
        self.assertIn('HeardChord(0, 4, "Am", 9, 9, "min"', src)
        score = load_score(path)
        self.assertFalse(has_errors(score), score.check())
        self.assertEqual([x.name for x in score.parts], ["keys", "guitar (heard)"])
        import runpy
        heard = runpy.run_path(path, run_name="__badmidi__")["HEARD"]["guitar"]
        self.assertEqual([c.symbol for c in heard.chords], PROG)
        self.assertEqual(heard.chords, self.res.part.chords)
        self.assertEqual(heard.rhythm.bars.keys(), self.res.part.rhythm.bars.keys())
        notes = [(on, [q.midi for q in n.pitches]) for on, n in score["guitar (heard)"].events()]
        self.assertEqual([on for on, _ in notes], [0, 4, 8, 12], "one block chord per span")
        self.assertEqual(min(notes[0][1]) % 12, 9, "the bass pitch class is lowest")
        grid = score.grid(parts=["guitar (heard)"])
        self.assertIn("Am", grid)
        self.assertIn("1", score.lens())
        self.assertTrue(plan(score, read_snapshot(snapshot_path(path))).empty, "a heard part is not a change")

    def test_excerpt(self):
        _, path = self.piece()
        src = read(path)
        i = src.index("HEARD = {")
        print("\n" + src[i:i + 900] + "\n...") if os.environ.get("VERBOSE") else None

    def test_push_refuses_edits_to_a_heard_part_and_drafts_a_bass(self):
        _, path = self.piece()
        snap = read_snapshot(snapshot_path(path))
        score = load_score(path)
        score["guitar (heard)"].clear(2, 2).at(2, "A3.w |")
        with self.assertRaisesRegex(BridgeError, "what the recording says"):
            plan(score, snap)
        score = load_score(path)
        import runpy
        heard = runpy.run_path(path, run_name="__badmidi__")["HEARD"]["guitar"]
        score.part("bass guitar").at(heard.bar, bass.line(heard, style="walk", key=score.key))
        self.assertFalse(has_errors(score), score.check())
        pl = plan(score, snap, sound="bass")
        self.assertEqual([o["op"] for o in pl.ops], ["addTrack", "addDevice", "addMidiClip", "addNotes"])
        self.assertEqual(pl.ops[0], {"op": "addTrack", "name": "bass guitar", "preset": "none"})
        dev = pl.ops[1]
        self.assertEqual((dev["trackId"], dev["type"], dev["name"]), ("$0", "finnwave", "bass"))
        self.assertEqual(set(dev["params"]), {"rolloff", "env→rolloff", "attack", "decay", "sustain", "release", "gain"})
        self.assertEqual(pl.ops[2]["trackId"], "$0")
        self.assertEqual(pl.ops[3]["clipId"], "$2")
        self.assertEqual(len(pl.ops[3]["notes"]), 16)
        self.assertEqual(pl.new_tracks, 1, "the heard part is not a new track")
        with self.assertRaisesRegex(BridgeError, "alternatives"):
            plan(score, snap, sound="bass", preset="bore")
        with self.assertRaisesRegex(BridgeError, "unknown patch"):
            plan(score, snap, sound="kazoo")

    def test_guide_pushes_the_heard_part_muted(self):
        _, path = self.piece()
        snap = read_snapshot(snapshot_path(path))
        pl = plan(load_score(path), snap, guide=True)
        self.assertEqual([o["op"] for o in pl.ops][:2], ["addTrack", "updateTrack"])
        self.assertEqual(pl.ops[0]["name"], "Guitar (heard)")
        self.assertEqual(pl.ops[1], {"op": "updateTrack", "id": "$0", "muted": True})
        self.assertEqual(pl.guided, ["guitar (heard)"])


@unittest.skipIf(np is None, "numpy/scipy/soundfile not installed")
class TestListenNotes(unittest.TestCase):
    """A sung line: listen (auto and --as notes), pull --listen, HEARD, bass.line, push."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cache = os.path.join(cls.tmp, "cache")
        cls.wav = os.path.join(cls.tmp, "voice.wav")
        sf.write(cls.wav, thn.sung(th.BPM), th.SR, subtype="PCM_16")
        cls.hash = sha(cls.wav)
        cls.state = state_for(cls.hash, 4 * 4 * 60 / th.BPM)
        cls.state["tracks"][0]["name"] = "Voice"
        cls.client = FakeClient({cls.hash: cls.wav})
        cls.client._state = cls.state
        cls.res = L.listen(cls.client, "pid", cls.state, "Voice", cache_dir=cls.cache)

    tearDownClass = classmethod(lambda cls: shutil.rmtree(cls.tmp))

    def test_auto_hears_a_notes_chart(self):
        txt = self.res.chart()
        self.assertTrue(self.res.ok, txt)
        self.assertRegex(txt.splitlines()[0], r"^Voice \(audio, 1 take\), 4 bars, heard as notes \(auto: one clear pitch in \d+% of the sound\), tuning \+1\d c, key A minor, on the grid")
        self.assertRegex(txt, r"\n  1  A3\.q C4\.e E4\.e A4\.qd G4\.e +\| guess: Am")
        self.assertRegex(txt, r"\n  4  A3\.q A4\.q A3\.q A3\.q")
        self.assertIn("NOT heard", txt)
        self.assertIn("rhythm bar 1:", txt)

    def test_the_part_in_score_time(self):
        p = self.res.part
        self.assertEqual((p.mode, p.part, p.bar, p.key), ("notes", "voice (heard)", 1, "A minor"))
        self.assertEqual([(n.start, n.end, n.pitch) for n in p.notes[:4]], [(0, 1, 57), (1, Fraction(3, 2), 60), (Fraction(3, 2), 2, 64), (2, Fraction(7, 2), 69)])
        self.assertTrue(all(abs(n.raw - float(n.start)) < 0.25 for n in p.notes), "the raw onset is kept beside the quantized one")
        self.assertEqual(len(p.chords), 4)
        self.assertTrue(all(c.src == "melody" and c.conf <= 0.4 for c in p.chords))
        self.assertEqual([c.symbol for c in p.chords][:1], ["Am"])

    def test_explicit_modes_and_cache(self):
        calls = self.client.calls
        again = L.listen(self.client, "pid", self.state, "Voice", cache_dir=self.cache)
        self.assertEqual(again.part.notes, self.res.part.notes)
        self.assertEqual(self.client.calls, calls, "cached, with Fractions round-tripped through the json")
        notes = L.listen(self.client, "pid", self.state, "Voice", mode="notes", cache_dir=self.cache)
        self.assertIsNone(notes.heard.decision)
        self.assertNotIn("(auto", notes.chart().splitlines()[0])
        chords = L.listen(self.client, "pid", self.state, "Voice", mode="chords", cache_dir=self.cache)
        self.assertEqual(chords.part.mode, "chords")
        self.assertEqual(chords.part.notes, [])

    def test_cli(self):
        buf = io.StringIO()
        with mock.patch.object(L, "Client", return_value=self.client), mock.patch.dict(os.environ, {"BADMIDI_CACHE": self.cache}), \
                contextlib.redirect_stdout(buf):
            self.assertEqual(L.main(["Take", "--track", "Voice", "--as", "notes", "--snap", "8"]), 0)
        self.assertIn("heard as notes, ", buf.getvalue())
        self.assertRegex(buf.getvalue(), r"\n  1  A3\.q C4\.e E4\.e A4\.qd G4\.e")
        self.assertIn("rhythm bar 1: | x. xx x. .x |", buf.getvalue(), "--snap 8: a slot is an eighth")
        with self.assertRaises(SystemExit) as e:
            with mock.patch.object(L, "Client", return_value=self.client):
                L.main(["Take", "--track", "Voice", "--snap", "5"])
        self.assertIn("does not divide", str(e.exception))

    def piece(self):
        p = pull(self.state, "P", None, [self.res.part])
        path = os.path.join(self.tmp, "melody.py")
        write_pulled(p, path, "test")
        self.addCleanup(lambda: [os.remove(f) for f in (path, snapshot_path(path)) if os.path.exists(f)])
        return p, path

    def test_pull_writes_the_notes_and_a_bass_can_be_drafted(self):
        p, path = self.piece()
        self.assertIn("heard: 'voice (heard)'", "\n".join(p.report))
        self.assertIn("notes", "\n".join(p.report))
        src = read(path)
        self.assertIn("HeardNote(0, 1, 57, ", src)
        self.assertIn('mode="notes"', src)
        self.assertIn('src="melody"', src)
        score = load_score(path)
        self.assertFalse(has_errors(score), score.check())
        import runpy
        heard = runpy.run_path(path, run_name="__badmidi__")["HEARD"]["voice"]
        self.assertEqual(heard.notes, self.res.part.notes)
        self.assertEqual(heard.chords, self.res.part.chords)
        ev = [(on, [q.midi for q in n.pitches]) for on, n in score["voice (heard)"].events() if not n.is_rest]
        self.assertEqual(ev[0], (0, [57]))
        self.assertEqual(len(ev), len(heard.notes))
        score.part("bass guitar").at(heard.bar, bass.line(heard, style="roots", key=score.key))
        self.assertFalse(has_errors(score), score.check())
        pl = plan(score, read_snapshot(snapshot_path(path)), sound="bass")
        self.assertEqual(pl.new_tracks, 1, "the heard part is not a new track")
        self.assertEqual(pl.ops[0]["name"], "bass guitar")

    def test_push_skips_guards_and_guides_the_heard_notes(self):
        _, path = self.piece()
        snap = read_snapshot(snapshot_path(path))
        self.assertTrue(plan(load_score(path), snap).empty)
        score = load_score(path)
        score["voice (heard)"].clear(2, 2).at(2, "A3.w |")
        with self.assertRaisesRegex(BridgeError, "what the recording says"):
            plan(score, snap)
        pl = plan(load_score(path), snap, guide=True)
        self.assertEqual(pl.ops[0]["name"], "Voice (heard)")
        self.assertEqual(pl.ops[1], {"op": "updateTrack", "id": "$0", "muted": True})
        self.assertEqual(sum(len(o["notes"]) for o in pl.ops if o["op"] == "addNotes"), len(self.res.part.notes))


if __name__ == "__main__":
    unittest.main()
