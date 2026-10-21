"""A guitar synth for the hearing tests and the listen-eval demo set: open-position chord shapes strummed on six Karplus-Strong
strings, through a body resonance, optional overdrive and a room.

    x = render(["Am", "F", "C", "G"], bpm=100)                     # float32 mono at SR; one chord per bar
    x = render(["Am", ["F", "G"], "C", "G"], bpm=90, detune=15)    # a bar can hold several chords (split evenly)
    expected_beats(["Am", "F"], 4)                                  # [(9, "min", "Am")] * 4 + [(5, "maj", "F")] * 4

What it models, because the hearing has to survive it: real shapes (a single third in an open C, doubled roots, muted strings),
strum direction (down from the bass, up on the top four strings, lighter) with 8-25 ms between strings, varied velocities and
timing, pick-position comb filtering, string decay that is longer on the bass strings, a slightly stiff string (upper partials
sharp, as on a real guitar), a hand-muted release at chord changes, fret noise, body modes near 100, 200 and 400 Hz, and a
noise-IR room. Karplus-Strong is run as an IIR filter (so a string can be tuned exactly with an allpass) rather than sample by
sample. Everything is seeded.
"""
from dataclasses import dataclass

import numpy as np
from scipy.optimize import brentq
from scipy.signal import fftconvolve, freqz, iirpeak, lfilter

SR = 22050
PCS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
OPEN = (40, 45, 50, 55, 59, 64)                      # E2 A2 D3 G3 B3 E4
T60 = (4.0, 3.6, 3.2, 2.8, 2.2, 1.8)                 # seconds to -60 dB, per string
# frets from the low E string; x = not played
SHAPES = {
    "Am": "x02210", "A": "x02220", "A7": "x02020", "Am7": "x02010", "A5": "x022xxx",
    "C": "x32010", "C7": "x32310", "Cmaj7": "x32000", "C5": "x355xxx",
    "D": "xx0232", "Dm": "xx0231", "D7": "xx0212", "D5": "xx0xxx", "Dsus4": "xx0233",
    "E": "022100", "Em": "022000", "E7": "020100", "Em7": "020000", "E5": "022xxx",
    "F": "133211", "Fmaj7": "xx3210", "F5": "133xxx",
    "G": "320003", "G7": "320001", "G5": "355xxx",
    "Bm": "x24432", "B7": "x21202", "B5": "x244xx",
}
QUAL = {"": "maj", "m": "min", "7": "7", "maj7": "maj7", "m7": "m7", "sus4": "sus4", "5": "5"}


def parse(sym: str) -> tuple[int, str]:
    """(root pitch class, quality as hear.QUALITIES names)."""
    root, rest = PCS[sym[0]], sym[1:]
    if rest[:1] in ("#", "b") and rest[:1]:
        root += 1 if rest[0] == "#" else -1
        rest = rest[1:]
    return root % 12, QUAL[rest]


def shape(sym: str) -> tuple[list[int], list[int]]:
    """(MIDI notes, string indexes) of the chord's open-position shape, low string first."""
    return [o + int(f) for o, f in zip(OPEN, SHAPES[sym]) if f != "x"], [i for i, f in enumerate(SHAPES[sym]) if f != "x"]


def expected_beats(bars, per_bar: int = 4) -> list[tuple[int, str, str]]:
    """(root, quality, symbol) of every beat of `bars` (a bar is a symbol or a list of symbols sharing it evenly)."""
    out = []
    for bar in bars:
        syms = [bar] if isinstance(bar, str) else list(bar)
        for i in range(per_bar):
            s = syms[min(i * len(syms) // per_bar, len(syms) - 1)]
            out.append(parse(s) + (s,))
    return out


# --- one string ------------------------------------------------------------------------------------


def _pd(b, a, f: float, sr: int) -> float:
    """Phase delay in samples of a filter at f."""
    w = 2 * np.pi * f / sr
    return float(-np.angle(freqz(b, a, [w])[1][0]) / w)


def string(f0: float, dur: float, sr: int, rng, vel: float = 1.0, t60: float = 3.0, pick: float = 0.15, damp: float = 0.45,
           stiff: float = -0.4) -> np.ndarray:
    """A plucked string tuned exactly to f0: a noise burst (pick-position comb, brightness by velocity) into a delay loop with a
    lowpass (`damp`), a dispersion allpass (`stiff` < 0: delay falls with frequency, so partials stretch) and a tuning allpass."""
    lp = np.array([1 - damp, damp])
    disp_b, disp_a = np.convolve([stiff, 1.0], [stiff, 1.0]), np.convolve([1.0, stiff], [1.0, stiff])      # two sections
    rest = sr / f0 - _pd(lp, [1.0], f0, sr) - _pd(disp_b, disp_a, f0, sr)
    n = int(np.floor(rest - 0.5))
    want = rest - n
    c = brentq(lambda c: _pd([c, 1.0], [1.0, c], f0, sr) - want, -0.9, 0.9)
    pn = np.convolve(np.convolve(lp, [c, 1.0]), disp_b)
    pd = np.convolve([1.0, c], disp_a)
    g = 10 ** (-3 / (t60 * f0))
    den = np.zeros(n + len(pn))
    den[: len(pd)] += pd
    den[n:n + len(pn)] -= g * pn
    period = int(round(sr / f0))
    e = rng.uniform(-1, 1, period)
    k = 0.15 + 0.5 * vel                                           # a hard pick is brighter
    e = lfilter([k], [1, -(1 - k)], e)
    e -= e.mean()
    p = max(1, int(round(pick * period)))
    e = e - np.r_[np.zeros(p), e[:-p]]
    y = lfilter(pd, den, np.r_[e, np.zeros(max(int(dur * sr) - len(e), 0))])[: int(dur * sr)]
    head = y[: int(0.1 * sr)]
    return y / max(np.sqrt(np.mean(head ** 2)), 1e-9) * vel * 0.1


# --- strumming -------------------------------------------------------------------------------------

# (8th-note slot in the bar, 'D'own or 'U'p, velocity)
PATTERNS = {
    "folk": [(0, "D", 1.0), (2, "D", .8), (3, "U", .6), (5, "U", .6), (6, "D", .85), (7, "U", .55)],
    "quarters": [(0, "D", 1.0), (2, "D", .85), (4, "D", .9), (6, "D", .85)],
    "ballad": [(0, "D", 1.0), (4, "D", .8), (6, "D", .7), (7, "U", .5)],
    "waltz": [(0, "D", 1.0), (2, "D", .8), (3, "U", .6), (4, "D", .8), (5, "U", .6)],
    "whole": [(0, "D", 1.0)],
    "eighths": [(0, "D", 1.0), (1, "U", .55), (2, "D", .8), (3, "U", .55), (4, "D", .9), (5, "U", .55), (6, "D", .8), (7, "U", .55)],
    "shuffle": [(0, "D", 1.0), (2, "D", .8), (3, "U", .6), (4, "D", .9), (6, "D", .8), (7, "U", .6)],          # swung with swing=0.667
    "six8": [(0, "D", 1.0), (1, "D", .6), (2, "U", .7), (3, "D", .9), (4, "D", .6), (5, "U", .7)],            # slots are thirds of a beat: slot=1/3
    "triplet": [(0, "D", 1.0), (1, "U", .5), (2, "D", .7), (3, "D", .9), (4, "U", .5), (5, "D", .7),
                (6, "D", .8), (7, "U", .5), (8, "D", .7), (9, "D", .9), (10, "U", .5), (11, "D", .7)],         # 4/4 in thirds: slot=1/3
}


class Clock:
    """Beat position -> seconds for a take whose tempo moves: `bpm` at the start, `rubato` a sine of that relative size with
    `period` seconds, `accel` a linear change of that relative size over `beats` beats, `offset` seconds before beat 1 and
    `lag` a constant shift of every beat (a laid-back player)."""

    def __init__(self, bpm: float = 100, rubato: float = 0.0, period: float = 20.0, accel: float = 0.0, offset: float = 0.0,
                 lag: float = 0.0, beats: float = 64):
        dt = 0.01
        t = np.arange(0, beats * 60 / bpm * 1.5, dt)
        rate = bpm / 60 * (1 + rubato * np.sin(2 * np.pi * t / period)) * (1 + accel * np.minimum(t / (beats * 60 / bpm), 1.5))
        self.b = np.concatenate([[0], np.cumsum((rate[:-1] + rate[1:]) / 2 * dt)])
        self.t, self.offset, self.lag = t, offset, lag
        self.args = (bpm, rubato, period, accel, offset, lag, beats)

    def __repr__(self):
        return "Clock%r" % (self.args,)

    def __call__(self, beat):
        return np.interp(beat, self.b, self.t) + self.offset + self.lag


def render(bars, bpm: float = 100, per_bar: int = 4, pattern: str | list | None = None, detune: float = 0.0, seed: int = 1,
           sr: int = SR, drive: float = 0.0, wet: float = 0.12, noise: float = 0.003, tail: float = 1.0,
           body: float = 1.0, offset: float = 0.0, clock=None, swing: float = 0.5, slot: float = 0.5,
           pickup: int = 0) -> np.ndarray:
    """Float32 mono audio of `bars` (a symbol, or a list of symbols sharing the bar) strummed at `bpm` in `per_bar` beats a bar.
    `detune`: cents the whole guitar sits above A440. `drive`: 0 clean, 2-8 overdriven. `offset`: seconds of silence before beat 1.
    `pattern`: a PATTERNS name or a list of (slot, 'D'/'U', velocity), a slot being `slot` beats (an 8th by default); default by meter,
    'folk' or 'waltz'. `clock`: a `Clock` (beat position -> seconds) instead of the steady `bpm`; `swing`: where the off-beat 8th falls in
    its beat (0.5 straight, 0.667 triplet swing). `pickup`: beats of the last chord before bar 1 (bar 1 starts at beat `pickup`)."""
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    pat = PATTERNS[pattern] if isinstance(pattern, str) else pattern or PATTERNS["waltz" if per_bar == 3 else "folk"]
    segs = []                                                      # (start beat, beats, symbol)
    if pickup:
        last = bars[-1] if isinstance(bars[-1], str) else bars[-1][-1]
        segs.append((0, pickup, last))
    for i, bar in enumerate(bars):
        syms = [bar] if isinstance(bar, str) else list(bar)
        for j, s in enumerate(syms):
            segs.append((pickup + i * per_bar + j * per_bar / len(syms), per_bar / len(syms), s))
    T = clock or (lambda b: offset + np.asarray(b) * beat)
    total = float(T(pickup + len(bars) * per_bar)) + tail
    n = int(total * sr)
    x = np.zeros(n)
    strikes: list[list[tuple[float, float, int]]] = [[] for _ in OPEN]     # per string: (time, velocity, segment)
    for ci, (b0, nb, sym) in enumerate(segs):
        notes, strings = shape(sym)
        bar_b0 = pickup + int((b0 - pickup) // per_bar) * per_bar
        slots = [(bar_b0 + s * slot, d, v) for s, d, v in pat if b0 - 1e-9 <= bar_b0 + s * slot < b0 + nb - 1e-9]
        if b0 < pickup:
            slots = [(b0 + k, "D", 0.7) for k in range(int(nb))]
        if not slots or slots[0][0] > b0 + 1e-9:
            slots.insert(0, (b0, "D", 0.95))
        for sb, d, v in slots:
            fl = np.floor(sb + 1e-9)
            sw = fl + swing if abs(sb - fl - 0.5) < 1e-6 else sb                                 # the off-beat 8th is swung
            t = max(float(T(sw)) + rng.normal(0, 0.004), 0.0)
            gap = rng.uniform(0.008, 0.025)                          # seconds between strings
            vel = float(np.clip(v * rng.uniform(0.75, 1.05), 0.2, 1.1))
            order = list(strings) if d == "D" else list(reversed(strings))[:4]      # an up-strum hits the top strings
            if d == "U":
                vel *= 0.8
            for k, s in enumerate(order):
                strikes[s].append((t + k * gap, vel * rng.uniform(0.85, 1.1), ci))
    for s, ks in enumerate(strikes):
        ks.sort()
        for j, (t, vel, ci) in enumerate(ks):
            b0, nb, sym = segs[ci]
            notes, strings = shape(sym)
            m = notes[strings.index(s)]
            chord_end = float(T(b0 + nb))
            changes = ci + 1 == len(segs) or segs[ci + 1][2] != sym
            end = chord_end + 0.04 * rng.random() if changes else t + 3.5     # the left hand lifts at a chord change
            if j + 1 < len(ks):
                end = min(end, ks[j + 1][0] + 0.01)                             # a re-strike damps the string
            end = max(end, t + 0.05)
            dur = float(np.clip(end - t, 0.05, 3.5)) + 0.03
            f0 = 440 * 2 ** ((m - 69 + detune / 100) / 12)
            y = string(f0, dur, sr, rng, vel, T60[s] * rng.uniform(0.9, 1.1), pick=rng.uniform(0.1, 0.2), damp=rng.uniform(0.4, 0.5),
                       stiff=(-0.75, -0.65, -0.5, -0.3, -0.2, -0.12)[s] * rng.uniform(0.85, 1.1))
            nr = int(0.03 * sr)
            y[-nr:] *= np.linspace(1, 0, nr)                                       # hand-muted release
            i = int(t * sr)
            x[i:i + len(y)] += y[: max(0, n - i)]
    # fret noise: a squeak or tap around each chord change, and a little pick noise
    for b0, nb, sym in segs:
        for _ in range(2):
            t = float(T(b0)) + rng.uniform(-0.12, 0.02)
            if t > 0:
                m = int(rng.uniform(0.02, 0.06) * sr)
                nz = fftconvolve(rng.normal(size=m), np.hanning(9) * np.cos(np.arange(9) * rng.uniform(1.0, 2.2)), "same") * np.hanning(m)
                i = int(t * sr)
                x[i:i + m] += nz[: max(0, n - i)] * rng.uniform(0.01, 0.03)
    # body: a few resonant modes added in parallel
    y = x.copy()
    for f, q, g in ((100, 8, 1.1), (200, 10, 0.9), (400, 12, 0.6)):
        b, a = iirpeak(f / (sr / 2), q)
        y += body * g * 0.5 * lfilter(b, a, x)
    if drive > 0:
        y = np.tanh(drive * y / max(np.abs(y).max(), 1e-9) * 1.5) / np.tanh(drive * 1.5)
    ir_t = np.arange(int(0.45 * sr)) / sr
    ir = rng.normal(size=len(ir_t)) * np.exp(-ir_t / 0.1)
    ir[0] = 0
    y = y / max(np.abs(y).max(), 1e-9)
    wetx = fftconvolve(y, ir)[:n]
    y = y + wet * wetx / max(np.abs(wetx).max(), 1e-9) + noise * rng.normal(size=n)
    return (0.8 * y / np.abs(y).max()).astype(np.float32)


# --- the test and demo material -----------------------------------------------------------------------


@dataclass
class Prog:
    bars: list
    bpm: float
    key: str                                  # the key a musician would name
    per_bar: int = 4
    pattern: str | None = None
    note: str = ""


PROGRESSIONS: dict[str, Prog] = {
    "Am F C G": Prog(["Am", "F", "C", "G"] * 2, 100, "A minor"),
    "C G Am F": Prog(["C", "G", "Am", "F"] * 2, 90, "C major", pattern="quarters"),
    "Em C G D": Prog(["Em", "C", "G", "D"] * 2, 110, "E minor"),
    "D A Bm G": Prog(["D", "A", "Bm", "G"] * 2, 100, "D major"),
    "Am Dm E Am": Prog(["Am", "Dm", "E", "Am"] * 2, 90, "A minor", pattern="ballad", note="harmonic minor: a major E"),
    "A blues": Prog(["A7", "A7", "A7", "A7", "D7", "D7", "A7", "A7", "E7", "D7", "A7", "E7"], 100, "A major", note="12 bars with 7ths"),
    "G Em C D 70": Prog(["G", "Em", "C", "D"] * 2, 70, "G major"),
    "G Em C D 140": Prog(["G", "Em", "C", "D"] * 2, 140, "G major", pattern="quarters"),
    "D Bm G A 3/4": Prog(["D", "Bm", "G", "A"] * 2, 110, "D major", per_bar=3),
}
