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
    to_grid(event_times, al, fl)          # each event -> (reference beat, subdivision slot) it was played as: GridPos
    subdivisions(ref_beats, fl)           # the slot times of the reference beats for a feel
    analyze(x)                            # features, beats, feel and meter in one call (Timing)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction

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
LOW_W = 0.6                    # the bass band's share in the beat tracker's envelope: beats are where the bass lands
ALPHA = 200.0                  # beat tracker: stiffness of the tempo (cost of a log-ratio away from the local period)


# --- data -----------------------------------------------------------------------------------------


@dataclass
class Features:
    """What the timing functions share, from one pass over the audio."""
    env: np.ndarray              # onset strength per frame (FPS), >= 0
    low: np.ndarray              # the same for the bass band (60-250 Hz)
    rise: np.ndarray             # how far the level rises into each frame, dB (accents: a loud strum, a kick)
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
    S = _stft(np.r_[np.zeros(4 * HOP, np.float32), x], n, HOP)[4:]     # a lead-in of silence, so an onset at t=0 shows as a rise
    k0, k1, kl = int(60 / (SR / n)) + 1, int(8000 / (SR / n)), int(250 / (SR / n))
    L = np.log1p(S[:, k0:k1] * (100.0 / max(S.max(), 1e-9)))
    flux = np.maximum(L[1:] - maximum_filter1d(L[:-1], 3, axis=1), 0)
    env = np.r_[0, flux.sum(axis=1)]
    low = np.r_[0, flux[:, :kl - k0].sum(axis=1)]
    env, low = _clean(env), _clean(low)
    db = 10 * np.log10((S[:, k0:k1] ** 2).sum(axis=1) + 1e-6 * max(S.max() ** 2, 1e-9))
    rise = np.maximum(db - np.r_[np.full(4, db[0]), np.minimum.reduce([db[i:len(db) - 4 + i] for i in range(4)])][:len(db)], 0)
    nc, hc = 4096, 1024
    C = _stft(x, nc, hc)
    f = np.arange(C.shape[1]) * SR / nc
    ok = (f > 80) & (f < 2000)
    pc = (np.round(12 * np.log2(f[ok] / 440)).astype(int) + 9) % 12
    chroma = np.zeros((len(C), 12), np.float32)
    A = np.log1p(C[:, ok] * (100.0 / max(C.max(), 1e-9)))
    for p in range(12):
        chroma[:, p] = A[:, pc == p].sum(axis=1)
    return Features(env, low, rise, chroma, SR / hc, len(x) / SR)


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
    o = f.env + LOW_W * f.low
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
    conf = float(np.clip((1 - rival) / 0.5, 0, 1)) * float(np.clip((support - 0.2) / 0.4, 0, 1)) if not hint_bpm else 0.6 * float(np.clip((support - 0.2) / 0.4, 0, 1))
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


# --- feel -----------------------------------------------------------------------------------------

_FRAC = {"straight16": (0, 1, 2, 3), "triplet8": (0, 1, 2), "triplet16": (0, 1, 2, 3, 4, 5)}
_DEN = {"straight16": 4, "triplet8": 3, "triplet16": 6}


def _cdist(a, b):
    """Circular distance on a period of 1, signed."""
    return (a - b + 0.5) % 1.0 - 0.5


def _gauss(d: np.ndarray, s: float) -> np.ndarray:
    return np.exp(-0.5 * (d / s) ** 2) / (s * np.sqrt(2 * np.pi))


def _fit_mixture(phi: np.ndarray, w: np.ndarray, centres: np.ndarray, sigma: float, eps: float = 0.1) -> tuple[float, np.ndarray]:
    """Weighted log-likelihood of onset phases under a mixture of Gaussians at `centres` (weights fitted by EM) plus uniform clutter."""
    N = _gauss(_cdist(phi[:, None], centres[None]), sigma)
    pi = np.full(len(centres), 1.0 / len(centres))
    for _ in range(25):
        comp = (1 - eps) * N * pi
        p = comp.sum(axis=1) + eps
        pi = (w[:, None] * comp / p[:, None]).sum(axis=0)
        pi = pi / max(pi.sum(), 1e-12)
    p = ((1 - eps) * N * pi).sum(axis=1) + eps
    return float((w * np.log(p)).sum()), pi


def feel(onset_times, beat_times, strengths=None) -> Feel:
    """Subdivision and swing of the playing against the beats (which may be irregular): the onsets' phases within their beat are
    fitted by straight 16ths, triplet 8ths, triplet 16ths and swung 8ths (the off-beat 8th at a fitted 0.52..0.76 of the beat),
    each paying for the positions it uses. Few onsets -> straight, low confidence. `offset_s`: where the on-beat onsets sit
    against the beat."""
    t = np.asarray(onset_times, float)
    B = np.asarray(beat_times, float)
    w = np.ones(len(t)) if strengths is None else np.asarray(strengths, float)
    if len(B) < 3 or len(t) == 0:
        return Feel("straight16", 0.5, 0.0, 0.0, 0)
    k = np.searchsorted(B, t, "right") - 1
    ok = (k >= 0) & (k < len(B) - 1) & (w >= 0.15)
    t, k, w = t[ok], k[ok], w[ok]
    L = np.diff(B)[k] if len(k) else np.zeros(0)
    phi = (t - B[k]) / np.maximum(L, 1e-6) if len(k) else np.zeros(0)
    Lm = float(np.median(np.diff(B)))
    neff = float(w.sum())
    if neff < 8:
        return Feel("straight16", 0.5, 0.0, 0.1 * neff / 8, len(t))
    sigma = float(np.clip(0.02 / Lm, 0.03, 0.06))
    ds = np.arange(-0.15, 0.1501, 0.005)
    sc = np.array([(w * _gauss(_cdist(phi, d), sigma)).sum() for d in ds])
    d0 = ds[int(sc.argmax())]
    near = np.abs(_cdist(phi, d0)) < 0.08
    d0 = d0 + float(np.average(_cdist(phi[near], d0), weights=w[near])) if near.any() else d0
    off_s = float(np.median(_cdist(phi[near], 0.0) * L[near])) if near.any() else 0.0
    cands = [(kind, 0.5, np.array(_FRAC[kind]) / _DEN[kind]) for kind in _FRAC]
    cands += [("swing8", r, np.array([0.0, r])) for r in np.arange(0.52, 0.7601, 0.01)]
    best: dict[str, tuple[float, float, np.ndarray, frozenset]] = {}
    for kind, r, pos in cands:
        ll, pi = _fit_mixture(phi, w, (pos + d0) % 1.0, sigma)
        used = int((pi * neff >= max(2.0, 0.05 * neff)).sum())
        score = ll - 0.5 * np.log(neff) * (used + (1 if kind == "swing8" else 0)) - 0.25 * len(pos)       # each position it could use costs a little
        if kind not in best or score > best[kind][0]:
            best[kind] = (score, r, pi, frozenset(int(round(q * 50)) % 50 for q, u in zip(pos, pi * neff >= max(2.0, 0.05 * neff)) if u))
    order = sorted(best, key=lambda kd: -best[kd][0])
    top = order[0]
    rival = [kd for kd in order[1:] if best[kd][3] != best[top][3]                 # a model that plays the same positions says the same thing
             and not (kd == "swing8" and top == "straight16" and best[kd][1] < 0.56)
             and not ({kd, top} == {"swing8", "triplet8"} and 0.63 < best["swing8"][1] < 0.70)]       # a swing at 2/3 is a triplet feel      # a barely swung 8th is a straight one
    gap = best[top][0] - best[rival[0]][0] if rival else 20.0
    conf = float((1 - np.exp(-gap / 6)) * np.clip((neff - 6) / 20, 0, 1))
    r = best[top][1] if top == "swing8" else {"triplet8": 2 / 3}.get(top, 0.5)
    if top == "triplet8" and best[top][2][1] * neff < max(2.0, 0.08 * neff):      # nothing on the middle triplet: a swung 8th at 2/3
        top = "swing8"
    return Feel(top, float(round(r, 3)), off_s, conf, len(t))


def notated(f: Feel) -> tuple:
    """The subdivision slots of a beat as Fractions (a swung 8th is notated at 1/2: swing is how it is played)."""
    from fractions import Fraction
    if f.kind == "swing8":
        return (Fraction(0), Fraction(1, 2))
    d = _DEN[f.kind]
    return tuple(Fraction(i, d) for i in _FRAC[f.kind])


def subdivisions(beat_times, f: Feel, extend: bool = True) -> np.ndarray:
    """Every subdivision point of the beats, in seconds, for feel `f` (ending with the last beat itself)."""
    B = np.asarray(beat_times, float)
    pos = np.array(f.positions())
    out = (B[:-1, None] + np.diff(B)[:, None] * pos[None]).ravel()
    return np.r_[out, B[-1]]


# --- meter ----------------------------------------------------------------------------------------


def _env_onsets(env: np.ndarray, thr: float = 0.3) -> np.ndarray:
    i = np.nonzero((env >= maximum_filter1d(env, 5)) & (env > thr))[0]
    return i / FPS - ENV_DELAY


def _beat_features(f: Features, B: np.ndarray, chord_changes=None) -> dict[str, np.ndarray]:
    """Per beat: the strongest onset around it, the bass band's, and how much the harmony changes there."""
    n = len(B)
    ti = lambda a: np.clip((np.asarray(a) * FPS).round().astype(int), 0, len(f.env) - 1)
    acc, low, lvl = np.zeros(n), np.zeros(n), np.zeros(n)
    for k, b in enumerate(B):
        a, c = ti(b - 0.05 + ENV_DELAY), ti(b + 0.08 + ENV_DELAY)
        acc[k], low[k], lvl[k] = f.env[a:c + 1].max(), f.low[a:c + 1].max(), f.rise[a:c + 1].max()
    L = np.r_[np.diff(B), np.diff(B)[-1]]
    if chord_changes is not None:
        cc = np.asarray(chord_changes, float)
        chord = np.array([float(len(cc) and np.abs(cc - b).min() < 0.4 * L[k]) for k, b in enumerate(B)])
    else:
        ci = lambda t: int(np.clip(round(t * f.chroma_fps), 0, len(f.chroma) - 1))
        chord = np.zeros(n)
        for k, b in enumerate(B):
            if k == 0:
                continue
            a0, a1, p0, p1 = ci(b + 0.1 * L[k]), ci(b + 0.9 * L[k]), ci(B[k - 1] + 0.1 * L[k - 1]), ci(b - 0.1 * L[k - 1])
            after, before = f.chroma[a0:max(a1, a0) + 1].mean(axis=0), f.chroma[p0:max(p1, p0) + 1].mean(axis=0)
            den = np.linalg.norm(after) * np.linalg.norm(before)
            chord[k] = 1 - float(after @ before) / den if den > 1e-9 else 0.0
    return {"acc": acc, "low": low, "lvl": lvl, "chord": chord}


def _tstat(v: np.ndarray, P: int, ph: int, floor: float) -> float:
    m = (np.arange(len(v)) - ph) % P == 0
    na, nb = int(m.sum()), int((~m).sum())
    if na < 2 or nb < 2:
        return 0.0
    return float((v[m].mean() - v[~m].mean()) / (max(v.std(), floor) * np.sqrt(1 / na + 1 / nb)))


def _soft(t: float) -> float:
    """Evidence against a downbeat (an accent that is weaker there) counts for less than evidence for it: syncopation is normal."""
    return t if t > 0 else 0.3 * t


FEATURE_W = {"acc": (0.6, 0.1), "low": (0.6, 0.1), "lvl": (1.0, 1.0), "chord": (1.2, 0.04)}      # weight, floor of the spread (envelope units)


def meter(x, beat_times, feel_: Feel | None = None, chord_changes=None) -> Meter:
    """Beats per bar (2, 3 or 4), unit and the first downbeat of the beats given. Every (beats per bar, phase) is scored by how
    much more the beats on its bar lines carry: an onset, bass energy, a change of harmony (cheap beat chroma, or `chord_changes`,
    seconds). `feel_` with a triplet subdivision makes the beat a dotted quarter (6/8, 9/8, 12/8). Confidence: how far the best
    stands over noise and over the runner-up."""
    f = _feat(x)
    B = np.asarray(beat_times, float)
    if len(B) < 6:
        return Meter(4, "4", 0, float(B[0]) if len(B) else 0.0, 0.0)
    if feel_ is None:
        feel_ = feel(_env_onsets(f.env), B)
    feats = _beat_features(f, B, chord_changes)
    cand = [(P, ph) for P in (4, 3, 2) for ph in range(P)]
    T = {k: np.array([_tstat(feats[k], P, ph, fl) for P, ph in cand]) for k, (w, fl) in FEATURE_W.items()}
    use = [k for k in T if T[k].max() >= 3.0] or list(T)              # only the features that say something count; the rest is noise
    tot = sum(FEATURE_W[k][0] * np.where(T[k] > 0, T[k], 0.3 * T[k]) for k in use) / np.sqrt(sum(FEATURE_W[k][0] ** 2 for k in use))
    sc = {c: float(v) for c, v in zip(cand, tot)}
    order = sorted(sc, key=lambda k: -sc[k])
    (P, ph), best = order[0], sc[order[0]]
    ru = next(k for k in order[1:])
    conf = float(np.clip((best - 2.3) / 2.0, 0, 1) * np.clip((best - sc[ru]) / max(best, 1e-9) / 0.25, 0, 1))
    third = feel_.kind == "triplet8" and feel_.confidence >= 0.3
    shuffle = feel_.kind == "swing8" and 0.63 < feel_.swing_ratio < 0.70           # two beats to a bar with a swing at 2/3 is 6/8
    unit = "8" if third or (shuffle and P == 2) else "4"
    run = Reading(ru[0], unit, ru[1], round(sc[ru], 2))
    if P == 2 and (third or shuffle) or (feel_.kind == "triplet8" and feel_.confidence < 0.6):      # 6/8 or 2/4 swung, 3/4 or 6/8: say so
        run = Reading(P, "4" if unit == "8" else "8", ph, round(sc[(P, ph)], 2))
        conf *= 0.6 if shuffle and not third else 1.0
    return Meter(P, unit, ph, float(B[ph]), conf, run, {k: round(v, 2) for k, v in sc.items()})


# --- alignment to a reference grid ----------------------------------------------------------------


def _extend(ref: np.ndarray) -> tuple[np.ndarray, int]:
    """The reference beats with two extra beats at either end (at the nearest beat length), and how many were added before."""
    d0, d1 = ref[1] - ref[0], ref[-1] - ref[-2]
    return np.r_[ref[0] - d0 * np.arange(2, 0, -1), ref, ref[-1] + d1 * np.arange(1, 3)], 2


def _beat_coord(t: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """Time -> position in beats (beat i is at i), through the possibly irregular reference beats, extended past both ends."""
    E, pre = _extend(ref)
    return np.interp(t, E, np.arange(len(E)) - pre)


def _smooth(v: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian smoothing that keeps a slope to the ends (the ends are reflected through their own points, not flattened)."""
    k = min(int(4 * sigma) + 1, len(v) - 1)
    if k < 1:
        return v.copy()
    p = np.r_[2 * v[0] - v[k:0:-1], v, 2 * v[-1] - v[-2:-k - 2:-1]]
    return gaussian_filter1d(p, sigma)[k:-k]


def _local_line(x: np.ndarray, y: np.ndarray, w: np.ndarray, at: np.ndarray, sigma: float) -> np.ndarray:
    """Robust local-linear smoother: the weighted line through the points near each `at` (Gaussian, `sigma`), twice, the second time
    without the points more than 25 ms off the first fit. nan where nothing is near."""
    out = np.full(len(at), np.nan)
    for i, c in enumerate(at):
        k = np.exp(-0.5 * ((x - c) / sigma) ** 2) * w
        if k.sum() < 0.2:
            continue
        v = np.nan
        for rnd in range(2):
            d = x - c
            sw, sx, sxx = k.sum(), (k * d).sum(), (k * d * d).sum()
            sy, sxy = (k * y).sum(), (k * d * y).sum()
            det = sw * sxx - sx * sx
            ridge = 0.3 * sw                                                   # a slope needs spread; with little, stay flat
            b = (sw * sxy - sx * sy) / (det + ridge * sw) if det + ridge * sw > 1e-12 else 0.0
            v = (sy - b * sx) / sw
            if rnd == 0:
                k = k * (np.abs(y - (v + b * d)) < 0.025)
                if k.sum() < 0.2:
                    break
        out[i] = v
    return out


def _onset_curve(t: np.ndarray, w: np.ndarray, ref: np.ndarray, bpb: int, s0: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, float]:
    """Offset (in beats, per reference beat) of the on-beat onsets from the reference: in windows of 4 beats the phase that most
    onsets sit at (a circular comb), smooth from window to window (Viterbi on the circle), unwrapped so it can run away from the
    grid by more than a beat, then refined from the onsets near it (`s0`: a first curve in beats, instead of the comb). Returns (offset in seconds per beat, weight of onsets per beat,
    share of the onset weight that sits on the beats)."""
    n = len(ref)
    u = _beat_coord(t, ref)
    nb = 64
    cs = np.arange(n, dtype=float)
    shifts = (np.arange(nb) / nb) - 0.5
    sig = 0.07
    E = np.zeros((n, nb))
    tot = np.zeros(n)
    for i, c in enumerate(cs):
        m = np.abs(u - c) <= 2.0
        if m.any():
            d = _cdist((u[m] % 1.0)[:, None], shifts[None])
            E[i] = (w[m, None] * np.exp(-0.5 * (d / sig) ** 2)).sum(axis=0)
            tot[i] = w[m].sum()
    En = E / np.maximum(tot[:, None], 1e-9)
    if s0 is not None:
        En = np.zeros_like(En)
    dd = np.abs(_cdist(np.arange(nb)[:, None] / nb, np.arange(nb)[None] / nb)) * nb
    cost = 1.5 * (dd / 8) ** 2
    V = En[0] - 0.5 * np.abs(shifts) * 4
    bp = np.zeros((n, nb), int)
    for i in range(1, n):
        tt = V[None] - cost
        bp[i] = tt.argmax(axis=1)
        V = tt.max(axis=1) + En[i] * (1.0 if tot[i] > 0 else 0.0)
    path = np.zeros(n, int)
    path[-1] = int(V.argmax())
    for i in range(n - 1, 0, -1):
        path[i - 1] = bp[i][path[i]]
    s = np.unwrap(shifts[path] * 2 * np.pi) / (2 * np.pi) if s0 is None else s0                  # beats, continuous
    sb = np.interp(u, cs, s)                                                  # the comb's offset at each onset, beats
    j = np.round(u - sb).astype(int)                                          # the reference beat each onset belongs to
    keep = (np.abs(u - j - sb) < 0.15) & (j >= -2) & (j < n + 2)
    E_, pre = _extend(ref)
    jk, wk = j[keep], w[keep]
    sec = t[keep] - E_[jk + pre]
    sm = _local_line(jk.astype(float), sec, wk, np.arange(n, dtype=float), max(bpb * 0.5, 1.5))
    miss = ~np.isfinite(sm)
    if miss.any():
        L = np.diff(ref)
        sm[miss] = (s * np.r_[L, L[-1]])[miss]
    share = float(w[np.abs(_cdist(u - sb, 0.0)) < 0.1].sum() / max(w.sum(), 1e-9))
    return sm, tot, share


def _dtw_curve(a: np.ndarray, ref: np.ndarray, kappa: float = 0.5) -> np.ndarray:
    """Match audio beats to reference beats in order (monotonic, either side may skip a beat at a price) so the offset stays
    continuous from beat to beat; the offset in seconds per reference beat."""
    I, J = len(a), len(ref)
    L = float(np.median(np.diff(ref)))
    D = (a[:, None] - ref[None]) / L                                       # offsets in beats
    INF = 1e18
    C = np.full((I, J), INF)
    bk = np.zeros((I, J, 2), int)
    for i in range(I):
        for j in range(J):
            best, prev = 2.0 * abs(D[i, j]) + kappa * (i + j), (-1, -1)         # start anywhere, a late start costs the beats skipped
            for pi, pj, pc in ((i - 1, j - 1, 0.0), (i - 1, j, kappa), (i, j - 1, kappa)):
                if pi >= 0 and pj >= 0 and C[pi, pj] < INF:
                    c = C[pi, pj] + pc + abs(D[i, j] - D[pi, pj])
                    if c < best:
                        best, prev = c, (pi, pj)
            C[i, j], bk[i, j] = best, prev
    end = C + kappa * ((I - 1 - np.arange(I))[:, None] + (J - 1 - np.arange(J))[None])
    i, j = np.unravel_index(int(end.argmin()), end.shape)
    pairs = []
    while i >= 0:
        pairs.append((i, j))
        i, j = bk[i, j]
    off = np.full(J, np.nan)
    for i, j in pairs[::-1]:
        off[j] = a[i] - ref[j] if np.isnan(off[j]) or abs(a[i] - ref[j]) < abs(off[j]) else off[j]
    ok = ~np.isnan(off)
    return np.interp(np.arange(J), np.nonzero(ok)[0], off[ok])


def align(onset_times, ref_beats, audio_beats=None, strengths=None, beats_per_bar: int = 4) -> Alignment:
    """How the playing sits against reference beats (a click, a project's time map): the offset in seconds at each reference beat,
    a smooth curve (about two bars) from the phase of the onsets within their beat, unwrapped so a take that rushes or drags can
    leave the grid by more than a beat (played beat k is reference beat k). Where the curve strays by over a third of a beat and
    `audio_beats` (from `beats`) are given, they are matched to the reference beats in order instead. kind: 'tight' (within
    ~20 ms), 'feel' (a steady offset: latency, laid back), 'drifting' (the offset moves by over ~45 ms). Never refuses."""
    ref = np.asarray(ref_beats, float)
    t = np.asarray(onset_times, float)
    if len(ref) < 3:
        return Alignment(np.zeros(len(ref)), 0.0, 0.0, "tight", ref.copy(), 0.0, "onsets", 0.0, 0)
    w = np.ones(len(t)) if strengths is None else np.asarray(strengths, float)
    L = float(np.median(np.diff(ref)))
    ok = (w >= 0.2) & (t >= ref[0] - 0.75 * L) & (t <= ref[-1] + 0.75 * L)
    t, w = t[ok], w[ok]
    if len(t) < 4:
        return Alignment(np.zeros(len(ref)), 0.0, 0.0, "tight", ref.copy(), 0.0, "onsets", 0.0, len(t))
    curve, tot, share = _onset_curve(t, w, ref, beats_per_bar)
    method = "onsets"
    conf = float(np.clip((share - 0.3) / 0.4, 0, 1) * min(1.0, len(t) / 20))
    if audio_beats is not None and len(audio_beats) >= 3 and np.abs(curve).max() > L / 3:
        rough = _dtw_curve(np.asarray(audio_beats, float), ref)
        curve, tot, share = _onset_curve(t, w, ref, beats_per_bar, rough / np.r_[np.diff(ref), np.diff(ref)[-1]])     # then the onsets pin it down
        method = "beats"
        if share < 0.3:
            curve = _smooth(rough, 1.0)
        conf = min(conf + 0.2, 1.0) if conf > 0 else 0.3
    mean = float(curve.mean())
    rng = float(np.percentile(curve, 95) - np.percentile(curve, 5))
    drift = float(np.polyfit(np.arange(len(curve)), curve, 1)[0] * (len(curve) - 1)) if len(curve) > 2 else 0.0
    kind = "drifting" if rng > 0.045 else "feel" if abs(mean) > 0.02 else "tight"
    return Alignment(curve, mean, float(np.abs(curve).max()), kind, ref + curve, conf, method, drift, len(t))


# --- played beats -> the project grid ---------------------------------------------------------------


@dataclass
class GridPos:
    """Where an event was played, in the reference's terms: reference beat `beat` (an index into `ref_beats`) plus subdivision slot
    `slot` of `feel`'s subdivision of it; `position` = beat + the slot's notated fraction (a swung 8th is notated at 1/2)."""
    beat: int
    slot: int
    position: Fraction
    error_s: float               # event time minus where the slot was played (what a quantiser would have moved it)
    error_beats: float


def to_grid(event_times, al: Alignment, f: Feel | None = None) -> list[GridPos]:
    """Map events (chord changes, notes, accents; seconds) to the project beat and slot they were played as. Played beat k is
    reference beat k: an event is placed in the frame of `al.played_beats` (the reference beats moved by the offset curve), at the
    nearest subdivision slot of feel `f` (default straight 16ths). A late, early, rushing or dragging take comes out on the project's
    grid, so a part written from it stays on the click. Events outside the beats are placed by extending the first/last beat."""
    f = f or Feel("straight16", 0.5, 0.0, 0.0)
    P = np.asarray(al.played_beats, float)
    if len(P) < 2:
        return []
    pos = np.array(f.positions())
    fr = notated(f)
    ext, pre = _extend(P)
    out = []
    for t in np.asarray(event_times, float):
        u = float(np.interp(t, ext, np.arange(len(ext)) - pre))              # in played beats
        k = int(np.floor(u))
        x = u - k
        cand = np.r_[pos, 1.0]
        j = int(np.abs(cand - x).argmin())
        beat, slot = (k + 1, 0) if j == len(pos) else (k, j)
        frac = Fraction(0) if j == len(pos) else fr[j]
        kk = min(max(k, 0), len(P) - 2)
        out.append(GridPos(beat, slot, Fraction(beat) + frac, float((x - cand[j]) * (P[kk + 1] - P[kk])), float(x - cand[j])))
    return out


# --- grids for the chord and note hearing ------------------------------------------------------------


def played_grid(al: Alignment, ref: Grid) -> Grid:
    """The reference grid with its beats moved to where the take played them: `hear_chords` / `hear_notes` / `hear` on this hear one
    chord per beat actually played, whatever the take's offset or drift."""
    n = len(ref.beats)
    P = list(map(float, al.played_beats[:n]))
    if len(P) < n:
        P += [P[-1] + (P[-1] - P[-2] if len(P) > 1 else 0.5) * (i + 1) for i in range(n - len(P))]
    end = None if ref.end is None else P[-1] + (ref.end - ref.beats[-1])
    return Grid(P, list(ref.bar_starts), end)


def audio_grid(bt: BeatTrack, mt: Meter | None = None, per_bar: int = 4) -> Grid:
    """A Grid on the audio's own beats, with bar lines from the meter's downbeat (every `per_bar` beats from the first when no meter)."""
    B = [float(b) for b in bt.times]
    bpb, d0 = (mt.beats_per_bar, mt.downbeat_index) if mt else (per_bar, 0)
    starts = [i >= d0 and (i - d0) % bpb == 0 for i in range(len(B))]
    iv = float(np.median(np.diff(B))) if len(B) > 1 else 0.5
    return Grid(B, starts, B[-1] + iv if B else None)


def analyze(x) -> Timing:
    """Features, beats, feel (on the beats found) and meter of a take in one call, for an audio-only project."""
    x = np.asarray(x, np.float32)
    f = features(x)
    bt = beats(f)
    o = onsets(x)
    fl = feel(o.times, bt.times, o.strengths)
    return Timing(f, bt, fl, meter(f, bt.times, fl), o.times)
