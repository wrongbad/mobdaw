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


if __name__ == "__main__":
    import sys, time
    for name in ("sung", "plucked", "whistle"):
        for bpm in (90, 120):
            if name == "sung":
                x, mel = sung(bpm), MELODY
            elif name == "plucked":
                x, mel = plucked(bpm), MELODY
            else:
                x, mel = whistled(bpm)
            t0 = time.time()
            tr = hear.f0_track(hear.prepare(x, SR))
            d = hear.decide(tr)
            h = hear.hear_notes(x, SR, grid(bpm), 4, tr)
            print(name, bpm, score(h, mel, bpm), d.mode, round(d.clear, 2), round(d.voiced, 2), h.tuning_cents, h.key.name, h.grid_check.on_grid, round(time.time() - t0, 2))
            if "-v" in sys.argv:
                for n in h.notes:
                    print("   ", float(n.start_beat) * 4, float(n.end_beat) * 4, n.pitch, n.velocity, n.confidence, n.raw_onset_s)
