"""Hearing: tuning, onsets, rhythm, key and chords from mono audio on a known beat grid.

Pure numpy/scipy on in-memory signals at 22050 Hz (`prepare` converts). The caller supplies the
beat grid in seconds (so any tempo map works); everything is reported per beat or per bar of it.
Debug CLI: python -m badmidi.audio.hear take.wav --bpm 100 --meter 4/4
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from math import gcd

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.ndimage import maximum_filter1d, median_filter, uniform_filter1d
from scipy.signal import resample_poly

from ..core import pc_name

SR = 22050
LOW, HIGH = 33, 96            # semitone filterbank range, MIDI A1..C7
BASS_TOP = 59                 # bass chroma: below ~250 Hz (B3)


# --- data -----------------------------------------------------------------------------------------


@dataclass
class Grid:
    """Beat start times in seconds, which beats start a bar, and where the last beat ends."""
    beats: list[float]
    bar_starts: list[bool]
    end: float | None = None

    @staticmethod
    def regular(bpm: float, per_bar: int = 4, n_beats: int = 16, offset: float = 0.0) -> "Grid":
        d = 60.0 / bpm
        return Grid([offset + i * d for i in range(n_beats)], [i % per_bar == 0 for i in range(n_beats)],
                    offset + n_beats * d)

    def edges(self) -> np.ndarray:
        """n+1 beat edges: the beat starts plus the end of the last beat."""
        b = np.asarray(self.beats, float)
        last = self.end if self.end is not None else b[-1] + (np.median(np.diff(b)) if len(b) > 1 else 0.5)
        return np.append(b, last)

    def position(self, i: int) -> int:
        """Index of beat i within its bar (0 on bar lines; the first bar may start mid-bar)."""
        n = 0
        for j in range(i, -1, -1):
            if self.bar_starts[j]:
                return n
            n += 1
        return n

    def bars(self) -> list[tuple[int, int]]:
        """(first beat, end beat) of each bar."""
        starts = [i for i, s in enumerate(self.bar_starts) if s]
        if not starts or starts[0] != 0:
            starts.insert(0, 0)
        return list(zip(starts, starts[1:] + [len(self.beats)]))


@dataclass
class Onsets:
    times: list[float]
    strengths: list[float]       # 0..1, against the 90th percentile


@dataclass
class Rhythm:
    """Onset strength (0..1) per slot, one list per bar."""
    slots_per_beat: int
    bars: list[list[float]]


@dataclass
class GridCheck:
    mean_offset: float           # seconds, onsets minus the nearest 16th-note slot (positive = late)
    drift: float                 # seconds of offset change across the take
    spread: float                # robust spread of the offsets, seconds
    on_grid: bool
    n: int = 0                   # onsets used


@dataclass
class Key:
    tonic: int
    mode: str                    # 'major' | 'minor'
    name: str                    # 'A minor'
    score: float                 # correlation with the profile
    margin: float                # lead over the next key


@dataclass
class ChordSpan:
    start_beat: int
    end_beat: int                # exclusive
    symbol: str
    root_pc: int
    quality: str
    bass_pc: int
    confidence: float
    runner_up: tuple[str, float] | None = None
    implied: str = ""            # for a power chord: 'm' or '' (major) as read from the key


@dataclass
class Heard:
    tuning_cents: float
    key: Key
    grid_check: GridCheck
    chords: list[ChordSpan]
    rhythm: Rhythm
    onsets: Onsets = field(default_factory=lambda: Onsets([], []))


# --- front end ------------------------------------------------------------------------------------


def prepare(x, sr: int) -> np.ndarray:
    """Mono float32 at 22050 Hz from any (samples,) or (samples, channels) array."""
    x = np.asarray(x, np.float32)
    if x.ndim == 2:
        x = x.mean(axis=1 if x.shape[1] <= x.shape[0] else 0)
    if sr != SR:
        g = gcd(SR, int(sr))
        x = resample_poly(x, SR // g, int(sr) // g).astype(np.float32)
    return np.ascontiguousarray(x)


def _stft(x: np.ndarray, n: int, hop: int, pad_to: int | None = None) -> np.ndarray:
    """Magnitude STFT, frames x bins; frame i is centred on sample i*hop."""
    xp = np.pad(x.astype(np.float32), (n // 2, n // 2 + hop), mode="reflect" if len(x) > n else "constant")
    win = np.hanning(n + 1)[:-1].astype(np.float32)
    frames = sliding_window_view(xp, n)[::hop][: len(x) // hop + 1]
    out = np.empty((len(frames), (pad_to or n) // 2 + 1), np.float32)
    for i in range(0, len(frames), 256):
        out[i:i + 256] = np.abs(np.fft.rfft(frames[i:i + 256] * win, pad_to or n, axis=1))
    return out


def tuning_offset(x: np.ndarray) -> float:
    """Cents the recording sits above 12-TET A440 (-50..50), from the strong spectral peaks."""
    n, nfft = 4096, 16384
    S = _stft(x, n, 2048, nfft)
    df = SR / nfft
    k0, k1 = int(100 / df), int(2000 / df)
    mid = S[:, k0:k1]
    pk = (mid[:, 1:-1] > mid[:, :-2]) & (mid[:, 1:-1] >= mid[:, 2:]) & (mid[:, 1:-1] > 0.05 * S.max(axis=1, keepdims=True)) \
        & (mid[:, 1:-1] > 0.01 * S.max())
    fi, ki = np.nonzero(pk)
    if not len(fi):
        return 0.0
    ki = ki + 1
    la, lb, lc = (np.log(mid[fi, ki + d] + 1e-9) for d in (-1, 0, 1))
    delta = np.clip(0.5 * (la - lc) / (la - 2 * lb + lc - 1e-12), -0.5, 0.5)
    f = (ki + k0 + delta) * df
    cents = ((12 * np.log2(f / 440) + 0.5) % 1 - 0.5) * 100
    w = mid[fi, ki]
    hist = np.bincount(((cents + 50) % 100).astype(int) % 100, weights=w, minlength=100)
    sm = np.convolve(np.r_[hist[-6:], hist, hist[:6]], np.exp(-0.5 * (np.arange(-6, 7) / 2.0) ** 2), "valid")
    c0 = np.argmax(sm) - 50 + 0.5
    near = np.abs((cents - c0 + 50) % 100 - 50) < 8
    return float(c0 + np.average((cents[near] - c0 + 50) % 100 - 50, weights=w[near])) if near.any() else float(c0)


def _filterbank(n: int, cents: float, lo: int = LOW, hi: int = HIGH) -> np.ndarray:
    """Triangular semitone filters (tuning-shifted) over an n-point rfft, one row per MIDI note lo..hi."""
    f = np.arange(n // 2 + 1) * SR / n
    fc = 440 * 2.0 ** ((np.arange(lo, hi + 1) - 69) / 12 + cents / 1200)
    half = np.maximum(fc * (2 ** (0.5 / 12) - 1), 1.2 * SR / n)[:, None]
    W = np.maximum(0, 1 - np.abs(f[None] - fc[:, None]) / half)
    return W / np.maximum(W.sum(axis=1, keepdims=True), 1e-9)


HARMONICS = ((19, .9), (28, .6), (34, .3), (38, 0.0))   # (semitones above the note, share subtracted): 3rd, 5th, 7th, 9th


def _whiten(L: np.ndarray) -> np.ndarray:
    """Log-spectrum frames x semitones -> whitened, harmonic-suppressed salience (>= 0)."""
    L = L - uniform_filter1d(L, 25, axis=1, mode="nearest")        # flatten the spectral envelope
    L = np.maximum(L, 0)
    out = L.copy()
    for k, w in HARMONICS:                                           # energy k semitones up is partly this note's harmonic
        out[:, k:] -= w * L[:, :-k]
    return np.maximum(out, 0)


SPLIT = 57   # below this MIDI note use the long window (resolution) and sharpen across neighbours


def _salience(x: np.ndarray, cents: float, n: int, hop: int = 512) -> np.ndarray:
    S = _stft(x, n, hop) @ _filterbank(n, cents).T
    return _whiten(np.log1p(S * (200.0 / max(S.max(), 1e-9))))


def _sharpen(L: np.ndarray, hi: int) -> np.ndarray:
    """Low notes: a filter's neighbours leak into it; keep local maxima across semitones, damp the rest."""
    k = hi - LOW + 1
    a = L[:, :k]
    nb = np.maximum(np.pad(a, ((0, 0), (1, 0)))[:, :k], np.pad(a, ((0, 0), (0, 1)))[:, 1:])
    L = L.copy()
    L[:, :k] = np.where(a >= nb, a, 0.25 * a)
    return L


def _salience2(x: np.ndarray, cents: float, hop: int = 512) -> tuple[np.ndarray, np.ndarray]:
    """(full-range salience, long-window salience) with the low notes taken from the long window."""
    Lb = _sharpen(_salience(x, cents, 8192, hop), SPLIT)
    L = _salience(x, cents, 4096, hop)
    m = min(len(L), len(Lb))
    L, Lb = L[:m].copy(), Lb[:m]
    L[:, :SPLIT - LOW] = Lb[:, :SPLIT - LOW]
    return L, Lb


def _fold(L: np.ndarray, lo: int, hi: int) -> np.ndarray:
    """Salience over MIDI lo..hi (inclusive) folded to 12 pitch classes."""
    out = np.zeros((len(L), 12), np.float32)
    for m in range(max(lo, LOW), min(hi, HIGH) + 1):
        out[:, m % 12] += L[:, m - LOW]
    return out


# --- onsets, rhythm, grid -------------------------------------------------------------------------


ONSET_DELAY = 0.0   # seconds to subtract from the flux peak time (set from measurement)


def onsets(x: np.ndarray) -> Onsets:
    """Spectral-flux onsets with an adaptive threshold; strengths relative to the strong ones, clipped at 1."""
    n, hop = 1024, 256
    lead = n // 2                                    # a lead-in of silence so an onset at t=0 shows as a rise
    S = _stft(np.r_[np.zeros(lead, np.float32), x], n, hop)
    k0, k1 = int(60 / (SR / n)), int(8000 / (SR / n))
    L = np.log1p(S[:, k0:k1] * (100.0 / max(S.max(), 1e-9)))
    flux = np.maximum(L[1:] - maximum_filter1d(L[:-1], 3, axis=1), 0).sum(axis=1)
    flux = np.r_[0, flux]
    if flux.max() <= 0:
        return Onsets([], [])
    flux = flux / max(np.percentile(flux, 99), 1e-9)
    thr = median_filter(flux, 2 * int(0.5 * SR / hop) + 1, mode="nearest") + 0.15
    cand = np.nonzero((flux >= maximum_filter1d(flux, 5)) & (flux > thr))[0]
    keep: list[int] = []
    for i in cand:                                   # strongest first within 50 ms
        if keep and i - keep[-1] < 4:
            if flux[i] > flux[keep[-1]]:
                keep[-1] = i
        else:
            keep.append(i)
    if not keep:
        return Onsets([], [])
    idx = np.array(keep)
    st = flux[idx] - thr[idx]
    start = idx.copy()
    for k, i in enumerate(idx):                      # a slow attack: the onset is where the rise began
        while start[k] > 0 and i - start[k] < 6 and flux[start[k] - 1] > 0.3 * flux[i]:
            start[k] -= 1
    return Onsets(((start * hop - lead) / SR - ONSET_DELAY).tolist(), np.minimum(st / max(np.percentile(st, 90), 1e-9), 1.0).tolist())


def _slot_times(grid: Grid, spb: int) -> np.ndarray:
    e = grid.edges()
    return (e[:-1, None] + (e[1:] - e[:-1])[:, None] * np.arange(spb)[None] / spb).ravel()


def rhythm(x_or_onsets, grid: Grid, slots_per_beat: int = 4, shift: float = 0.0) -> Rhythm:
    """Onset strength per slot (default 16ths) for each bar of the grid. `shift` is subtracted from onset times."""
    o = x_or_onsets if isinstance(x_or_onsets, Onsets) else onsets(x_or_onsets)
    slots = _slot_times(grid, slots_per_beat)
    acc = np.zeros(len(slots))
    t = np.asarray(o.times) - shift
    if len(t):
        j = np.clip(np.searchsorted(slots, t) - 1, 0, len(slots) - 1)
        j = np.where(np.abs(slots[np.minimum(j + 1, len(slots) - 1)] - t) < np.abs(slots[j] - t), j + 1, j)
        ok = (t >= slots[0] - 0.05) & (t < grid.edges()[-1] + 0.05)
        np.maximum.at(acc, j[ok], np.asarray(o.strengths)[ok])
    return Rhythm(slots_per_beat, [acc[a * slots_per_beat:b * slots_per_beat].round(3).tolist() for a, b in grid.bars()])


def grid_check(onset_times, grid: Grid, strengths=None, slots_per_beat: int = 4,
               max_offset: float = 0.03, max_spread: float = 0.03) -> GridCheck:
    """Do the onsets sit on the 16th-note slots? Mean offset, drift across the take, robust spread."""
    t = np.asarray(onset_times, float)
    if strengths is not None:
        t = t[np.asarray(strengths) >= 0.2]
    slots = _slot_times(grid, slots_per_beat)
    t = t[(t >= slots[0] - 0.05) & (t < grid.edges()[-1])]
    if len(t) < 4:
        return GridCheck(0.0, 0.0, 0.0, False, len(t))
    j = np.clip(np.searchsorted(slots, t), 1, len(slots) - 1)
    j = np.where(np.abs(slots[j] - t) < np.abs(slots[j - 1] - t), j, j - 1)
    off = t - slots[j]
    slot = float(np.median(np.diff(slots)))
    un = np.unwrap(off / slot * 2 * np.pi) / (2 * np.pi) * slot
    mean = float(np.median(off))
    spread = float(1.4826 * np.median(np.abs(off - mean)))
    slope = np.polyfit(t, un, 1)[0]
    drift = float(slope * (t[-1] - t[0]))
    return GridCheck(mean, drift, spread, bool(abs(mean) <= max_offset and spread <= max_spread and abs(drift) <= max_offset), len(t))


# --- chords ---------------------------------------------------------------------------------------

# quality -> (suffix, [(interval, weight)], prior)
QUALITIES: dict[str, tuple[str, list[tuple[int, float]], float]] = {
    "maj": ("", [(0, 1), (4, .9), (7, .7)], 1.0),
    "min": ("m", [(0, 1), (3, .9), (7, .7)], 1.0),
    "7": ("7", [(0, 1), (4, .9), (7, .65), (10, .4)], 0.99),
    "maj7": ("maj7", [(0, 1), (4, .9), (7, .65), (11, .4)], 0.99),
    "m7": ("m7", [(0, 1), (3, .9), (7, .65), (10, .4)], 0.99),
    "sus2": ("sus2", [(0, 1), (2, .9), (7, .7)], 0.97),
    "sus4": ("sus4", [(0, 1), (5, .9), (7, .7)], 0.97),
    "dim": ("dim", [(0, 1), (3, .9), (6, .7)], 0.96),
    "5": ("5", [(0, 1), (7, .8)], 0.99),
}
NAMES = list(QUALITIES)
N_SCORE = 0.5            # how well "no chord" matches a sounding beat
BASS_W = 0.15            # bonus for a chord whose root is what the bass plays
BETA = 12.0              # emission scale for Viterbi
CHANGE = 1.6             # change penalty (emission units) on a weak beat
CONF_T = 40.0            # softmax temperature for confidence


def _build_templates() -> None:
    global _TEMPLATES, _ROOT, _QUAL, _PRIOR
    _TEMPLATES = np.zeros((12 * len(NAMES), 12))
    for qi, q in enumerate(NAMES):
        for r in range(12):
            for iv, w in QUALITIES[q][1]:
                _TEMPLATES[r * len(NAMES) + qi, (r + iv) % 12] = w
    _TEMPLATES /= np.linalg.norm(_TEMPLATES, axis=1, keepdims=True)
    _ROOT = np.repeat(np.arange(12), len(NAMES))
    _QUAL = np.tile(np.arange(len(NAMES)), 12)
    _PRIOR = np.array([QUALITIES[q][2] for q in NAMES])[_QUAL]


_build_templates()

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_FLAT_MAJOR = {5, 10, 3, 8, 1, 6}
_FLAT_MINOR = {2, 7, 0, 5, 10, 3}


def _flats(key: Key) -> bool:
    return key.tonic in (_FLAT_MAJOR if key.mode == "major" else _FLAT_MINOR)


def estimate_key(chroma: np.ndarray, bass: np.ndarray | None = None, first=None, last=None) -> Key:
    """Krumhansl-Schmuckler on summed beat chroma (the bass chroma counts extra, it names the tonic).
    `first`/`last` are the opening/closing chords as (root, minor?): a small nudge that settles
    relative-key ties (Am F C G is A minor, not C major)."""
    v = chroma.sum(axis=0) / max(chroma.sum(), 1e-9)
    if bass is not None:
        v = v + 0.5 * bass.sum(axis=0) / max(bass.sum(), 1e-9)
    res = []
    for mode, prof in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
        for t in range(12):
            r = float(np.corrcoef(v, np.roll(prof, t))[0, 1])
            for w, c in ((0.08, first), (0.05, last)):
                if c and c == (t, mode == "minor"):
                    r += w
            res.append((r, t, mode))
    res.sort(reverse=True)
    (s, t, mode), nxt = res[0], res[1]
    return Key(t, mode, f"{pc_name(t, t in (_FLAT_MAJOR if mode == 'major' else _FLAT_MINOR))} {mode}", s, s - nxt[0])


def _scale(key: Key) -> np.ndarray:
    steps = (0, 2, 4, 5, 7, 9, 11) if key.mode == "major" else (0, 2, 3, 5, 7, 8, 10)
    m = np.zeros(12)
    m[[(key.tonic + s) % 12 for s in steps]] = 1
    return m


def symbol(root: int, quality: str, bass: int | None = None, flats: bool = False) -> str:
    s = pc_name(root, flats) + QUALITIES[quality][0]
    return s + "/" + pc_name(bass, flats) if bass is not None and bass != root else s


def _beat_mean(L: np.ndarray, times: np.ndarray, edges: np.ndarray, trim=(0.03, 0.02)) -> np.ndarray:
    out = np.zeros((len(edges) - 1, L.shape[1]), np.float32)
    for b in range(len(edges) - 1):
        m = (times >= edges[b] + trim[0]) & (times < edges[b + 1] - trim[1])
        if not m.any():
            m = np.zeros(len(times), bool)
            m[min(np.searchsorted(times, (edges[b] + edges[b + 1]) / 2), len(times) - 1)] = True
        out[b] = L[m].mean(axis=0)
    return out


def _viterbi(E: np.ndarray, pen: np.ndarray) -> np.ndarray:
    T, S = E.shape
    score = E[0].copy()
    back = np.zeros((T, S), np.int32)
    for t in range(1, T):
        best = int(np.argmax(score))
        change = score[best] - pen[t]
        stay = score >= change
        back[t] = np.where(stay, np.arange(S), best)
        score = np.where(stay, score, change) + E[t]
    path = np.zeros(T, np.int32)
    path[-1] = int(np.argmax(score))
    for t in range(T - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


def hear_chords_from_chroma(chroma: np.ndarray, bass: np.ndarray, silent: np.ndarray, grid: Grid,
                            key: Key | None = None) -> tuple[list[ChordSpan], Key]:
    """Chord spans from per-beat chroma (B x 12), bass chroma (B x 12) and a silent-beat mask."""
    B = len(chroma)
    key = key or estimate_key(chroma[~silent] if (~silent).any() else chroma, bass)
    cn = chroma / np.maximum(np.linalg.norm(chroma, axis=1, keepdims=True), 1e-9)
    bn = bass / np.maximum(bass.sum(axis=1, keepdims=True), 1e-9)
    sc = cn @ _TEMPLATES.T
    sc = sc * _PRIOR + BASS_W * bn[:, _ROOT]
    sc = sc + 0.02 * ((_TEMPLATES > 0) @ _scale(key)) / (_TEMPLATES > 0).sum(axis=1)       # key breaks near ties
    sc = np.where(silent[:, None], 0.0, sc)
    full = np.concatenate([sc, np.where(silent, 1.0, N_SCORE)[:, None]], axis=1)             # last state: N
    pen = np.array([CHANGE * (0.45 if grid.bar_starts[i] else 0.8 if grid.position(i) == 2 else 1.0)
                    for i in range(B)])
    path = _viterbi(BETA * full, pen)
    flats = _flats(key)
    spans = []
    i = 0
    while i < B:
        j = i
        while j + 1 < B and path[j + 1] == path[i]:
            j += 1
        mean = full[i:j + 1].mean(axis=0)
        p = np.exp(CONF_T * (mean - mean.max()))
        p /= p.sum()
        s = int(path[i])
        if s == len(_ROOT):
            spans.append(ChordSpan(i, j + 1, "N", 0, "N", 0, float(p[s])))
        else:
            r, q = int(_ROOT[s]), NAMES[_QUAL[s]]
            bpc = int(np.argmax(bn[i:j + 1].mean(axis=0)))
            bass_pc = bpc if bn[i:j + 1].mean(axis=0)[bpc] > 0.4 else r
            sym = symbol(r, q, None, flats)
            order = np.argsort(-mean)
            ru = None
            for o in order:
                o = int(o)
                if o == s:
                    continue
                osym = "N" if o == len(_ROOT) else symbol(int(_ROOT[o]), NAMES[_QUAL[o]], None, flats)
                if osym != sym:
                    ru = (osym, float(p[o]))
                    break
            implied = ""
            if q == "5":
                implied = "m" if _scale(key)[(r + 3) % 12] > _scale(key)[(r + 4) % 12] else ""
            spans.append(ChordSpan(i, j + 1, sym, r, q, bass_pc, float(p[s]), ru, implied))
        i = j + 1
    sounding = [c for c in spans if c.quality != "N"]
    if sounding:
        mn = lambda c: c.quality in ("min", "m7", "dim")
        rest = (cn[~silent], bn[~silent]) if (~silent).any() else (cn, bn)
        key = estimate_key(*rest, (sounding[0].root_pc, mn(sounding[0])), (sounding[-1].root_pc, mn(sounding[-1])))
        for c in spans:
            if c.quality == "5":
                c.implied = "m" if _scale(key)[(c.root_pc + 3) % 12] > _scale(key)[(c.root_pc + 4) % 12] else ""
    return spans, key


def hear_chords(x: np.ndarray, sr: int, grid: Grid) -> Heard:
    """Everything at once: tuning, key, grid check, chord spans per beat, rhythm."""
    x = prepare(x, sr)
    cents = tuning_offset(x)
    hop = 512
    L, Lb = _salience2(x, cents, hop)
    t = np.arange(len(L)) * hop / SR
    edges = grid.edges()
    chroma = _beat_mean(_fold(L, LOW, HIGH), t, edges)
    bass = _beat_mean(_fold(Lb, LOW, BASS_TOP), t, edges)
    rms = np.array([np.sqrt(np.mean(x[max(int(a * SR), 0):max(int(b * SR), 1)] ** 2) + 1e-12)
                    for a, b in zip(edges[:-1], edges[1:])])
    silent = rms < max(0.05 * np.percentile(rms, 90), 1e-4)
    key = estimate_key(chroma[~silent] if (~silent).any() else chroma, bass[~silent] if (~silent).any() else bass)
    chords, key = hear_chords_from_chroma(chroma, bass, silent, grid, key)
    o = onsets(x)
    gc = grid_check(o.times, grid, o.strengths)
    rh = rhythm(o, grid, 4, gc.mean_offset if gc.on_grid else 0.0)
    return Heard(cents, key, gc, chords, rh, o)


# --- text -----------------------------------------------------------------------------------------


def format_chart(h: Heard, grid: Grid, name: str = "audio") -> str:
    """One bar per line with confidence, a runner-up where unsure; then tuning, key, grid check, rhythm."""
    bars = grid.bars()
    gc = h.grid_check
    lines = [f"{name}, {len(bars)} bars, tuning {h.tuning_cents:+.0f} c, key {h.key.name}, "
             + (f"on the grid ({gc.mean_offset * 1000:+.0f} ms)" if gc.on_grid else
                f"OFF the grid (mean {gc.mean_offset * 1000:+.0f} ms, drift {gc.drift * 1000:+.0f} ms, spread {gc.spread * 1000:.0f} ms)")]
    for n, (a, b) in enumerate(bars, 1):
        cells = []
        for c in h.chords:
            if c.end_beat <= a or c.start_beat >= b:
                continue
            unsure = c.runner_up is not None and (c.confidence < 0.5 or c.runner_up[1] > 0.5 * c.confidence)
            cell = f"{c.symbol} {c.confidence:.2f}" + (f" | {c.runner_up[0]} {c.runner_up[1]:.2f}  <- unsure" if unsure else "")
            if c.quality == "5" and c.implied:
                cell += " (power chord, minor by key)"
            cells.append(cell)
        lines.append(f"{n:>3}  " + "  ".join(cells))
    if h.rhythm.bars:
        spb = h.rhythm.slots_per_beat
        row = h.rhythm.bars[0]
        cells = ["".join("x" if v >= 0.5 else "o" if v >= 0.2 else "." for v in row[i:i + spb]) for i in range(0, len(row), spb)]
        lines.append("rhythm: | " + " ".join(cells) + " |  (bar 1, onset strength per 16th: x strong, o weak)")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    import soundfile as sf
    ap = argparse.ArgumentParser(prog="python -m badmidi.audio.hear", description="Debug: print the chords heard in a WAV.")
    ap.add_argument("file")
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--meter", default="4/4")
    ap.add_argument("--offset", type=float, default=0.0, help="seconds from the file start to beat 1")
    a = ap.parse_args(argv)
    x, sr = sf.read(a.file, dtype="float32", always_2d=True)
    x = prepare(x, sr)
    per_bar = int(a.meter.split("/")[0])
    beat = 60.0 / a.bpm * 4 / int(a.meter.split("/")[1])
    n = int((len(x) / SR - a.offset) / beat)
    n = n // per_bar * per_bar or n                  # whole bars; the reverb tail is not a bar
    grid = Grid([a.offset + i * beat for i in range(n)], [i % per_bar == 0 for i in range(n)], a.offset + n * beat)
    print(format_chart(hear_chords(x, SR, grid), grid, a.file))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
