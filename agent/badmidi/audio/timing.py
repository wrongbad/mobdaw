"""Timing from the audio: beats, feel, meter, and the alignment of a take to a reference grid. Never refuses: every function makes its
best reading and says how sure it is (`confidence`, 0..1; under `UNSURE` the caller should warn and name the alternative).

Pure numpy/scipy on mono 22050 Hz signals (`hear.prepare` converts) or on onset times; all times are seconds.

    f = features(x)                       # envelope, low band, chroma: computed once, passed to the rest
    bt = beats(f)                         # BeatTrack: beat times, tempo curve, bpm, confidence, half/double alternatives
    fl = feel(onsets(x).times, bt.times)  # Feel: straight16 | triplet8 | triplet16 | swing8, swing ratio, offset
    mt = meter(f, bt.times, fl)           # Meter: beats per bar, unit, downbeat, pickup, confidence, runner-up
    g = audio_grid(bt, mt)                # a hear.Grid on the beats as played: hear_chords / hear_notes / hear take it
    al = align(onsets(x).times, ref_beats, bt.times)    # Alignment to a project's beats (a click): offset curve, kind
    g = played_grid(al, ref_grid)         # the project's grid moved by the offset curve
    snap(t, subdivisions(ref_beats, fl), tol)           # a time to the reference grid, only if within `tol`
    analyze(x)                            # features, beats, feel and meter in one call (Timing)
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import gaussian_filter1d, maximum_filter1d, median_filter, uniform_filter1d

from .hear import SR, Grid, _stft, onsets

HOP = 256                      # envelope frames: 11.6 ms
FPS = SR / HOP
ENV_DELAY = 0.0                # seconds to subtract from an envelope peak time (set from measurement)
UNSURE = 0.5                   # under this confidence a reading should be reported as a guess
BPM_LO, BPM_HI = 40.0, 240.0
PRIOR_BPM, PRIOR_OCT = 100.0, 0.8     # the tempo prior: log-normal around 100 bpm, this many octaves wide
HARM = (1.0, 0.5, 0.33, 0.25)  # weight of the multiples of a beat period in the tempo score
ALPHA = 200.0                  # beat tracker: stiffness of the tempo (cost of a log-ratio away from the local period)


# --- data -----------------------------------------------------------------------------------------


@dataclass
class Features:
    """What the timing functions share, from one pass over the audio."""
    env: np.ndarray              # onset strength per frame (FPS), >= 0
    low: np.ndarray              # the same for the bass band (40-250 Hz)
    chroma: np.ndarray           # frames x 12, cheap pitch-class energy
    chroma_fps: float
    duration: float


@dataclass
class Alt:
    """Another reading of the tempo."""
    bpm: float
    ratio: float                 # to the chosen bpm: 0.5, 2, 3, ...
    score: float                 # 0..1 against the chosen reading


@dataclass
class BeatTrack:
    times: np.ndarray            # beat times, s
    tempo_curve: np.ndarray      # bpm at each beat
    bpm: float                   # over the whole take
    confidence: float            # 0..1: how clearly this tempo beats its half/double and its rivals
    alternatives: list[Alt] = field(default_factory=list)      # best first
    variation: float = 0.0       # relative size of the tempo's movement (about +-this around bpm)
    support: float = 1.0         # share of beats that have an onset at them

    def unsure(self) -> bool:
        return self.confidence < UNSURE


@dataclass
class Feel:
    kind: str                    # 'straight16' | 'triplet8' | 'triplet16' | 'swing8'
    swing_ratio: float           # where the off-beat 8th falls in its beat: 0.5 straight, 0.667 triplet, up to 0.75
    offset_s: float              # onsets minus the beat, seconds (positive = behind the beat)
    confidence: float
    n: int = 0                   # onsets used

    def positions(self) -> tuple[float, ...]:
        """Subdivision points in a beat (fractions, 0 included) that this feel plays on."""
        return {"straight16": (0.0, .25, .5, .75), "triplet8": (0.0, 1 / 3, 2 / 3), "triplet16": tuple(k / 6 for k in range(6)),
                "swing8": (0.0, self.swing_ratio)}[self.kind]


@dataclass
class Reading:
    """One reading of the meter (the winner's runner-up)."""
    beats_per_bar: int
    unit: str
    downbeat_index: int
    score: float


@dataclass
class Meter:
    beats_per_bar: int           # of the beats given: 2, 3 or 4
    unit: str                    # '4' simple (the beat is a quarter, split in two) or '8' compound (a dotted quarter, split in three)
    downbeat_index: int          # index of the first downbeat in the beats given (the beats before it are a pickup)
    first_downbeat_s: float
    confidence: float
    runner_up: Reading | None = None
    scores: dict = field(default_factory=dict)     # (beats_per_bar, phase) -> score

    @property
    def signature(self) -> tuple[int, int]:
        """(numerator, denominator): 4/4, 3/4, 2/4, 6/8, 9/8, 12/8."""
        return (self.beats_per_bar * 3, 8) if self.unit == "8" else (self.beats_per_bar, 4)

    @property
    def pickup_beats(self) -> int:
        return self.downbeat_index

    def unsure(self) -> bool:
        return self.confidence < UNSURE


@dataclass
class Alignment:
    offset_curve: np.ndarray     # seconds the playing is late (+) or early (-) of each reference beat
    mean_offset: float
    max_abs_offset: float
    kind: str                    # 'tight' | 'feel' | 'drifting'
    played_beats: np.ndarray     # the reference beats moved by the curve
    confidence: float
    method: str = "onsets"       # 'onsets' (phase of the playing against the beats) | 'beats' (audio beats matched to them)
    drift: float = 0.0           # seconds the offset moves from the first to the last beat (end - start, smoothed)
    n: int = 0                   # onsets used

    def describe(self) -> str:
        m = self.mean_offset * 1000
        if self.kind == "tight":
            return f"tight to the beats ({m:+.0f} ms)"
        if self.kind == "feel":
            return f"{abs(m):.0f} ms {'behind' if m > 0 else 'ahead of'} the beats, steadily"
        return f"drifts {self.drift * 1000:+.0f} ms over the take (to {self.offset_curve[-1] * 1000:+.0f} ms)"


@dataclass
class Timing:
    features: Features
    beats: BeatTrack
    feel: Feel
    meter: Meter
    onsets: list[float]


# --- features -------------------------------------------------------------------------------------


def features(x: np.ndarray) -> Features:
    """Onset-strength envelope (log-spectral flux across 60 Hz - 8 kHz), the same for the bass band, and a cheap chroma."""
    x = np.asarray(x, np.float32)
    n = 1024
    S = _stft(x, n, HOP)
    k0, k1, kl = int(60 / (SR / n)) + 1, int(8000 / (SR / n)), int(250 / (SR / n))
    L = np.log1p(S[:, k0:k1] * (100.0 / max(S.max(), 1e-9)))
    flux = np.maximum(L[1:] - maximum_filter1d(L[:-1], 3, axis=1), 0)
    env = np.r_[0, flux.sum(axis=1)]
    low = np.r_[0, flux[:, :kl - k0].sum(axis=1)]
    env, low = _clean(env), _clean(low)
    nc, hc = 4096, 1024
    C = _stft(x, nc, hc)
    f = np.arange(C.shape[1]) * SR / nc
    ok = (f > 80) & (f < 2000)
    pc = (np.round(12 * np.log2(f[ok] / 440)).astype(int) + 9) % 12
    chroma = np.zeros((len(C), 12), np.float32)
    A = np.log1p(C[:, ok] * (100.0 / max(C.max(), 1e-9)))
    for p in range(12):
        chroma[:, p] = A[:, pc == p].sum(axis=1)
    return Features(env, low, chroma, SR / hc, len(x) / SR)


def _clean(e: np.ndarray) -> np.ndarray:
    """Envelope minus its slow trend (half a second), clipped at 0, in units of its spread."""
    e = np.maximum(e - uniform_filter1d(e, int(0.5 * FPS) | 1, mode="nearest"), 0)
    return e / max(np.percentile(e, 98), 1e-9) if e.max() > 0 else e


def _feat(x) -> Features:
    return x if isinstance(x, Features) else features(np.asarray(x, np.float32))


# --- beats ----------------------------------------------------------------------------------------


def _windows(n: int, win: int, hop: int) -> list[tuple[int, int]]:
    if n <= win:
        return [(0, n)]
    starts = list(range(0, n - win + 1, hop))
    if starts[-1] != n - win:
        starts.append(n - win)
    return [(s, s + win) for s in starts]


def _acf(seg: np.ndarray, maxlag: int) -> np.ndarray:
    seg = (seg - seg.mean()) * np.hanning(len(seg))
    F = np.fft.rfft(seg, 2 * len(seg))
    r = np.fft.irfft(np.abs(F) ** 2)[:maxlag]
    r = r / max(r[0], 1e-12)
    return r / np.maximum(1 - np.arange(len(r)) / len(seg), 0.3)       # the overlap shrinks with the lag


def _tempo_scores(o: np.ndarray, bpms: np.ndarray, win_s: float = 8.0, hop_s: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """(window centres in frames, scores windows x bpms): the autocorrelation of each window at the beat period and its multiples."""
    win, hop = int(win_s * FPS), int(hop_s * FPS)
    lag = 60.0 / bpms * FPS
    cs, rows = [], []
    for a, b in _windows(len(o), win, hop):
        seg = o[a:b]
        r = _acf(seg, min(len(seg), int(4.5 * FPS * 60 / BPM_LO / 2)) + 1) if seg.std() > 0 else np.zeros(2)
        row = np.zeros(len(bpms))
        for h, w in enumerate(HARM, 1):
            row += w * np.where(h * lag < len(r) - 1, np.interp(h * lag, np.arange(len(r)), r), 0.0)
        cs.append((a + b) // 2)
        rows.append(np.maximum(row, 0))
    return np.array(cs), np.array(rows)


def _prior(bpms: np.ndarray) -> np.ndarray:
    return np.exp(-0.5 * (np.log2(bpms / PRIOR_BPM) / PRIOR_OCT) ** 2)


def _local_tempo(S: np.ndarray, bpms: np.ndarray, t0: int, span: float = 0.2) -> np.ndarray:
    """Tempo (bpm) per window: Viterbi over tempo bins within `span` of the global tempo, smooth from window to window."""
    ok = np.nonzero(np.abs(np.log(bpms / bpms[t0])) <= span)[0]
    E = S[:, ok] / np.maximum(S[:, ok].max(axis=1, keepdims=True), 1e-9)
    nb = len(ok)
    d = np.arange(nb)[:, None] - np.arange(nb)[None]
    cost = 0.1 * np.minimum(d ** 2, 100.0)
    V = E[0].copy()
    bp = np.zeros((len(E), nb), int)
    for i in range(1, len(E)):
        tot = V[None] - cost                                     # [to, from]
        bp[i] = tot.argmax(axis=1)
        V = tot.max(axis=1) + E[i]
    path = np.zeros(len(E), int)
    path[-1] = V.argmax()
    for i in range(len(E) - 1, 0, -1):
        path[i - 1] = bp[i][path[i]]
    return bpms[ok[path]]


def _dp(o: np.ndarray, tau: np.ndarray, alpha: float) -> np.ndarray:
    """Ellis (2007) beat tracking: C(t) = o(t) + max over the previous beat p of C(p) - alpha log(lag / tau(t))^2; trace back from
    the best end. `tau` is the beat period in frames at each frame, so the tempo may move."""
    n = len(o)
    C = o.astype(float).copy()
    back = np.full(n, -1)
    for t in range(n):
        tt = tau[t]
        lo, hi = max(int(round(tt / 2)), 1), int(round(2 * tt))
        if t - lo < 0:
            continue
        p = np.arange(max(t - hi, 0), t - lo + 1)
        sc = C[p] - alpha * np.log((t - p) / tt) ** 2
        j = int(sc.argmax())
        if sc[j] > 0:
            C[t] += sc[j]
            back[t] = p[j]
    t = int(C.argmax())
    out = [t]
    while back[t] >= 0:
        t = back[t]
        out.append(t)
    return np.array(out[::-1])


def _refine(o: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Beat frames to seconds, each with the parabolic peak of the envelope around it."""
    t = idx.astype(float)
    for k, i in enumerate(idx):
        if 0 < i < len(o) - 1:
            a, b, c = o[i - 1], o[i], o[i + 1]
            d = a - 2 * b + c
            if d < 0 and b >= a and b >= c:
                t[k] += 0.5 * (a - c) / d
    return t / FPS - ENV_DELAY


def beats(x, hint_bpm: float | None = None) -> BeatTrack:
    """Beat times of the audio (`x` a signal or `Features`): tempo from windowed autocorrelations with a broad prior near 100 bpm,
    then a dynamic-programming tracker that follows the tempo as it moves (rubato, accelerando). `hint_bpm` forces the reading
    (a person said "it's double"): the tempo is searched within 12% of it."""
    f = _feat(x)
    o = f.env
    bpms = BPM_LO * (BPM_HI / BPM_LO) ** (np.arange(0, 1.0001, 0.005))
    empty = BeatTrack(np.zeros(0), np.zeros(0), PRIOR_BPM, 0.0)
    if len(o) < int(2 * FPS) or o.max() <= 0:
        return empty
    cs, S = _tempo_scores(o, bpms)
    G = S.mean(axis=0)
    pr = _prior(bpms)
    P = G * pr
    if hint_bpm:
        P = np.where(np.abs(np.log(bpms / hint_bpm)) < 0.12, G, 0.0)
    if P.max() <= 0:
        return empty
    t0 = int(P.argmax())
    loc = _local_tempo(S, bpms, t0)
    tau = 60.0 / np.interp(np.arange(len(o)), cs, loc) * FPS
    idx = _dp(o, tau, ALPHA)
    for _ in range(1):                                           # again, with the tempo the first pass actually played
        if len(idx) > 4:
            iv = np.diff(idx)
            cur = gaussian_filter1d(median_filter(iv.astype(float), 5, mode="nearest"), 2, mode="nearest")
            tau = np.interp(np.arange(len(o)), idx[:-1] + iv / 2, cur)
            idx = _dp(o, tau, ALPHA)
    if len(idx) > 2:                                             # trim beats at either end that nothing sounds on
        peak = maximum_filter1d(o, 5)[idx]
        thr = 0.25 * np.median(peak[peak > 0]) if (peak > 0).any() else 0
        a, b = 0, len(idx)
        while a < b - 2 and peak[a] < thr:
            a += 1
        while b > a + 2 and peak[b - 1] < thr:
            b -= 1
        idx = idx[a:b]
    times = _refine(o, idx)
    if len(times) < 2:
        return empty
    iv = np.diff(times)
    curve = 60.0 / gaussian_filter1d(median_filter(iv, 5, mode="nearest"), 2, mode="nearest")
    curve = np.r_[curve, curve[-1]]
    bpm = float(60.0 * (len(times) - 1) / (times[-1] - times[0]))
    peak = maximum_filter1d(o, 7)[idx]
    support = float(np.mean(peak > 0.3 * np.median(o[o > 0]))) if (o > 0).any() else 0.0
    alts, rival = _alternatives(P, bpms, bpm)
    conf = float(np.clip((1 - rival) / 0.5, 0, 1)) * (0.5 + 0.5 * min(support, 1.0)) if not hint_bpm else 0.6 * (0.5 + 0.5 * support)
    var = float(np.percentile(curve, 95) - np.percentile(curve, 5)) / 2 / bpm
    return BeatTrack(times, curve, bpm, conf, alts, var, support)


def _alternatives(P: np.ndarray, bpms: np.ndarray, bpm: float) -> tuple[list[Alt], float]:
    """The other readings of the tempo (half, double, thirds, 3:2) with their score against the chosen one, and the best rival's
    score (the half/double and any separate peak)."""
    here = np.abs(np.log(bpms / bpm)) < 0.04
    best = max(P[here].max(), 1e-12)
    alts = []
    for r in (0.5, 2.0, 1 / 3, 3.0, 2 / 3, 1.5):
        b = bpm * r
        if not BPM_LO <= b <= BPM_HI:
            continue
        m = np.abs(np.log(bpms / b)) < 0.04
        alts.append(Alt(round(float(bpms[m][P[m].argmax()]), 2), r, float(P[m].max() / best)))
    far = np.abs(np.log(bpms / bpm)) > 0.12
    rival = float(P[far].max() / best) if far.any() else 0.0
    alts.sort(key=lambda a: -a.score)
    return [a for a in alts if a.score >= 0.3], min(rival, 1.0)
