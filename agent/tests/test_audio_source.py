import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

try:
    import numpy as np
    import soundfile as sf
except ImportError:                                       # the core package needs neither
    np = None

from badmidi.bridge import BridgeError, SampleIncoming, Timeline

HERE = os.path.dirname(__file__)
if np is not None:
    from badmidi.audio import source

SR = 8000


def tl_of(case, ppq):
    regions = []
    for r in case["regions"]:
        regions.append(r)
    return Timeline({"meta": {"ppq": ppq}, "regions": regions})


@unittest.skipIf(np is None, "numpy/soundfile not installed")
class TestTimeline(unittest.TestCase):
    """badmidi's seconds arithmetic against shared/src/timemap.ts (tests/timemap_fixture.json, from gen_timemap_fixture.ts)."""

    def setUp(self):
        with open(os.path.join(HERE, "timemap_fixture.json")) as f:
            self.fx = json.load(f)
        self.cases = {k: v for k, v in self.fx.items() if isinstance(v, dict)}

    def test_matches_timemap_ts(self):
        for name, c in self.cases.items():
            tl = tl_of(c, self.fx["ppq"])
            with self.subTest(name):
                for tick, sec in c["ticks"]:
                    self.assertAlmostEqual(tl.seconds_at(tick), sec, delta=1e-6, msg=f"tick {tick}")
                for sec, tick in c["seconds"]:
                    self.assertAlmostEqual(tl.tick_at(sec), tick, delta=1e-6, msg=f"second {sec}")
                for bar, tick in c["bars"]:
                    self.assertAlmostEqual(float(tl.bar_start(bar)), tick, delta=1e-6)
                g = tl.beat_grid(1, c["toBar"])
                self.assertEqual(len(g), len(c["grid"]))
                for (s, t, is_bar), (xt, xs, xbar, xis) in zip(g, c["grid"]):
                    self.assertAlmostEqual(float(t), xt, delta=1e-6)
                    self.assertAlmostEqual(s, xs, delta=1e-6)
                    self.assertEqual(is_bar, xis)

    def test_round_trip_and_bar_of(self):
        for name, c in self.cases.items():
            tl = tl_of(c, self.fx["ppq"])
            with self.subTest(name):
                for tick in (0, 100, 3000, 12345, 45000):
                    self.assertAlmostEqual(tl.tick_at(tl.seconds_at(tick)), tick, delta=1e-6)
                for bar in range(1, c["toBar"]):
                    self.assertEqual(tl.bar_of(tl.bar_start(bar)), bar)

    def test_beats_are_the_meter_unit(self):
        g = tl_of(self.cases["meterChange"], 960).beat_grid(5, 6)          # one bar of 7/8: seven eighths
        self.assertEqual([t for _, t, _ in g], [11520 + 480 * k for k in range(7)])
        self.assertEqual([b for *_, b in g], [True] + [False] * 6)


def write_wav(path, x, sr=SR):
    sf.write(path, x, sr, subtype="FLOAT")
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class FakeClient:
    """Serves files from a directory by file:// URLs, as the agent route would serve signed URLs."""
    base = "http://localhost:1"

    def __init__(self, files=None, incoming=0):
        self.files, self.incoming, self.calls = files or {}, incoming, 0

    def sample_url(self, pid, hash):
        self.calls += 1
        if self.incoming > 0:
            self.incoming -= 1
            raise SampleIncoming("not yet")
        return "file://" + self.files[hash]


@unittest.skipIf(np is None, "numpy/soundfile not installed")
class TestSource(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cache = os.path.join(self.tmp, "cache")
        self.addCleanup(shutil.rmtree, self.tmp)

    def wav(self, name, x, sr=SR):
        p = os.path.join(self.tmp, name)
        return write_wav(p, x, sr), p

    def test_fetch_caches_and_verifies(self):
        h, p = self.wav("a.wav", np.linspace(-1, 1, 100))
        c = FakeClient({h: p})
        path = source.fetch(c, "pid", h, self.cache)
        self.assertEqual(path, os.path.join(self.cache, h))
        self.assertEqual(open(path, "rb").read(), open(p, "rb").read())
        source.fetch(c, "pid", h, self.cache)
        self.assertEqual(c.calls, 1, "second fetch is a cache hit")
        self.assertEqual(os.listdir(self.cache), [h], "no temp files left")

    def test_fetch_env_cache(self):
        h, p = self.wav("a.wav", np.zeros(10))
        with mock.patch.dict(os.environ, {"BADMIDI_CACHE": self.cache}):
            self.assertEqual(source.fetch(FakeClient({h: p}), "pid", h), os.path.join(self.cache, h))

    def test_fetch_hash_mismatch(self):
        h, p = self.wav("a.wav", np.zeros(10))
        _, other = self.wav("b.wav", np.ones(10))
        with self.assertRaisesRegex(BridgeError, "hash"):
            source.fetch(FakeClient({h: other}), "pid", h, self.cache)
        self.assertEqual(os.listdir(self.cache), [], "a bad download is not cached")

    def test_fetch_waits_for_an_incoming_sample(self):
        h, p = self.wav("a.wav", np.zeros(10))
        with mock.patch.object(source.time, "sleep") as sleep, mock.patch.object(source.time, "monotonic", side_effect=[0, 1, 2, 3, 4]):
            source.fetch(FakeClient({h: p}, incoming=2), "pid", h, self.cache, wait=30)
        self.assertEqual(sleep.call_count, 2)
        with self.assertRaises(SampleIncoming):
            source.fetch(FakeClient({h: p}, incoming=1), "pid", h, os.path.join(self.tmp, "c2"))

    def test_decode_downmix_resample(self):
        t = np.arange(SR * 2) / SR
        stereo = np.stack([np.sin(2 * np.pi * 440 * t), np.zeros_like(t)], axis=1)
        _, p = self.wav("s.wav", stereo)
        x = source.decode(p, 4000)
        self.assertEqual((x.dtype, len(x)), (np.float32, 8000))
        self.assertAlmostEqual(float(np.abs(x[500:-500]).max()), 0.5, delta=0.02)      # (L+R)/2

    def test_decode_ffmpeg_fallback(self):
        if not shutil.which("ffmpeg"):
            self.skipTest("no ffmpeg")
        t = np.arange(SR) / SR
        _, p = self.wav("t.wav", 0.5 * np.sin(2 * np.pi * 440 * t))
        for ext in ("m4a", "mp3", "ogg"):
            out = os.path.join(self.tmp, "t." + ext)
            r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", p, out], capture_output=True)
            if r.returncode:
                continue
            with self.subTest(ext), mock.patch.object(sf, "read", side_effect=RuntimeError("unknown format")):
                x = source.decode(out, 22050)
                self.assertAlmostEqual(len(x) / 22050, 1.0, delta=0.15)
                self.assertAlmostEqual(float(np.abs(x[2000:-2000]).max()), 0.5, delta=0.1)

    def test_decode_garbage(self):
        p = os.path.join(self.tmp, "x.bin")
        open(p, "wb").write(b"not audio at all" * 10)
        with self.assertRaisesRegex(BridgeError, "cannot decode"):
            source.decode(p)

    def test_clip_signal(self):
        src = np.arange(SR, dtype=np.float32) / SR                 # a 1 s ramp
        c = {"sourceOffsetSeconds": 0.25, "lengthSeconds": 0.5, "gain": 2}
        x = source.clip_signal(src, c, SR)
        self.assertEqual(len(x), SR // 2)
        np.testing.assert_allclose(x, 2 * src[SR // 4:SR // 4 + SR // 2])
        # looped: a 0.1 s pass from the offset, repeated to fill 0.35 s
        x = source.clip_signal(src, {"sourceOffsetSeconds": 0.5, "lengthSeconds": 0.35, "loopSeconds": 0.1, "gain": 1}, SR)
        one = src[4000:4800]
        np.testing.assert_allclose(x, np.concatenate([one, one, one, one])[:2800])
        # a loop at least as long as the clip is no loop; reading past the end is silence
        x = source.clip_signal(src, {"sourceOffsetSeconds": 0.75, "lengthSeconds": 0.5, "loopSeconds": 0.5, "gain": 1}, SR)
        np.testing.assert_allclose(x[:2000], src[6000:]); self.assertEqual(float(np.abs(x[2000:]).max()), 0)

    def test_track_audio_mixes_clips(self):
        src = np.full(SR, 0.5)
        h, p = self.wav("a.wav", src)
        clip = lambda i, s, ln, **kw: {"id": i, "kind": "audio", "startSeconds": s, "lengthSeconds": ln, "sourceHash": h,
                                       "sourceOffsetSeconds": 0, "gain": 1, **kw}
        state = {"tracks": [
            {"id": "t1", "name": "Guitar", "kind": "audio", "clips": [clip("a", 1.0, 0.5), clip("b", 1.25, 1.0, gain=0.5, loopSeconds=0.25)]},
            {"id": "t2", "name": "Keys", "kind": "audio", "clips": []}]}
        c = FakeClient({h: p})
        x, t0 = source.track_audio(c, "pid", state, "guitar", sr=SR, cache_dir=self.cache)
        self.assertEqual((t0, len(x), x.dtype), (1.0, int(1.25 * SR), np.float32))
        self.assertEqual(c.calls, 1, "one sample, fetched once")
        self.assertAlmostEqual(float(x[0]), 0.5)                       # only clip a
        self.assertAlmostEqual(float(x[int(0.3 * SR)]), 0.75)           # a + b
        self.assertAlmostEqual(float(x[int(0.6 * SR)]), 0.25)           # only b
        with self.assertRaisesRegex(BridgeError, "no audio clips"):
            source.track_audio(c, "pid", state, "Keys", sr=SR, cache_dir=self.cache)


if __name__ == "__main__":
    unittest.main()
