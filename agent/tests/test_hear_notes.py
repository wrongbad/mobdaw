"""badmidi.audio.hear on synthetic melodies: a sung-like tone, a plucked line, a whistle; auto mode picks notes or chords."""
import os
import unittest
from fractions import Fraction

try:
    import numpy as np
    from scipy.signal import iirpeak, lfilter, resample_poly
    import test_hear as th
    from badmidi.audio import hear
    from badmidi.audio.hear import SR, Grid
except ImportError:  # the audio extra is optional
    np = None

SLOW = unittest.skipUnless(os.environ.get("SLOW"), "set SLOW=1")

# (midi, first 16th slot, slots): A minor, four bars; leaps, a repeated note, an octave jump
MELODY = [(57, 0, 4), (60, 4, 2), (64, 6, 2), (69, 8, 6), (67, 14, 2),
          (65, 16, 4), (64, 20, 4), (62, 24, 4), (60, 28, 4),
          (64, 32, 2), (64, 34, 2), (62, 36, 4), (60, 40, 8),
          (57, 48, 4), (69, 52, 4), (57, 56, 4), (57, 60, 4)]
BARS = 4


def contour(melody, bpm, shift, glide, rate):
    """Pitch in cents above MIDI 0 per sample at `rate`: steps smoothed by a Hann glide of `glide` seconds."""
    slot = 60 / bpm / 4
    n = int((BARS * 16 * slot + 1.0) * rate)
    c = np.zeros(n)
    last = melody[0][0] + shift
    for m, s, d in melody:
        c[int(s * slot * rate):] = (m + shift) * 100
    k = max(int(glide * rate) | 1, 3)
    w = np.hanning(k)
    w /= w.sum()
    return np.convolve(np.pad(c, (k, k), mode="edge"), w, "same")[k:-k]


def gate(melody, bpm, n, rate, gap=0.03, attack=0.025, release=0.04, seed=0):
    """Amplitude per sample: each note on from its start to its end less `gap` (always), with attack and release."""
    rng = np.random.default_rng(seed)
    slot = 60 / bpm / 4
    g = np.zeros(n)
    for m, s, d in melody:
        a, b = int(s * slot * rate), int(((s + d) * slot - gap) * rate)
        e = np.ones(b - a) * rng.uniform(0.7, 1.0)
        na, nr = int(attack * rate), int(release * rate)
        e[:na] *= np.linspace(0, 1, na)
        e[-nr:] *= np.linspace(1, 0, nr)
        g[a:b] = np.maximum(g[a:b], e)
    return g


def sung(bpm, melody=MELODY, detune=th.DETUNE, seed=3, vib=30, breath=0.05):
    """Sawtooth through two vowel formant banks, vibrato 5.5 Hz +-30 cents from 100 ms into a note, glides, breath noise."""
    rng = np.random.default_rng(seed)
    R = SR * 4
    cents = contour(melody, bpm, 0, 0.07, R) + detune
    t = np.arange(len(cents)) / R
    onset = np.zeros(len(t))
    slot = 60 / bpm / 4
    for m, s, d in melody:
        i = int(s * slot * R)
        onset[i:] = t[i:] - t[i]
    v = vib * np.sin(2 * np.pi * 5.5 * t) * np.clip((onset - 0.1) / 0.15, 0, 1)
    f = 440 * 2 ** ((cents + v - 6900) / 1200)
    phase = np.cumsum(f) / R
    saw = 2 * (phase % 1) - 1
    saw = resample_poly(saw, 1, 4)
    n = len(saw)
    vowels = {"a": ((700, 8, 1.0), (1200, 10, .5), (2600, 12, .25)), "o": ((450, 8, 1.0), (800, 10, .4), (2500, 12, .15))}
    out = {k: sum(g * lfilter(*iirpeak(f0 / (SR / 2), q), saw) for f0, q, g in bank) for k, bank in vowels.items()}
    mix = np.zeros(n)
    for j, (m, s, d) in enumerate(melody):
        mix[int(s * slot * SR):] = j % 2
    mix = np.convolve(mix, np.hanning(int(0.08 * SR)) / np.hanning(int(0.08 * SR)).sum(), "same")
    y = out["a"] * (1 - mix) + out["o"] * mix
    y /= np.abs(y).max()
    g = gate(melody, bpm, n, SR)
    noise = lfilter(*iirpeak(3000 / (SR / 2), 0.7), rng.normal(size=n))
    noise /= np.abs(noise).max()
    y = y * g + breath * noise * (0.15 + 0.85 * g)
    return (y / np.abs(y).max()).astype(np.float32)


def plucked(bpm, melody=MELODY, seed=4):
    rng = np.random.default_rng(seed)
    slot = 60 / bpm / 4
    n = int((BARS * 16 * slot + 1.0) * SR)
    x = np.zeros(n)
    for m, s, d in melody:
        y = th.pluck_note(m, d * slot + 0.15, rng) * rng.uniform(0.7, 1.0)
        i = int(s * slot * SR)
        y = y[:n - i]
        x[i:i + len(y)] += y
    x += 0.003 * rng.normal(size=n)
    return (x / np.abs(x).max()).astype(np.float32)


def whistled(bpm, melody=MELODY, shift=17, seed=5):
    rng = np.random.default_rng(seed)
    R = SR * 2
    mel = [(m + shift, s, d) for m, s, d in melody]
    cents = contour(mel, bpm, 0, 0.04, R) + th.DETUNE
    t = np.arange(len(cents)) / R
    f = 440 * 2 ** ((cents + 15 * np.sin(2 * np.pi * 6 * t) - 6900) / 1200)
    y = resample_poly(np.sin(2 * np.pi * np.cumsum(f) / R), 1, 2)
    g = gate(mel, bpm, len(y), SR, gap=0.03, attack=0.04, release=0.05)
    y = y * g + 0.02 * rng.normal(size=len(y)) * (0.2 + g)
    return (y / np.abs(y).max()).astype(np.float32), mel


def score(h, melody, bpm):
    """(share of true notes heard within a 16th at the right pitch, share with the right pitch anywhere near, extra notes,
    octave errors)."""
    ok = near = octave = 0
    for m, s, d in melody:
        cand = [n for n in h.notes if abs(float(n.start_beat) * 4 - s) <= 1.0 + 1e-6]
        ok += any(n.pitch == m for n in cand)
        near += any(n.pitch % 12 == m % 12 for n in cand)
        octave += any(n.pitch % 12 == m % 12 and n.pitch != m for n in cand) and not any(n.pitch == m for n in cand)
    return ok / len(melody), near / len(melody), max(0, len(h.notes) - len(melody)), octave


def grid(bpm):
    return Grid.regular(bpm, 4, BARS * 4)


def vib_saw(f, vib=30, secs=1.5):
    R = SR * 4
    t = np.arange(int(secs * R)) / R
    fi = f * 2 ** (vib * np.sin(2 * np.pi * 5.5 * t) / 1200)
    return resample_poly(2 * ((np.cumsum(fi) / R) % 1) - 1, 1, 4).astype(np.float32)


@unittest.skipIf(np is None, "numpy/scipy not installed")
class TestF0(unittest.TestCase):
    def cents_off(self, x, hz):
        m = np.nanmedian(hear.f0_track(x).midi)
        return (m - (69 + 12 * np.log2(hz / 440))) * 100

    def test_sines_and_sawtooth_with_vibrato(self):
        for f in (110, 220, 440, 880, 1500):
            t = np.arange(SR) / SR
            self.assertLess(abs(self.cents_off(np.sin(2 * np.pi * f * t).astype(np.float32), f)), 6, f)
        for f in (98, 196, 392):
            self.assertLess(abs(self.cents_off(vib_saw(f), f)), 12, f)

    def test_silence_and_noise_are_unvoiced(self):
        self.assertFalse(hear.f0_track(np.zeros(SR, np.float32)).voiced.any())
        noise = np.random.default_rng(0).normal(size=SR * 2).astype(np.float32)
        self.assertLess(hear.f0_track(noise).voiced.mean(), 0.1)


@unittest.skipIf(np is None, "numpy/scipy not installed")
class TestHearNotes(unittest.TestCase):
    cases = {}

    @classmethod
    def setUpClass(cls):
        for bpm in (90, 120):
            cls.cases[("sung", bpm)] = (sung(bpm), MELODY)
            cls.cases[("plucked", bpm)] = (plucked(bpm), MELODY)
            cls.cases[("whistle", bpm)] = whistled(bpm)
        cls.heard = {k: hear.hear(x, SR, grid(k[1])) for k, (x, _) in cls.cases.items()}

    def test_auto_hears_these_as_notes(self):
        for k, h in self.heard.items():
            self.assertEqual(h.mode, "notes", k)
            self.assertEqual(h.decision.mode, "notes")

    def test_notes_within_a_16th_with_the_right_pitch(self):
        for k, (x, mel) in self.cases.items():
            with self.subTest(k):
                ok, near, extra, octave = score(self.heard[k], mel, k[1])
                if os.environ.get("VERBOSE"):
                    print(f"\n{k}: onset+pitch {ok:.2f} pitch class {near:.2f} extra {extra} octave errors {octave}")
                self.assertGreaterEqual(ok, 0.9)
                self.assertLessEqual(extra, 1)
                self.assertEqual(octave, 0)

    def test_durations_follow_the_truth(self):
        for k, (x, mel) in self.cases.items():
            if k[0] == "plucked":
                continue                                   # a string rings on: its end is not where the player stopped
            h = self.heard[k]
            good = 0
            for m, s, d in mel:
                n = next((n for n in h.notes if abs(float(n.start_beat) * 4 - s) <= 1), None)
                good += bool(n) and abs(float(n.end_beat - n.start_beat) * 4 - d) <= 1
            self.assertGreaterEqual(good / len(mel), 0.8, k)

    def test_tuning_key_grid_and_unquantized_onsets(self):
        for k, h in self.heard.items():
            self.assertAlmostEqual(h.tuning_cents, th.DETUNE, delta=5, msg=str(k))
            self.assertTrue(h.grid_check.on_grid, k)
            slot = 60 / k[1] / 4
            self.assertEqual(h.key.name, "D minor" if k[0] == "whistle" else "A minor", k)
            for n in h.notes:
                self.assertLess(abs(n.raw_onset_s - float(n.start_beat) * 4 * slot), slot, "the raw onset is within a slot of the quantized one")
                self.assertTrue(1 <= n.velocity <= 127 and 0 <= n.confidence <= 1)

    def test_velocity_follows_loudness(self):
        x = plucked(100)
        h = hear.hear_notes(x * np.where(np.arange(len(x)) < len(x) // 2, 1.0, 0.25).astype(np.float32), SR, grid(100))
        half = len(h.notes) // 2
        self.assertGreater(np.mean([n.velocity for n in h.notes[:half - 1]]), np.mean([n.velocity for n in h.notes[half + 1:]]) + 15)

    def test_snap_to_eighths(self):
        x, mel = self.cases[("sung", 90)]
        h = hear.hear_notes(x, SR, grid(90), snap=2)
        self.assertTrue(all((n.start_beat * 2).denominator == 1 and (n.end_beat * 2).denominator == 1 for n in h.notes))
        self.assertEqual(h.rhythm.slots_per_beat, 2)

    def test_chords_are_a_guess_marked_from_the_melody(self):
        h = self.heard[("sung", 90)]
        self.assertEqual(len(h.chords), BARS)
        self.assertTrue(all(c.src == "melody" and c.confidence <= 0.4 for c in h.chords))
        self.assertEqual([c.symbol for c in h.chords][0], "Am")

    def test_chart(self):
        h = self.heard[("sung", 90)]
        txt = hear.format_chart(h, grid(90), "Voice", 1, h.mode)
        self.assertIn("heard as notes (auto: one clear pitch", txt.splitlines()[0])
        self.assertRegex(txt, r"\n  1  A3\.q C4\.e E4\.e A4\.qd G4\.e +\| guess: Am")
        self.assertIn("NOT heard", txt)

    def test_auto_hears_strummed_chords_as_chords(self):
        am = ["Am", "F", "C", "G"] * 2
        pw = ["E5", "E5", "G5", "A5", "E5", "D5", "G5", "E5"]
        for name, x in (("strum", th.render(am, th.pluck_note, (0, 6, 8, 12))), ("pad", th.render(am[:4], th.pad_note, (0,))),
                        ("power", th.render(pw, th.dist_note, (0, 6, 8, 12), strum_gap=0.006)),
                        ("slow arpeggio-free strum", th.render(am, th.pluck_note, (0,), tempo=70))):
            d = hear.decide(hear.f0_track(hear.prepare(x, SR)))
            self.assertEqual(d.mode, "chords", f"{name}: {d}")
        h = hear.hear(th.render(am[:4], th.pluck_note, (0, 8)), SR, th.grid_for(am[:4]))
        self.assertEqual((h.mode, h.decision.mode), ("chords", "chords"))
        self.assertTrue(h.chords and not h.notes)

    def test_forcing_a_mode(self):
        x, _ = self.cases[("plucked", 90)]
        self.assertEqual(hear.hear(x, SR, grid(90), "chords").mode, "chords")
        self.assertIsNone(hear.hear(x, SR, grid(90), "notes").decision)


@unittest.skipIf(np is None, "numpy/scipy not installed")
class TestGuessChords(unittest.TestCase):
    def notes(self, *spec):
        return [hear.HeardNote(Fraction(s), Fraction(s + d), m, 90, 1.0, 0.0) for m, s, d in spec]

    def test_triad_that_covers_the_bar(self):
        key = hear.Key(0, "major", "C major", 1, 1)
        g = Grid.regular(100, 4, 12)
        bars = self.notes((67, 0, 1), (64, 1, 1), (60, 2, 2),             # G E C
                          (65, 4, 2), (69, 6, 1), (60, 7, 1),             # F A C
                          (62, 8, 1), (67, 9, 1), (71, 10, 2))           # D G B
        self.assertEqual([c.symbol for c in hear.guess_chords(bars, g, key)], ["C", "F", "G"])

    def test_strong_beats_decide_a_tie(self):
        key = hear.Key(0, "major", "C major", 1, 1)
        g = Grid.regular(100, 4, 4)
        # C and E on the downbeat/beat 3, passing D and F between: C, not Dm
        n = self.notes((60, 0, 1), (62, 1, 1), (64, 2, 1), (65, 3, 1))
        self.assertEqual(hear.guess_chords(n, g, key)[0].symbol, "C")

    def test_empty_bar_is_N_and_minor_gets_a_major_V(self):
        key = hear.Key(9, "minor", "A minor", 1, 1)
        g = Grid.regular(100, 4, 8)
        n = self.notes((64, 4, 1), (68, 5, 1), (71, 6, 1), (64, 7, 1))     # E G# B E
        c = hear.guess_chords(n, g, key)
        self.assertEqual((c[0].symbol, c[1].symbol), ("N", "E"))


@SLOW
@unittest.skipIf(np is None, "numpy/scipy not installed")
class TestHearNotesSweep(unittest.TestCase):
    """Other seeds, tempos and registers (tens of seconds)."""

    def test_sweep(self):
        for sh in (0, -12, 12):
            mel = [(m + sh, s, d) for m, s, d in MELODY]
            for bpm in (70, 100, 140):
                for seed in (1, 2, 3):
                    # plucks of 214 ms (140 bpm) ring into each other: a known weakness, see docs/todo.md
                    for name, x in (("sung", sung(bpm, mel, seed=seed)), *([("plucked", plucked(bpm, mel, seed=seed))] if bpm < 140 else [])):
                        with self.subTest(name, shift=sh, bpm=bpm, seed=seed):
                            h = hear.hear(x, SR, grid(bpm))
                            ok, near, extra, octave = score(h, mel, bpm)
                            self.assertEqual(h.mode, "notes")
                            self.assertGreaterEqual(ok, 0.9)
                            self.assertEqual(octave, 0)
        for seed in (1, 2, 3):
            for shift in (17, 24):
                with self.subTest("whistle", seed=seed, shift=shift):
                    x, mel = whistled(100, shift=shift, seed=seed)
                    ok, *_ = score(hear.hear(x, SR, grid(100)), mel, 100)
                    self.assertGreaterEqual(ok, 0.9)


if __name__ == "__main__":
    unittest.main()
