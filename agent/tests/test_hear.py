"""badmidi.audio.hear on synthetic audio: pads, Karplus-Strong strums, distorted power chords, and open-position guitar (tests/synth.py)."""
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))     # synth.py, whichever way the tests are started

try:
    import numpy as np
    from scipy.signal import fftconvolve, resample_poly
    import synth
    from badmidi.audio import hear
    from badmidi.audio.hear import SR, Grid
    from badmidi.heard import HeardChord, is_unsure
except ImportError:  # the audio extra is optional
    np = None

SLOW = unittest.skipUnless(os.environ.get("SLOW"), "set SLOW=1")
BPM = 100
BEAT = 60 / BPM
DETUNE = 15  # cents, global

PCS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
QUAL = {"": (0, 4, 7), "m": (0, 3, 7), "7": (0, 4, 7, 10), "maj7": (0, 4, 7, 11), "m7": (0, 3, 7, 10),
        "sus4": (0, 5, 7), "5": (0, 7)}
QNAME = {"": "maj", "m": "min", "7": "7", "maj7": "maj7", "m7": "m7", "sus4": "sus4", "5": "5"}


def parse(sym):
    root = PCS[sym[0]]
    rest = sym[1:]
    if rest[:1] in "#b" and rest[:1]:
        root += 1 if rest[0] == "#" else -1
        rest = rest[1:]
    return root % 12, rest


def voicing(sym, rng):
    """A guitar-ish voicing: bass in E2..D#3, then chord tones climbing to about C5."""
    root, q = parse(sym)
    iv = QUAL[q]
    bass = 40 + (root - 40) % 12
    notes = [bass]
    cur = bass
    for k in range(1, 6):
        pc = (root + iv[k % len(iv)]) % 12
        cur += (pc - cur) % 12 or 12
        if k == 1 and len(iv) > 2:        # skip an octave so strings are spread
            pass
        notes.append(cur)
    return notes[: (3 if len(iv) == 2 else 6)]


def hz(m):
    return 440 * 2 ** ((m - 69 + DETUNE / 100) / 12)


def env(n, a=0.02, r=0.1):
    e = np.ones(n)
    na, nr = int(a * SR), int(r * SR)
    e[:na] = np.linspace(0, 1, na)
    e[-nr:] = np.minimum(e[-nr:], np.linspace(1, 0, nr))
    return e


def pad_note(m, dur, rng):
    t = np.arange(int(dur * SR)) / SR
    f = hz(m)
    y = sum(np.sin(2 * np.pi * f * k * t + rng.uniform(0, 6.28)) * k ** -1.1 * np.exp(-0.15 * k * t) for k in range(1, 13) if f * k < 10000)
    return y * env(len(t), 0.03, 0.15)


def pluck_note(m, dur, rng):
    """Karplus-Strong at 4x rate (for tuning accuracy), block-vectorised."""
    fs = SR * 4
    N = int(round(fs / hz(m)))
    n = int(dur * fs)
    y = np.zeros(n + N + 1)
    y[:N] = rng.uniform(-1, 1, N)
    y[:N] -= y[:N].mean()
    for s in range(N, n, N):
        prev = y[s - N:s]
        y[s:s + N] = 0.5 * 0.996 * (prev + np.r_[y[s - N - 1:s - N] if s > N else [0.0], prev[:-1]])
    out = resample_poly(y[:n], 1, 4)
    return out * env(len(out), 0.002, 0.05)


def dist_note(m, dur, rng):
    t = np.arange(int(dur * SR)) / SR
    f = hz(m)
    saw = sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, 20) if f * k < 10000)
    return np.tanh(6 * saw) * np.exp(-0.5 * t) * env(len(t), 0.005, 0.08)


def render(prog, voice, strums=(0,), bars_per_chord=1, strum_gap=0.012, tempo=BPM, noise=0.01, wet=0.3,
           seed=1, tail=1.0):
    """prog: chord symbols, one per bar. strums: 16th slots in the bar where the chord is struck."""
    rng = np.random.default_rng(seed)
    beat = 60 / tempo
    n = int((len(prog) * 4 * beat + tail) * SR)
    x = np.zeros(n)
    slot = beat / 4
    for b, sym in enumerate(prog):
        notes = voicing(sym, rng)
        for si in strums:
            t0 = b * 4 * beat + si * slot
            nxt = min([s for s in strums if s > si] + [16]) * slot + b * 4 * beat
            dur = max(nxt - t0 + 0.3, 0.4)
            for k, m in enumerate(notes):
                y = voice(m, dur, rng) * (0.8 + 0.4 * rng.random())
                i = max(int((t0 + k * strum_gap + rng.normal(0, 0.002)) * SR), 0)
                y = y[: n - i]
                x[i:i + len(y)] += y
    ir_t = np.arange(int(0.5 * SR)) / SR
    ir = rng.normal(size=len(ir_t)) * np.exp(-ir_t / 0.12)
    ir[0] = 0
    wetx = fftconvolve(x, ir)[:n]
    x = x / np.abs(x).max()
    wetx = wetx / max(np.abs(wetx).max(), 1e-9)
    y = x + wet * wetx + noise * rng.normal(size=n)
    return (y / np.abs(y).max()).astype(np.float32)


def truth(prog, per_bar=4):
    return [parse(s) + (s,) for s in prog for _ in range(per_bar)]


def score_beats(h, prog):
    exp = truth(prog)
    got = {}
    for c in h.chords:
        for i in range(c.start_beat, c.end_beat):
            got[i] = c
    root = qual = 0
    for i, (r, q, _) in enumerate(exp):
        c = got.get(i)
        if c and c.root_pc == r:
            root += 1
            qual += c.quality == QNAME[q]
    return root / len(exp), qual / len(exp)


def grid_for(prog, tempo=BPM):
    return Grid.regular(tempo, 4, len(prog) * 4)


class TestCoreImport(unittest.TestCase):
    def test_core_needs_no_numpy(self):
        code = "import sys, badmidi, badmidi.cli, badmidi.bridge; sys.exit('numpy' in sys.modules)"
        r = subprocess.run([sys.executable, "-c", code], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        self.assertEqual(r.returncode, 0)


@unittest.skipIf(np is None, "numpy/scipy not installed")
class TestHearUnits(unittest.TestCase):
    def test_prepare(self):
        x = np.random.default_rng(0).normal(size=(44100, 2)).astype(np.float32)
        y = hear.prepare(x, 44100)
        self.assertEqual(y.shape, (22050,))
        self.assertEqual(y.dtype, np.float32)

    def test_templates_on_hand_built_chroma(self):
        for sym in ["C", "Am", "G7", "Cmaj7", "Dm7", "Dsus4", "E5", "Bdim"]:
            r, q = parse(sym) if sym != "Bdim" else (11, "dim")
            ch = np.zeros((6, 12))
            for iv, w in hear.QUALITIES[QNAME.get(q, q)][1]:
                ch[:, (r + iv) % 12] = w
            silent = np.zeros(6, bool)
            spans, _ = hear.hear_chords_from_chroma(ch, ch * 0, silent, Grid.regular(100, 4, 6))
            self.assertEqual(len(spans), 1, sym)
            self.assertEqual(spans[0].symbol, hear.symbol(r, QNAME.get(q, q)), sym)

    def test_viterbi_penalty_smooths_a_blip(self):
        E = np.zeros((8, 2))
        E[:, 0] = 1
        pen = np.full(8, 1.6)
        E[3] = [0.5, 1.5]                          # one beat leans to state 1
        self.assertEqual(hear._viterbi(E, pen).tolist(), [0] * 8)
        E[3] = [0.0, 5.0]
        self.assertEqual(hear._viterbi(E, pen).tolist(), [0, 0, 0, 1, 0, 0, 0, 0])

    def test_change_on_a_bar_line_is_cheaper(self):
        ch = np.zeros((8, 12))
        ch[:, [0, 4, 7]] = 1
        ch[4:, [0, 4, 7]] = 0
        ch[4:, [7, 11, 2]] = 1                     # G from beat 4
        spans, _ = hear.hear_chords_from_chroma(ch, ch * 0, np.zeros(8, bool), Grid.regular(100, 4, 8))
        self.assertEqual([(c.symbol, c.start_beat) for c in spans], [("C", 0), ("G", 4)])

    def test_silence_is_N(self):
        x = np.zeros(SR * 4, np.float32)
        h = hear.hear_chords(x + 1e-6, SR, Grid.regular(120, 4, 8))
        self.assertTrue(all(c.symbol == "N" for c in h.chords))

    def test_key_profiles(self):
        v = np.zeros((1, 12))
        v[0, [9, 0, 4, 11, 2, 5]] = [3, 1, 2, 1, 1, 1]       # A minor-ish
        self.assertEqual(hear.estimate_key(v).name, "A minor")
        self.assertEqual(hear.estimate_key(np.roll(v, 1, axis=1)).name, "A# minor" if False else "Bb minor")

    def test_key_from_the_chord_sequence(self):
        """Relative keys share every chord; the opening chord, the time on the tonic and a V-I cadence decide."""
        for prog, key in (("Am F C G", "A minor"), ("C G Am F", "C major"), ("Em C G D", "E minor"), ("G Em C D", "G major"),
                          ("Am Dm E Am", "A minor"), ("D A Bm G", "D major"), ("A7 D7 A7 E7 D7 A7", "A major")):
            syms = (prog.split() * 2)
            spans, rows = [], []
            for i, sym in enumerate(syms):
                r, q = synth.parse(sym)
                spans.append(hear.ChordSpan(i * 4, i * 4 + 4, sym, r, q, r, 1.0))
                rows.append(sum(hear._TEMPLATES[r * len(hear.NAMES) + hear.NAMES.index(q)] for _ in range(4)))
            chroma = np.array(rows)
            self.assertEqual(hear.key_from_chords(spans, chroma).name, key, prog)

    def test_grid_check_ignores_the_late_strings_of_a_slow_strum(self):
        grid = Grid.regular(90, 4, 16)
        slot = 60 / 90 / 4
        t = [i * slot * 4 + 0.008 for i in range(16)]
        t += [x + 0.075 for x in t[::3]]                  # a late string every third strum: nearly half a slot out
        g = hear.grid_check(sorted(t), grid)
        self.assertTrue(g.on_grid, g)
        self.assertLess(abs(g.drift), 0.03)

    def test_grid_check_on_clicks(self):
        grid = Grid.regular(120, 4, 16)
        on = [i * 0.125 + 0.01 for i in range(60)]
        self.assertTrue(hear.grid_check(on, grid).on_grid)
        late = [t + 0.04 for t in on]
        g = hear.grid_check(late, grid)
        self.assertFalse(g.on_grid)
        self.assertAlmostEqual(g.mean_offset, 0.05, delta=0.005)
        stretched = [i * 0.125 * 1.03 for i in range(60)]
        self.assertFalse(hear.grid_check(stretched, grid).on_grid)
        faster = [i * 0.125 / 1.03 for i in range(60)]
        self.assertFalse(hear.grid_check(faster, grid).on_grid)

    def test_onsets_of_clicks(self):
        x = np.zeros(SR * 3, np.float32)
        times = [0.5, 1.0, 1.25, 2.0]
        for t in times:
            i = int(t * SR)
            x[i:i + 400] = np.random.default_rng(1).normal(size=400) * np.exp(-np.arange(400) / 80)
        o = hear.onsets(x)
        self.assertEqual(len(o.times), 4)
        for got, want in zip(o.times, times):
            self.assertAlmostEqual(got, want, delta=0.02)

    def test_odd_meter_grid(self):
        g = Grid([0, .5, 1.1, 1.6, 2.1, 2.6, 3.1], [True, False, False, True, False, False, False])
        self.assertEqual(g.bars(), [(0, 3), (3, 7)])
        self.assertEqual([g.position(i) for i in range(7)], [0, 1, 2, 0, 1, 2, 3])


@unittest.skipIf(np is None, "numpy/scipy not installed")
class TestHear(unittest.TestCase):
    heard = {}

    @classmethod
    def setUpClass(cls):
        am = ["Am", "F", "C", "G"] * 2
        ii = ["Dm7", "G7", "Cmaj7", "Cmaj7"] * 2
        pw = ["E5", "E5", "G5", "A5", "E5", "D5", "G5", "E5"]
        cls.cases = {
            "pad Am F C G": (am[:4], render(am[:4], pad_note, (0,)), "A minor"),
            "strum Am F C G": (am, render(am, pluck_note, (0, 6, 8, 12)), "A minor"),
            "ii-V-I 7ths": (ii, render(ii, pluck_note, (0, 8)), "C major"),
            "power E5": (pw, render(pw, dist_note, (0, 6, 8, 12), strum_gap=0.006), "E minor"),
        }
        cls.heard = {k: hear.hear_chords(x, SR, grid_for(p)) for k, (p, x, _) in cls.cases.items()}

    def test_tuning(self):
        for name, h in self.heard.items():
            self.assertAlmostEqual(h.tuning_cents, DETUNE, delta=5, msg=f"{name}: {h.tuning_cents:.1f}")

    def test_chords_and_key(self):
        for name, (prog, x, key) in self.cases.items():
            with self.subTest(name):
                h = self.heard[name]
                r, q = score_beats(h, prog)
                if os.environ.get("VERBOSE"):
                    print(f"\n{name}: root {r:.2f} quality {q:.2f} tuning {h.tuning_cents:.1f} key {h.key.name} {h.grid_check}")
                self.assertGreaterEqual(r, 0.9)
                self.assertGreaterEqual(q, 0.8)
                self.assertEqual(h.key.name, key)

    def test_power_chords_are_named_5_and_read_minor_from_the_key(self):
        h = self.heard["power E5"]
        self.assertEqual([c.symbol for c in h.chords][:1], ["E5"])
        self.assertEqual(h.chords[0].implied, "m")

    def test_chart_text(self):
        prog = self.cases["strum Am F C G"][0]
        txt = hear.format_chart(self.heard["strum Am F C G"], grid_for(prog))
        self.assertIn("key A minor", txt)
        self.assertIn("on the grid", txt)
        self.assertIn("  1  Am", txt)

    def test_on_grid_and_drift(self):
        for name, h in self.heard.items():
            self.assertTrue(h.grid_check.on_grid, f"{name}: {h.grid_check}")
        prog = self.cases["strum Am F C G"][0][:4]
        fast = render(prog, pluck_note, (0, 6, 8, 12), tempo=BPM * 1.03)
        g = hear.grid_check(hear.onsets(fast).times, grid_for(prog))
        self.assertFalse(g.on_grid, g)

    def test_rhythm_finds_the_strum_slots(self):
        h = self.heard["strum Am F C G"]
        self.assertEqual(len(h.rhythm.bars), 8)
        for bar in h.rhythm.bars:
            top = sorted(range(16), key=lambda i: -bar[i])[:4]
            self.assertEqual(sorted(top), [0, 6, 8, 12], bar)
            self.assertLess(max(v for i, v in enumerate(bar) if i not in (0, 6, 8, 12)), 0.2, bar)


@unittest.skipIf(np is None, "numpy/scipy not installed")
class TestHearGuitar(unittest.TestCase):
    """Open-position shapes strummed on six Karplus-Strong strings (synth.py): single thirds, muted strings, up-strums, a body,
    fret noise, a room. Each progression is heard in tune or 15 cents sharp (alternating), and must get the root and the quality
    (triad / 7th / power) as played, the key a musician would name, and the tuning within 3 cents."""
    heard = {}

    @classmethod
    def setUpClass(cls):
        for i, (name, p) in enumerate(synth.PROGRESSIONS.items()):
            detune = DETUNE if i % 2 else 0
            x = synth.render(p.bars, p.bpm, p.per_bar, p.pattern, detune, seed=i + 1)
            cls.heard[name] = (detune, hear.hear_chords(x, SR, Grid.regular(p.bpm, p.per_bar, len(p.bars) * p.per_bar)))

    @staticmethod
    def accuracy(h, p):
        got = {i: c for c in h.chords for i in range(c.start_beat, c.end_beat)}
        exp = synth.expected_beats(p.bars, p.per_bar)
        root = sum(1 for i, (r, _, _) in enumerate(exp) if i in got and got[i].root_pc == r)
        qual = sum(1 for i, (r, q, _) in enumerate(exp) if i in got and got[i].root_pc == r and got[i].quality == q)
        return root / len(exp), qual / len(exp)

    def test_chords_key_and_tuning(self):
        for name, p in synth.PROGRESSIONS.items():
            with self.subTest(name):
                detune, h = self.heard[name]
                r, q = self.accuracy(h, p)
                self.assertGreaterEqual(r, 0.9)
                self.assertGreaterEqual(q, 0.85)
                self.assertAlmostEqual(h.tuning_cents, detune, delta=3)
                if name == "A blues":                      # a blues in A is major and minor at once; the tonic is what counts
                    self.assertEqual(h.key.name.split()[0], "A")
                else:
                    self.assertEqual(h.key.name, p.key)
                self.assertTrue(h.grid_check.on_grid, h.grid_check)

    def test_a_single_third_is_not_a_power_chord(self):
        """The open shapes carry one third among five or six strings: Am (A E A C E), C (C E G C E), F barre, D (D A D F#)."""
        for name in ("Am F C G", "C G Am F", "D A Bm G"):
            _, h = self.heard[name]
            self.assertNotIn("5", [c.quality for c in h.chords], name)

    def test_power_chords_still_win_when_the_third_is_absent(self):
        p = synth.Prog(["E5", "A5", "D5", "E5"] * 2, 100, "E minor")
        h = hear.hear_chords(synth.render(p.bars, p.bpm, drive=3.0, seed=4), SR, Grid.regular(100, 4, 32))
        self.assertGreaterEqual(sum(c.quality == "5" for c in h.chords) / len(h.chords), 0.75, [c.symbol for c in h.chords])

    def test_clear_chords_are_confident_and_not_unsure(self):
        for name in ("Am F C G", "Em C G D", "A blues"):
            _, h = self.heard[name]
            for c in h.chords:
                self.assertGreaterEqual(c.confidence, 0.7, (name, c))
                self.assertFalse(c.unsure(), (name, c))

    def test_the_rival_is_another_root_or_family_not_a_7th(self):
        _, h = self.heard["Am F C G"]
        for c in h.chords:
            self.assertIsNotNone(c.runner_up)
            self.assertNotIn(c.runner_up[0], (c.symbol + "7", c.symbol + "maj7"), c)
            self.assertLess(c.runner_up[1], 0.5, c)

    def test_a_third_in_the_middle_is_unsure(self):
        """Chroma halfway between A and Am (an A with a quarter-strength third on both sides) is a rival at the same score."""
        ch = np.zeros((8, 12))
        ch[:, [9, 4]] = [3.0, 2.5]
        ch[:, 0] = 1.2
        ch[:, 1] = 1.2
        spans, _ = hear.hear_chords_from_chroma(ch, ch * 0, np.zeros(8, bool), Grid.regular(100, 4, 8))
        self.assertTrue(spans[0].unsure(), spans[0])

    def test_is_unsure_is_one_rule(self):
        self.assertFalse(is_unsure(0.9, 0.05, "Em"))
        self.assertTrue(is_unsure(0.9, 0.5, "Em"))         # the rival is more than half as likely
        self.assertTrue(is_unsure(0.4, 0.0, "Em"))         # not sure of itself
        self.assertFalse(is_unsure(0.3, 0.2, ""))          # no rival: nothing to ask
        c = HeardChord(0, 4, "G", 7, 7, "maj", 0.46, "Em", 0.3)
        self.assertTrue(c.is_unsure())
        self.assertIn('alt="Em", alt_conf=0.30', repr(c))
        self.assertEqual(eval(repr(c), {"HeardChord": HeardChord, "Fraction": __import__("fractions").Fraction}), c)

    def test_every_string_is_in_tune(self):
        rng = np.random.default_rng(0)
        for m in synth.OPEN:
            f = 440 * 2 ** ((m - 69) / 12)
            y = synth.string(f, 1.0, SR, rng)
            sp = np.abs(np.fft.rfft(y * np.hanning(len(y)), 1 << 18))
            fr = np.fft.rfftfreq(1 << 18, 1 / SR)
            band = (fr > f * 0.97) & (fr < f * 1.03)
            self.assertAlmostEqual(1200 * np.log2(fr[band][np.argmax(sp[band])] / f), 0, delta=1.0)


@SLOW
@unittest.skipIf(np is None, "numpy/scipy not installed")
class TestHearSweep(unittest.TestCase):
    """Other seeds, tempos and progressions (several seconds)."""

    def test_sweep(self):
        cases = [("Am F C G", ["Am", "F", "C", "G"] * 2, pluck_note, (0, 6, 8, 12), "A minor", 100),
                 ("Em C G D", ["Em", "C", "G", "D"] * 2, pluck_note, (0, 4, 8, 12), "E minor", 80),
                 ("Dm Bb F C", ["Dm", "Bb", "F", "C"] * 2, pluck_note, (0, 8), "D minor", 130),
                 ("pad Am F C G", ["Am", "F", "C", "G"] * 2, pad_note, (0,), "A minor", 90)]
        for name, prog, voice, st, key, tempo in cases:
            for seed in range(2, 6):
                with self.subTest(name, seed=seed):
                    x = render(prog, voice, st, seed=seed, tempo=tempo)
                    h = hear.hear_chords(x, SR, grid_for(prog, tempo))
                    r, q = score_beats(h, prog)
                    self.assertGreaterEqual(r, 0.9)
                    self.assertGreaterEqual(q, 0.8)
                    self.assertAlmostEqual(h.tuning_cents, DETUNE, delta=5)


@SLOW
@unittest.skipIf(np is None, "numpy/scipy not installed")
class TestGuitarSweep(unittest.TestCase):
    """Every progression with other seeds, in tune, sharp and flat, clean and overdriven (about a minute)."""

    def test_sweep(self):
        for name, p in synth.PROGRESSIONS.items():
            for seed, detune, drive in ((11, 0, 0), (12, 15, 0), (13, -15, 0), (14, 7, 2.0), (15, 0, 4.0)):
                with self.subTest(name, seed=seed, detune=detune, drive=drive):
                    x = synth.render(p.bars, p.bpm, p.per_bar, p.pattern, detune, seed, drive=drive)
                    h = hear.hear_chords(x, SR, Grid.regular(p.bpm, p.per_bar, len(p.bars) * p.per_bar))
                    r, q = TestHearGuitar.accuracy(h, p)
                    self.assertGreaterEqual(r, 0.9)
                    self.assertGreaterEqual(q, 0.85)
                    self.assertAlmostEqual(h.tuning_cents, detune, delta=3)
                    self.assertEqual(h.key.name.split()[0], p.key.split()[0])
                    if name != "A blues":
                        self.assertEqual(h.key.name, p.key)


if __name__ == "__main__":
    unittest.main()
