"""Hearing: tuning, onsets, rhythm, key, chords or notes from mono audio on a known beat grid.

Pure numpy/scipy on in-memory signals at 22050 Hz (`prepare` converts). The caller supplies the
beat grid in seconds (so any tempo map works); everything is reported per beat or per bar of it.
A take is heard as chords (`hear_chords`, a strummed guitar, keys) or as notes (`hear_notes`, a sung or single-note line);
`hear` picks by voicing. Debug CLI: python -m badmidi.audio.hear take.wav --bpm 100 --meter 4/4 [--as auto|chords|notes]
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from fractions import Fraction
from math import gcd

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.ndimage import maximum_filter1d, median_filter, uniform_filter1d
from scipy.signal import resample_poly

from ..core import dur_suffix, pc_name
from ..heard import is_unsure

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
    """Onset strength (0..1) per slot, one list per bar. `beat_slots`: the slots of each beat of the grid when they differ
    (beats of different lengths: 4/4 into 6/8); `slots_per_beat` is then the first beat's."""
    slots_per_beat: int
    bars: list[list[float]]
    beat_slots: list[int] | None = None


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
    runner_up: tuple[str, float] | None = None     # the best chord of another root or family, and its confidence
    implied: str = ""            # for a power chord: 'm' or '' (major) as read from the key
    src: str = ""                # 'melody': a guess from a melody's notes, not heard

    def unsure(self) -> bool:
        return is_unsure(self.confidence, self.runner_up[1] if self.runner_up else 0.0, self.runner_up is not None)


@dataclass
class HeardNote:
    """A note of a monophonic line, quantized. Beats count from the first beat of the grid (a Fraction: a 16th is 1/4 of a
    beat in a quarter-note beat); `raw_onset_s` is where it was heard, before quantizing."""
    start_beat: Fraction
    end_beat: Fraction
    pitch: int                   # MIDI, tuning-shifted
    velocity: int                # 1..127, from the RMS
    confidence: float            # 0..1
    raw_onset_s: float


@dataclass
class Decision:
    """Why a take was heard as chords or as notes."""
    mode: str                    # 'chords' | 'notes'
    why: str
    voiced: float = 0.0          # share of sounding frames with an f0
    clear: float = 0.0           # share of sounding frames with a clear (periodic, steady) f0


@dataclass
class Heard:
    tuning_cents: float
    key: Key
    grid_check: GridCheck
    chords: list[ChordSpan]
    rhythm: Rhythm
    onsets: Onsets = field(default_factory=lambda: Onsets([], []))
    notes: list[HeardNote] = field(default_factory=list)
    mode: str = "chords"
    decision: Decision | None = None


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
    """Cents the recording sits above 12-TET A440 (-50..50), from the strong spectral peaks between 100 and 800 Hz: the low
    partials. A string is stiff, so its upper partials are sharp of the harmonic series (by 10 cents or more around the tenth),
    and the peaks above that would pull the estimate up."""
    n, nfft = 4096, 16384
    S = _stft(x, n, 2048, nfft)
    df = SR / nfft
    k0, k1 = int(100 / df), int(800 / df)
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


HARMONICS = ((19, 1.2), (28, .5), (34, .3), (38, 0.0))   # (semitones above the note, share subtracted): 3rd, 5th, 7th, 9th


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


ONSET_DELAY = -0.008   # seconds to subtract from the flux onset time: it leads the first stroke by 8 ms on tests/synth.py (measured)


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


def _beat_slots(grid: Grid, spb: "int | list[int]") -> list[int]:
    """Slots in each beat of the grid: `spb` itself when it is a list (one per beat), else that many in every beat."""
    return [int(x) for x in spb] if not isinstance(spb, int) else [spb] * len(grid.beats)


def _slot_times(grid: Grid, spb: "int | list[int]") -> np.ndarray:
    e = grid.edges()
    n = _beat_slots(grid, spb)
    return np.concatenate([e[i] + (e[i + 1] - e[i]) * np.arange(k) / k for i, k in enumerate(n)]) if n else np.zeros(0)


def rhythm(x_or_onsets, grid: Grid, slots_per_beat: "int | list[int]" = 4, shift: float = 0.0) -> Rhythm:
    """Onset strength per slot (default 16ths) for each bar of the grid. `slots_per_beat` is one number or one per beat.
    `shift` is subtracted from onset times."""
    o = x_or_onsets if isinstance(x_or_onsets, Onsets) else onsets(x_or_onsets)
    slots = _slot_times(grid, slots_per_beat)
    acc = np.zeros(len(slots))
    t = np.asarray(o.times) - shift
    if len(t):
        j = np.clip(np.searchsorted(slots, t) - 1, 0, len(slots) - 1)
        j = np.where(np.abs(slots[np.minimum(j + 1, len(slots) - 1)] - t) < np.abs(slots[j] - t), j + 1, j)
        ok = (t >= slots[0] - 0.05) & (t < grid.edges()[-1] + 0.05)
        np.maximum.at(acc, j[ok], np.asarray(o.strengths)[ok])
    n = _beat_slots(grid, slots_per_beat)
    cum = [0] + list(np.cumsum(n))
    return Rhythm(n[0] if n else 4, [acc[cum[a]:cum[b]].round(3).tolist() for a, b in grid.bars()], None if len(set(n)) <= 1 else n)


def _drift(t: np.ndarray, off: np.ndarray, slot: float) -> float:
    """Seconds the onsets' offset from the grid changes across the take. The offsets are phases of the slot (they wrap when the
    playing runs away from the grid), so take the circular mean of each stretch of 8 slots, dropping its stray onsets (the later
    strings of a slow strum land a long way from the slot), unwrap those and fit a line."""
    win = np.floor((t - t[0]) / (8 * slot)).astype(int)
    tw, aw = [], []
    for w in np.unique(win):
        m = win == w
        if m.sum() < 2:
            continue
        ang, tt = off[m] / slot * 2 * np.pi, t[m]
        for _ in range(2):
            keep = np.abs(np.angle(np.exp(1j * (ang - np.angle(np.exp(1j * ang).mean()))))) < np.pi / 2
            if keep.any():
                ang, tt = ang[keep], tt[keep]
        tw.append(tt.mean())
        aw.append(np.angle(np.exp(1j * ang).mean()))
    if len(tw) < 2:
        return 0.0
    un = np.unwrap(aw) / (2 * np.pi) * slot
    return float(np.polyfit(tw, un, 1)[0] * (t[-1] - t[0]))


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
    mean = float(np.median(off))
    spread = float(1.4826 * np.median(np.abs(off - mean)))
    drift = _drift(t, off, slot)
    return GridCheck(mean, drift, spread, bool(abs(mean) <= max_offset and spread <= max_spread and abs(drift) <= max_offset), len(t))


# --- chords ---------------------------------------------------------------------------------------

# quality -> (suffix, [(interval, weight)], prior)
QUALITIES: dict[str, tuple[str, list[tuple[int, float]], float]] = {
    "maj": ("", [(0, 1), (4, .9), (7, .7)], 1.0),
    "min": ("m", [(0, 1), (3, .9), (7, .7)], 1.0),
    "7": ("7", [(0, 1), (4, .9), (7, .65), (10, .4)], 0.98),
    "maj7": ("maj7", [(0, 1), (4, .9), (7, .65), (11, .4)], 0.98),
    "m7": ("m7", [(0, 1), (3, .9), (7, .65), (10, .4)], 0.98),
    "sus2": ("sus2", [(0, 1), (2, .9), (7, .7)], 0.97),
    "sus4": ("sus4", [(0, 1), (5, .9), (7, .7)], 0.97),
    "dim": ("dim", [(0, 1), (3, .9), (6, .7)], 0.96),
    "5": ("5", [(0, 1), (7, .8)], 0.99),
}
NAMES = list(QUALITIES)
# chords that differ only inside a family (Am / Am7, G / G7 / Gmaj7) are one answer for confidence; a different root or family is a rival
FAMILIES = {"maj": "M", "7": "M", "maj7": "M", "min": "m", "m7": "m", "sus2": "sus2", "sus4": "sus4", "dim": "dim", "5": "5"}
FAMILY_NAMES = sorted(set(FAMILIES.values()))
N_SCORE = 0.5            # how well "no chord" matches a sounding beat
BASS_W = 0.15            # bonus for a chord whose root is what the bass plays
BETA = 12.0              # emission scale for Viterbi
CHANGE = 1.6             # change penalty (emission units) on a weak beat
CONF_T = 40.0            # softmax temperature for confidence
FLOOR_PCT = 25           # a beat's noise floor: this percentile of its 12 chroma values
COMPRESS = 2.5           # chroma above the floor is compressed log1p(x / COMPRESS): a lone third counts, not its share of the root


def _build_templates() -> None:
    global _TEMPLATES, _ROOT, _QUAL, _PRIOR, _FAM_COLS
    _TEMPLATES = np.zeros((12 * len(NAMES), 12))
    for qi, q in enumerate(NAMES):
        for r in range(12):
            for iv, w in QUALITIES[q][1]:
                _TEMPLATES[r * len(NAMES) + qi, (r + iv) % 12] = w
    _TEMPLATES /= np.linalg.norm(_TEMPLATES, axis=1, keepdims=True)
    _ROOT = np.repeat(np.arange(12), len(NAMES))
    _QUAL = np.tile(np.arange(len(NAMES)), 12)
    _PRIOR = np.array([QUALITIES[q][2] for q in NAMES])[_QUAL]
    _FAM_COLS = {f: [i for i, q in enumerate(NAMES) if FAMILIES[q] == f] for f in FAMILY_NAMES}


_build_templates()

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_FLAT_MAJOR = {5, 10, 3, 8, 1, 6}
_FLAT_MINOR = {2, 7, 0, 5, 10, 3}


def _flats(key: Key) -> bool:
    return key.tonic in (_FLAT_MAJOR if key.mode == "major" else _FLAT_MINOR)


def _key_corr(chroma: np.ndarray, bass: np.ndarray | None = None) -> dict[tuple[int, str], float]:
    """Krumhansl-Schmuckler correlation of the summed beat chroma (the bass chroma counts extra, it names the tonic) with each key."""
    v = chroma.sum(axis=0) / max(chroma.sum(), 1e-9)
    if bass is not None:
        v = v + 0.5 * bass.sum(axis=0) / max(bass.sum(), 1e-9)
    return {(t, mode): float(np.corrcoef(v, np.roll(prof, t))[0, 1])
            for mode, prof in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)) for t in range(12)}


def _make_key(res: list[tuple[float, int, str]]) -> Key:
    res = sorted(res, reverse=True)
    (s, t, mode), nxt = res[0], res[1]
    return Key(t, mode, f"{pc_name(t, t in (_FLAT_MAJOR if mode == 'major' else _FLAT_MINOR))} {mode}", s, s - nxt[0])


def estimate_key(chroma: np.ndarray, bass: np.ndarray | None = None, first=None, last=None) -> Key:
    """Krumhansl-Schmuckler on summed beat chroma. `first`/`last` are the opening/closing chords as (root, minor?): a small
    nudge toward them as the tonic (used for a melody's first and last notes; chords use `key_from_chords`)."""
    res = []
    for (t, mode), r in _key_corr(chroma, bass).items():
        for w, c in ((0.08, first), (0.05, last)):
            if c and c[0] == t and (c[1] is None or c[1] == (mode == "minor")):     # minor? None: either mode
                r += w
        res.append((r, t, mode))
    return _make_key(res)


# degree (semitones above the tonic) -> the triads a key has there; a major V and a diminished vii are the minor key's harmonic scale
_DIATONIC = {"major": {0: ("maj",), 2: ("min",), 4: ("min",), 5: ("maj",), 7: ("maj",), 9: ("min",), 11: ("dim",)},
             "minor": {0: ("min",), 2: ("dim",), 3: ("maj",), 5: ("min",), 7: ("min", "maj"), 8: ("maj",), 10: ("maj",), 11: ("dim",)}}
_TRIAD = {"maj": "maj", "7": "maj", "maj7": "maj", "min": "min", "m7": "min", "dim": "dim"}
_ROOT_ONLY = ("5", "sus2", "sus4")           # chords with no third: only their root says anything
KEY_W = dict(fit=1.0, tonic=0.5, start=0.5, end=0.25, cadence=0.2, chroma=0.6)


def key_from_chords(spans: list[ChordSpan], chroma: np.ndarray, bass: np.ndarray | None = None) -> Key:
    """The key that the chord sequence says, with the chroma profile as one vote among several. A chord counts for a key by how
    well it is one of the key's triads (a dominant 7th and a major V of a minor key included), by time on the key's tonic chord,
    by opening on it, by closing on it, and by a V-I or V7-I cadence into the end. That is what separates relative keys
    (Am F C G is A minor, C G Am F is C major), which the chroma alone cannot."""
    sounding = [c for c in spans if c.quality != "N"]
    corr = _key_corr(chroma, bass)
    if not sounding:
        return _make_key([(r, t, m) for (t, m), r in corr.items()])
    dur = np.array([c.end_beat - c.start_beat for c in sounding], float)
    dur /= dur.sum()
    res = []
    for (t, mode), r in corr.items():
        tri = _DIATONIC[mode]

        def is_tonic(c: ChordSpan) -> bool:
            return (c.root_pc - t) % 12 == 0 and (c.quality in _ROOT_ONLY or _TRIAD[c.quality] in tri[0])

        fit = 0.0
        for c, d in zip(sounding, dur):
            deg = (c.root_pc - t) % 12
            if deg not in tri:
                m = 0.0
            elif c.quality in _ROOT_ONLY or _TRIAD[c.quality] in tri[deg]:
                m = 0.75 if c.quality == "7" and deg != 7 else 1.0        # a 7th chord off the dominant: blues or mixolydian
            else:
                m = 0.3
            fit += d * m
        tonic = sum(d for c, d in zip(sounding, dur) if is_tonic(c))
        cad = len(sounding) > 1 and is_tonic(sounding[-1]) and (sounding[-2].root_pc - t) % 12 == 7
        score = (KEY_W["fit"] * fit + KEY_W["tonic"] * tonic + KEY_W["start"] * is_tonic(sounding[0]) + KEY_W["end"] * is_tonic(sounding[-1])
                 + KEY_W["cadence"] * cad + KEY_W["chroma"] * r)
        res.append((score, t, mode))
    return _make_key(res)


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


def _presence(chroma: np.ndarray) -> np.ndarray:
    """Per-beat chroma as evidence that a pitch class sounds: the excess over the beat's noise floor, log-compressed. A chord's
    third is often one string against a root on three (an open C, an F barre), so as a share of the root it is small, but it is
    clearly above the floor; matching templates on this keeps a power chord for beats whose third is really absent."""
    fl = np.percentile(chroma, FLOOR_PCT, axis=1, keepdims=True)
    return np.log1p(np.maximum(chroma - fl, 0) / COMPRESS)


CHANGE_Q = 2.5           # change penalty for a new quality on the same root (A -> Am, Am -> A5): a third that decays is not a new chord


def _two_stage(full: np.ndarray, pen: np.ndarray) -> np.ndarray:
    """The chord path in two steps. Roots first (each root scores as its best quality, so a third that rings out on beat 2 cannot
    split an Am into A5 and Am), then inside each root's span the quality, with a dearer change."""
    nq, B = len(NAMES), len(full)
    roots = np.concatenate([full[:, :-1].reshape(B, 12, nq).max(axis=2), full[:, -1:]], axis=1)
    rpath = _viterbi(BETA * roots, pen)
    path = np.zeros(B, np.int32)
    i = 0
    while i < B:
        j = i
        while j + 1 < B and rpath[j + 1] == rpath[i]:
            j += 1
        if rpath[i] == 12:
            path[i:j + 1] = len(_ROOT)
        else:
            sub = _viterbi(BETA * full[i:j + 1, rpath[i] * nq:(rpath[i] + 1) * nq], np.full(j + 1 - i, CHANGE_Q))
            path[i:j + 1] = rpath[i] * nq + sub
        i = j + 1
    return path


def _scores(cn: np.ndarray, bn: np.ndarray, key: Key) -> np.ndarray:
    """Score of every chord template for rows of normalised presence `cn` and normalised bass chroma `bn` (rows x 12*qualities)."""
    sc = cn @ _TEMPLATES.T
    sc = sc * _PRIOR + BASS_W * bn[:, _ROOT]
    return sc + 0.02 * ((_TEMPLATES > 0) @ _scale(key)) / (_TEMPLATES > 0).sum(axis=1)       # key breaks near ties


def hear_chords_from_chroma(chroma: np.ndarray, bass: np.ndarray, silent: np.ndarray, grid: Grid,
                            key: Key | None = None) -> tuple[list[ChordSpan], Key]:
    """Chord spans from per-beat chroma (B x 12), bass chroma (B x 12) and a silent-beat mask."""
    B = len(chroma)
    key = key or estimate_key(chroma[~silent] if (~silent).any() else chroma, bass)
    pr = _presence(chroma)
    unit = lambda m: m / np.maximum(np.linalg.norm(m, axis=1, keepdims=True), 1e-9)
    cn = unit(pr)
    bn = bass / np.maximum(bass.sum(axis=1, keepdims=True), 1e-9)
    sc = np.where(silent[:, None], 0.0, _scores(cn, bn, key))
    full = np.concatenate([sc, np.where(silent, 1.0, N_SCORE)[:, None]], axis=1)             # last state: N
    pen = np.array([CHANGE * (0.45 if grid.bar_starts[i] else 0.8 if grid.position(i) == 2 else 1.0)
                    for i in range(B)])
    path = _two_stage(full, pen)
    flats = _flats(key)
    spans = []
    i = 0
    while i < B:
        j = i
        while j + 1 < B and path[j + 1] == path[i]:
            j += 1
        mean = full[i:j + 1].mean(axis=0)
        grp = np.append(np.stack([mean[:-1].reshape(12, -1)[:, _FAM_COLS[f]].max(axis=1) for f in FAMILY_NAMES], axis=1).ravel(), mean[-1])
        p = np.exp(CONF_T * (grp - grp.max()))
        p /= p.sum()
        s = int(path[i])
        gs = len(grp) - 1 if s == len(_ROOT) else int(_ROOT[s]) * len(FAMILY_NAMES) + FAMILY_NAMES.index(FAMILIES[NAMES[_QUAL[s]]])
        if s == len(_ROOT):
            spans.append(ChordSpan(i, j + 1, "N", 0, "N", 0, float(p[gs])))
        else:
            r, q = int(_ROOT[s]), NAMES[_QUAL[s]]
            bpc = int(np.argmax(bn[i:j + 1].mean(axis=0)))
            bass_pc = bpc if bn[i:j + 1].mean(axis=0)[bpc] > 0.4 else r
            sym = symbol(r, q, None, flats)
            ru = None
            for o in np.argsort(-grp):                              # the best answer of another root or family
                o = int(o)
                if o == gs:
                    continue
                if o == len(grp) - 1:
                    ru = ("N", float(p[o]))
                else:
                    rr, ff = divmod(o, len(FAMILY_NAMES))
                    cols = _FAM_COLS[FAMILY_NAMES[ff]]
                    qq = cols[int(np.argmax(mean[:-1].reshape(12, -1)[rr, cols]))]
                    ru = (symbol(rr, NAMES[qq], None, flats), float(p[o]))
                break
            implied = ""
            if q == "5":
                implied = "m" if _scale(key)[(r + 3) % 12] > _scale(key)[(r + 4) % 12] else ""
            spans.append(ChordSpan(i, j + 1, sym, r, q, bass_pc, float(p[gs]), ru, implied))
        i = j + 1
    sounding = [c for c in spans if c.quality != "N"]
    if sounding:
        live = ~silent if (~silent).any() else np.ones(B, bool)
        key = key_from_chords(spans, pr[live], bn[live])
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
    rms = np.array([np.sqrt(np.mean(np.r_[x[max(int(a * SR), 0):max(int(b * SR), 1)], 0.0] ** 2) + 1e-12)
                    for a, b in zip(edges[:-1], edges[1:])])
    silent = rms < max(0.05 * np.percentile(rms, 90), 1e-4)
    key = estimate_key(chroma[~silent] if (~silent).any() else chroma, bass[~silent] if (~silent).any() else bass)
    chords, key = hear_chords_from_chroma(chroma, bass, silent, grid, key)
    o = onsets(x)
    gc = grid_check(o.times, grid, o.strengths)
    rh = rhythm(o, grid, 4, gc.mean_offset if gc.on_grid else 0.0)
    return Heard(cents, key, gc, chords, rh, o)


# --- monophonic: f0 and notes ---------------------------------------------------------------------

F0_HOP = 220                  # 10 ms
F0_WIN = 1024                 # integration window of the difference function (46 ms)
F0_MIN, F0_MAX = 65.0, 2000.0
TAU_MIN, TAU_MAX = int(SR / F0_MAX), int(SR / F0_MIN) + 1
BIN = 0.2                     # f0 bins of a fifth of a semitone
M_LO = 69 + 12 * np.log2(F0_MIN / 440)
N_BINS = int((69 + 12 * np.log2(F0_MAX / 440) - M_LO) / BIN) + 1
CAND_TOP = 0.5                # a lag whose normalised difference is above this is no candidate
JUMP = 6                      # most f0 bins the pitch may move in one frame (120 cents)
GATE = 0.03                   # frames quieter than this share of the loud ones (rms) are silence
SPLIT_CENTS = 0.7             # a note ends when the pitch moves this many semitones ...
SPLIT_FRAMES = 6              # ... and stays there this many frames (60 ms)
MIN_NOTE = 0.05               # seconds
HARMONIC_RATIOS = sorted({q / p for q in range(2, 7) for p in range(1, q)})   # f of a partial over the f of its fundamental: q/p, q <= 6


@dataclass
class F0Track:
    """One f0 estimate per 10 ms frame. `midi` is the pitch (A440 = 69, not yet tuning-shifted), NaN where unvoiced; `prob`
    the voicing probability, `aper` the aperiodicity at the chosen lag (0 = perfectly periodic)."""
    times: np.ndarray
    midi: np.ndarray
    prob: np.ndarray
    aper: np.ndarray
    rms: np.ndarray

    @property
    def sounding(self) -> np.ndarray:
        loud = self.rms[self.rms > 0]
        return self.rms > max(GATE * (np.percentile(loud, 95) if len(loud) else 0), 1e-4)

    @property
    def voiced(self) -> np.ndarray:
        return np.isfinite(self.midi)


def _cmnd(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """YIN's cumulative-mean-normalised difference (frames x lags) and the rms of every frame, hop F0_HOP."""
    n = len(x) // F0_HOP + 1
    L = F0_WIN + TAU_MAX + 1
    pad = np.pad(x.astype(np.float64), (F0_WIN // 2, TAU_MAX + F0_WIN + 1))
    frames = sliding_window_view(pad, L)[::F0_HOP][:n]
    c = np.empty((n, TAU_MAX + 1), np.float32)
    rms = np.empty(n)
    tau = np.arange(TAU_MAX + 1)
    for i in range(0, n, 512):
        F = frames[i:i + 512]
        a = F[:, :F0_WIN]
        ea = (a * a).sum(axis=1)
        cs = np.pad(np.cumsum(F * F, axis=1), ((0, 0), (1, 0)))
        eb = cs[:, F0_WIN:F0_WIN + TAU_MAX + 1] - cs[:, :TAU_MAX + 1]
        r = np.fft.irfft(np.conj(np.fft.rfft(a, 2048)) * np.fft.rfft(F, 2048), 2048)[:, :TAU_MAX + 1]
        d = np.maximum(ea[:, None] + eb - 2 * r, 0)
        d[:, 0] = 0
        out = d * tau / (np.cumsum(d, axis=1) + 1e-7 * F0_WIN)
        out[:, 0] = 1
        c[i:i + 512] = out
        rms[i:i + 512] = np.sqrt(ea / F0_WIN)
    return c, rms


def _candidates(c: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(frame, midi, normalised difference, mass) of every dip of the difference function. A dip's mass is the share of
    thresholds (uniform up to CAND_TOP) for which it is the first dip below: the earlier and deeper, the likelier. That
    is pYIN's observation model with a flat threshold prior."""
    mid = c[:, TAU_MIN:TAU_MAX]
    dip = (mid < c[:, TAU_MIN - 1:TAU_MAX - 1]) & (mid <= c[:, TAU_MIN + 1:TAU_MAX + 1]) & (mid < CAND_TOP)
    fi, ti = np.nonzero(dip)
    ti = ti + TAU_MIN
    a, b, d = c[fi, ti - 1], c[fi, ti], c[fi, ti + 1]
    delta = np.clip(0.5 * (a - d) / np.maximum(a - 2 * b + d, 1e-9), -0.5, 0.5)
    midi = 69 + 12 * np.log2(SR / ((ti + delta) * 440))
    mass = np.zeros(len(fi))
    bounds = np.r_[0, np.nonzero(np.diff(fi))[0] + 1, len(fi)]
    for s, e in zip(bounds[:-1], bounds[1:]):
        v = b[s:e].copy()
        if e - s > 1:                                              # a dip at a harmonic (a third, an octave up) of a far
            gap = midi[s:e][None, :] - midi[s:e][:, None]            # deeper dip is that note's partial, not a pitch
            mult = np.zeros((e - s, e - s), bool)
            for r in HARMONIC_RATIOS:
                mult |= np.abs(gap + 12 * np.log2(r)) < 0.35           # row i, column j: i is j's q-th partial over p (j lower)
            d = v[:, None] - v[None, :]
            far = ((d > 0.04) & (v[None, :] < 0.08 * v[:, None]) & (v[None, :] < 0.03)) | ((d > 0.15) & (v[None, :] < 0.2 * v[:, None]))
            v = np.where((mult & far).any(axis=1), CAND_TOP, v)
        prev = np.r_[CAND_TOP, np.minimum.accumulate(v)[:-1]]
        mass[s:e] = np.where(v >= CAND_TOP, 0, np.clip((np.minimum(prev, CAND_TOP) - v) / CAND_TOP, 0, 1))
    return fi, midi, b.astype(float), mass


def f0_track(x: np.ndarray) -> F0Track:
    """pYIN-style f0: YIN candidates with probabilities, then a Viterbi path over pitch bins plus an unvoiced state."""
    c, rms = _cmnd(x)
    n = len(c)
    fi, midi, cval, mass = _candidates(c)
    track = F0Track(np.arange(n) * F0_HOP / SR, np.full(n, np.nan), np.zeros(n), np.ones(n), rms)
    silent = ~track.sounding
    if n < 3 or silent.all():
        return track
    tot = np.minimum(np.bincount(fi, mass, minlength=n), 1.0)
    bins = np.clip(np.rint((midi - M_LO) / BIN).astype(int), 0, N_BINS - 1)
    obs = np.full((n, N_BINS), 1e-4)
    np.add.at(obs, (fi, bins), mass)
    unv = np.maximum(1 - tot, 0.05)
    obs[silent], unv[silent] = 1e-9, 1.0
    lv, lu = np.log(obs), np.log(unv)
    k = np.arange(-JUMP, JUMP + 1)
    lk = np.log(np.exp(-np.abs(k) / 1.5) / np.exp(-np.abs(k) / 1.5).sum() * 0.98)
    l_vu, l_uv, l_uu = np.log(0.05), np.log(0.05), np.log(0.95)
    v, u = lv[0] + l_uv, lu[0]
    back_v = np.zeros((n, N_BINS), np.int8)               # offset to the previous bin; 127: came from the unvoiced state
    back_u = np.zeros(n, np.int32)                        # -1: stayed unvoiced, else the voiced bin it came from
    for t in range(1, n):
        win = sliding_window_view(np.pad(v, (JUMP, JUMP), constant_values=-np.inf), 2 * JUMP + 1) + lk[None]
        j = win.argmax(axis=1)
        stay = win[np.arange(N_BINS), j]
        via_u = u + l_uv
        from_u = via_u > stay
        back_v[t] = np.where(from_u, 127, j - JUMP)
        vn = np.where(from_u, via_u, stay) + lv[t]
        bv = int(v.argmax())
        to_u = v[bv] + l_vu
        back_u[t] = bv if to_u > u + l_uu else -1
        u, v = max(u + l_uu, to_u) + lu[t], vn
    state = N_BINS if u >= v.max() else int(v.argmax())
    path = np.zeros(n, np.int32)
    for t in range(n - 1, -1, -1):
        path[t] = state
        if t == 0:
            break
        if state == N_BINS:
            state = N_BINS if back_u[t] < 0 else int(back_u[t])
        else:
            o = int(back_v[t, state])
            state = N_BINS if o == 127 else state + o
    starts = np.searchsorted(fi, np.arange(n + 1))
    for t in np.nonzero(path < N_BINS)[0]:
        s, e = starts[t], starts[t + 1]
        near = np.nonzero(np.abs(bins[s:e] - path[t]) <= 2)[0]
        if not len(near):
            continue
        j = s + near[np.argmax(mass[s:e][near])]
        track.midi[t], track.prob[t], track.aper[t] = midi[j], tot[t], cval[j]
    return track


def _smooth(m: np.ndarray, size: int = 5) -> np.ndarray:
    """Fill gaps of up to 3 unvoiced frames between close pitches, then median-filter each voiced run."""
    m = m.copy()
    v = np.isfinite(m)
    idx = np.nonzero(v)[0]
    for a, b in zip(idx[:-1], idx[1:]):
        if 1 < b - a <= 4 and abs(m[a] - m[b]) < 1.0:
            m[a + 1:b] = np.linspace(m[a], m[b], b - a + 1)[1:-1]
    v = np.isfinite(m)
    edges = np.flatnonzero(np.diff(np.r_[0, v.astype(int), 0]))
    for a, b in zip(edges[::2], edges[1::2]):
        if b - a >= size:
            m[a:b] = median_filter(m[a:b], size, mode="nearest")
    return m


def decide(track: F0Track) -> Decision:
    """Notes or chords? A line is one clear f0 in most of the sounding audio: voiced, periodic (low aperiodicity) and
    steady (no jumping between octaves or partials). Chords and noise are not."""
    snd = track.sounding
    if snd.sum() < 30:
        return Decision("chords", "too little sound to tell")
    m = _smooth(track.midi)
    voiced = np.isfinite(m) & snd
    steady = np.zeros(len(m), bool)
    med = median_filter(np.nan_to_num(m, nan=0.0), 9, mode="nearest")
    steady[voiced] = np.abs(m[voiced] - med[voiced]) < 1.0
    clear = voiced & steady & (track.aper < 0.25)
    v, c = float(voiced.sum() / snd.sum()), float(clear.sum() / snd.sum())
    if c >= 0.6:
        return Decision("notes", f"one clear pitch in {c * 100:.0f}% of the sound", v, c)
    return Decision("chords", f"no single clear pitch, {c * 100:.0f}% of the sound", v, c)


def _tuning_from_pitch(m: np.ndarray, w: np.ndarray) -> float:
    """Cents the line sits above 12-TET (-50..50): the weighted mode of the pitch's distance to the semitone grid."""
    ok = np.isfinite(m)
    if ok.sum() < 5:
        return 0.0
    cents = ((m[ok] + 0.5) % 1 - 0.5) * 100
    hist = np.bincount(((cents + 50) % 100).astype(int) % 100, weights=w[ok], minlength=100)
    sm = np.convolve(np.r_[hist[-24:], hist, hist[:24]], np.exp(-0.5 * (np.arange(-24, 25) / 8.0) ** 2), "valid")   # wide: vibrato
    c0 = np.argmax(sm) - 50 + 0.5
    near = np.abs((cents - c0 + 50) % 100 - 50) < 30
    return float(c0 + np.average((cents[near] - c0 + 50) % 100 - 50, weights=w[ok][near])) if near.any() else float(c0)


def _segments(m: np.ndarray) -> list[tuple[int, int]]:
    """[first, end) frames of each note of a smoothed pitch track: a run of voiced frames, cut where the pitch moves by
    SPLIT_CENTS and stays (a glide is not a note), the cut in the middle of the glide."""
    v = np.isfinite(m)
    out = []
    edges = np.flatnonzero(np.diff(np.r_[0, v.astype(int), 0]))
    for a, b in zip(edges[::2], edges[1::2]):
        cur, pend, start = [], [], a
        for i in range(a, b):
            ref = np.median(m[cur[-30:]]) if cur else m[i]
            if cur and abs(m[i] - ref) > SPLIT_CENTS:
                pend.append(i)
                while len(pend) > 1 and m[pend].max() - m[pend].min() > 1.0:
                    pend.pop(0)                                  # still gliding: the settled part is the tail
                if len(pend) >= SPLIT_FRAMES and abs(np.median(m[pend]) - ref) > SPLIT_CENTS:
                    cut = (cur[-1] + 1 + pend[0]) // 2 if pend[0] > cur[-1] + 1 else pend[0]
                    out.append((start, cut))
                    start, cur, pend = cut, list(range(pend[0], i + 1)), []
            else:
                cur += pend + [i]
                pend = []
        if b > start:
            out.append((start, b))
    return out


def _split_on_onsets(segs, db, on_idx, rms_rise: float = 5.0):
    """Cut a note where an onset shows up inside it with a clear rise in level (the same pitch struck again)."""
    out = []
    for a, b in segs:
        cuts = [a]
        for i in on_idx:
            if cuts[-1] + 8 <= i <= b - 8 and db[i + 1:i + 5].max() - db[max(i - 8, 0):i].min() >= rms_rise:
                cuts.append(int(i))
        out += list(zip(cuts, cuts[1:] + [b]))
    return out


def hear_notes(x: np.ndarray, sr: int, grid: Grid, snap: "int | list[int]" = 4, track: F0Track | None = None) -> Heard:
    """A sung or single-note line: tuning, key, grid check, notes (quantized to `snap` slots per beat, 4 = 16ths in a
    quarter-note beat; a list: one per beat), rhythm. The notes' `raw_onset_s` are the unquantized onsets."""
    x = prepare(x, sr)
    tr = track or f0_track(x)
    hop = F0_HOP / SR
    m = _smooth(tr.midi)
    m[~tr.sounding] = np.nan
    db = 20 * np.log10(tr.rms + 1e-9)
    m[db < maximum_filter1d(db, 25) - 14] = np.nan                 # a release or attack far below its neighbours: its pitch is not to be trusted
    cents = _tuning_from_pitch(m, tr.rms)
    mt = m - cents / 100
    ons = onsets(x)
    strong = [t for t, s in zip(ons.times, ons.strengths) if s >= 0.3]
    on_idx = [int(round(t / hop)) for t in strong if 0 <= t / hop < len(m) - 5]
    segs = [(a, b) for a, b in _split_on_onsets(_segments(mt), db, on_idx) if (b - a) * hop >= MIN_NOTE]

    raw = []                                                       # (start s, end s, pitch, level dB, confidence)
    for a, b in segs:
        f = mt[a:b]
        f = f[np.isfinite(f)]
        if not len(f):
            continue
        core = f[2:-2] if len(f) > 8 else f
        med = float(np.median(core))
        pitch = int(round(med))
        vp = float(np.mean(tr.prob[a:b]))
        conf = vp * (1 - min(1.0, 1.5 * abs(med - pitch))) * min(1.0, (b - a) * hop / 0.08)
        t0 = a * hop
        prev = raw[-1][0] + MIN_NOTE if raw else -1.0
        near = [t for t in strong if -0.15 <= t - t0 <= 0.05 and t > prev]      # the flux onset knows the attack better than the f0
        if near:
            t0 = min(near, key=lambda t: abs(t - t0))
        raw.append((t0, b * hop, pitch, float(np.percentile(db[a:b], 80)), max(0.0, min(1.0, conf))))
    raw.sort()
    raw = [r for i, r in enumerate(raw) if not (i and r[1] - r[0] < 0.11 and raw[i - 1][1] >= r[0] - 0.03       # an octave blip on a note's fade
                                                and (r[2] - raw[i - 1][2]) in (12, 19, 24))]
    starts = [r[0] for r in raw]
    gc = grid_check(starts, grid, None)
    shift = gc.mean_offset if gc.on_grid else 0.0
    ref = np.percentile([r[3] for r in raw], 90) if raw else 0.0
    notes = _quantize(raw, grid, snap, shift, ref)
    on = Onsets(starts, [1.0] * len(starts))
    rh = rhythm(on, grid, snap, shift)
    key = _key_of_notes(notes)
    return Heard(cents, key, gc, guess_chords(notes, grid, key), rh, on, notes, "notes")


def _quantize(raw, grid: Grid, snap: "int | list[int]", shift: float, ref_db: float) -> list[HeardNote]:
    """Onsets and ends to the nearest slot; a note is at least a slot long, never past the next note's start, and a gap
    of under a slot and 60 ms to the next note is closed (legato)."""
    slots = np.append(_slot_times(grid, snap), grid.edges()[-1])
    nslots = len(slots) - 1
    cum = np.cumsum([0] + _beat_slots(grid, snap))

    def beat_of(k: int) -> Fraction:                           # slot index to beats (a Fraction)
        i = min(int(np.searchsorted(cum, k, side="right")) - 1, len(cum) - 2)
        return Fraction(i) + Fraction(k - int(cum[i]), int(cum[i + 1] - cum[i]))
    q = []
    for t0, t1, pitch, db, conf in raw:
        if t0 - shift < slots[0] - 0.05 or t0 - shift >= slots[-1]:
            continue
        s = int(np.argmin(np.abs(slots - (t0 - shift))))
        e = int(np.argmin(np.abs(slots - (t1 - shift))))
        q.append([s, e, pitch, int(max(1, min(127, round(105 + 2 * (db - ref_db))))), conf, t0, t1])
    out = []
    for i, (s, e, pitch, vel, conf, t0, t1) in enumerate(q):
        nxt = q[i + 1] if i + 1 < len(q) else None
        if nxt and nxt[0] <= s:
            continue                                               # two notes on one slot: the later one is an ornament of it
        if nxt:
            if nxt[5] - t1 < 0.06 or nxt[0] - e <= 1:
                e = nxt[0]
            e = min(e, nxt[0])
        e = min(max(e, s + 1), nslots)
        if s >= nslots:
            continue
        out.append(HeardNote(beat_of(s), beat_of(e), pitch, vel, round(conf, 2), round(t0, 4)))
    return out


def _key_of_notes(notes: list[HeardNote]) -> Key:
    """Krumhansl-Schmuckler on the notes' pitch classes weighted by duration; the last note nudges the tonic."""
    if not notes:
        return estimate_key(np.ones((1, 12)))
    v = np.zeros((1, 12))
    for n in notes:
        v[0, n.pitch % 12] += float(n.end_beat - n.start_beat)
    last = (notes[-1].pitch % 12, None)
    return estimate_key(v, None, (notes[0].pitch % 12, None), last)


def _triads(key: Key) -> list[tuple[int, str]]:
    """The key's diatonic triads as (root, quality), plus the major V of a minor key."""
    steps = (0, 2, 4, 5, 7, 9, 11) if key.mode == "major" else (0, 2, 3, 5, 7, 8, 10)
    pcs = [(key.tonic + s) % 12 for s in steps]
    out = []
    for i, r in enumerate(pcs):
        third, fifth = (pcs[(i + 2) % 7] - r) % 12, (pcs[(i + 4) % 7] - r) % 12
        out.append((r, "maj" if (third, fifth) == (4, 7) else "min" if (third, fifth) == (3, 7) else "dim"))
    if key.mode == "minor":
        out.append((pcs[4], "maj"))
    return out


def guess_chords(notes: list[HeardNote], grid: Grid, key: Key) -> list[ChordSpan]:
    """A rough chord per bar from a melody: the diatonic triad of the key that covers the most of the bar's notes (by
    duration, the downbeat counting double and the middle of the bar half as much again; chord tones weigh root > third >
    fifth, other notes count against it). A guess, with low confidence, marked src='melody'."""
    flats = _flats(key)
    prior = {0: .06, 4: .04, 3: .03}                               # tonic, dominant, subdominant by degree
    cands = _triads(key)
    out = []
    for a, b in grid.bars():
        w = np.zeros(12)
        for n in notes:
            for beat in range(a, b):
                lo, hi = max(float(n.start_beat), beat), min(float(n.end_beat), beat + 1)
                if hi > lo:
                    pos = beat - a
                    w[n.pitch % 12] += (hi - lo) * (2.0 if pos == 0 else 1.5 if (b - a >= 4 and pos == (b - a) // 2) else 1.0)
        total = w.sum()
        if total < 0.5:
            out.append(ChordSpan(a, b, "N", 0, "N", 0, 0.0, None, "", "melody"))
            continue
        scores = []
        for i, (r, q) in enumerate(cands):
            tones = [(r + iv) % 12 for iv, _ in QUALITIES[q][1]]
            wt = [wt for _, wt in QUALITIES[q][1]]
            cover = sum(w[p] * x for p, x in zip(tones, wt))
            rest = total - sum(w[p] for p in tones)
            scores.append((cover - 0.35 * rest) / total + prior.get(i, 0) + (0.03 if q == "maj" and i == 7 else 0))
        order = np.argsort(scores)[::-1]
        r, q = cands[order[0]]
        r2, q2 = cands[order[1]]
        conf = float(np.clip(0.15 + 0.4 * (scores[order[0]] - scores[order[1]]), 0.1, 0.4))
        out.append(ChordSpan(a, b, symbol(r, q, None, flats), r, q, r, round(conf, 2),
                             (symbol(r2, q2, None, flats), round(max(conf - 0.1, 0.05), 2)), "", "melody"))
    return out


def hear(x: np.ndarray, sr: int, grid: Grid, mode: str = "auto", snap: "int | list[int]" = 4) -> Heard:
    """Chords or notes: `mode` 'auto' decides by voicing (see `decide`), or force 'chords' / 'notes'."""
    if mode == "chords":
        return hear_chords(x, sr, grid)
    x = prepare(x, sr)
    tr = f0_track(x)
    d = decide(tr) if mode == "auto" else None
    if mode == "notes" or d.mode == "notes":
        h = hear_notes(x, SR, grid, snap, tr)
    else:
        h = hear_chords(x, SR, grid)
    h.decision = d
    return h


# --- text -----------------------------------------------------------------------------------------


def _bar_notes(h: Heard, a: int, b: int, beat_q: Fraction, flats: bool) -> str:
    """The notes of beats [a, b) in badmidi notation: `A3.q C4.e R.e G4.h~`; `?` marks an unsure pitch, `~` a note that goes on."""
    out, t = [], Fraction(a)
    for n in h.notes:
        if n.end_beat <= a or n.start_beat >= b:
            continue
        s, e = max(n.start_beat, Fraction(a)), min(n.end_beat, Fraction(b))
        if s > t:
            out.append("R" + dur_suffix((s - t) * beat_q))
        out.append(f"{pc_name(n.pitch % 12, flats)}{n.pitch // 12 - 1}{dur_suffix((e - s) * beat_q)}"
                   + ("~" if n.end_beat > b else "") + ("?" if n.confidence < 0.5 else ""))
        t = e
    return " ".join(out) if out else "R" + dur_suffix((b - a) * beat_q)


def format_chart(h: Heard, grid: Grid, name: str = "audio", first_bar: int = 1, mode: str | None = None,
                 beat_q: Fraction = Fraction(1), where: str | None = None) -> str:
    """One bar per line with confidence, a runner-up where unsure; then tuning, key, grid check, rhythm (bars with the
    same pattern share a line). `first_bar` numbers the bars; `mode` ('chords', 'notes') is named in the header, with the
    reason when it was chosen by ear. A line heard as notes prints the notes of each bar (`beat_q`: quarters per beat) and
    a guess at the chord, which is not heard. `where` replaces the grid check's words in the header (how the take sits on the beats)."""
    bars = grid.bars()
    gc = h.grid_check
    span = f"{len(bars)} bars" + (f" ({first_bar}-{first_bar + len(bars) - 1})" if first_bar != 1 else "")
    why = f" (auto: {h.decision.why})" if h.decision else ""
    lines = [f"{name}, {span}, " + (f"heard as {mode}{why}, " if mode else "") + f"tuning {h.tuning_cents:+.0f} c, key {h.key.name}, "
             + (where or (f"on the grid ({gc.mean_offset * 1000:+.0f} ms)" if gc.on_grid else
                          f"OFF the grid (mean {gc.mean_offset * 1000:+.0f} ms, drift {gc.drift * 1000:+.0f} ms, spread {gc.spread * 1000:.0f} ms)"))]
    notes = h.mode == "notes"
    for n, (a, b) in enumerate(bars, first_bar):
        cells = []
        for c in ([] if notes else h.chords):
            if c.end_beat <= a or c.start_beat >= b:
                continue
            cell = f"{c.symbol} {c.confidence:.2f}" + (f" | {c.runner_up[0]} {c.runner_up[1]:.2f}  <- unsure" if c.unsure() else "")
            if c.quality == "5" and c.implied:
                cell += " (power chord, minor by key)"
            cells.append(cell)
        if notes:
            g = next((c for c in h.chords if c.start_beat == a and c.src == "melody"), None)
            cells = [_bar_notes(h, a, b, beat_q, _flats(h.key)) + (f"   | guess: {g.symbol}" if g and g.quality != "N" else "")]
        lines.append(f"{n:>3}  " + "  ".join(cells))
    if notes:
        lines.append("(guess: the key's triad covering most of the bar's notes, strong beats counting more; a rough starting point "
                     "for bass.line, NOT heard. ? = unsure pitch, ~ = tied on)")
    if h.rhythm.bars:
        per_beat = iter(h.rhythm.beat_slots or [])
        runs: list[list] = []                                    # [first bar, last bar, text]
        for n, row in enumerate(h.rhythm.bars, first_bar):
            cells, i = [], 0
            while i < len(row):
                k = next(per_beat, h.rhythm.slots_per_beat)
                cells.append("".join("x" if v >= 0.5 else "o" if v >= 0.2 else "." for v in row[i:i + k]))
                i += k
            text = " ".join(cells)
            if runs and runs[-1][2] == text and runs[-1][1] == n - 1:
                runs[-1][1] = n
            else:
                runs.append([n, n, text])
        for a, b, text in runs[:8]:
            lines.append(f"rhythm {'bar %d' % a if a == b else 'bars %d-%d' % (a, b)}: | {text} |")
        if len(runs) > 8:
            lines.append(f"rhythm: ... {len(runs) - 8} more patterns")
        lines.append("(rhythm: onset strength per slot, x strong, o weak)")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    import soundfile as sf
    ap = argparse.ArgumentParser(prog="python -m badmidi.audio.hear", description="Debug: print the chords heard in a WAV.")
    ap.add_argument("file")
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--meter", default="4/4")
    ap.add_argument("--offset", type=float, default=0.0, help="seconds from the file start to beat 1")
    ap.add_argument("--as", dest="mode", default="auto", choices=("auto", "chords", "notes"))
    a = ap.parse_args(argv)
    x, sr = sf.read(a.file, dtype="float32", always_2d=True)
    x = prepare(x, sr)
    per_bar = int(a.meter.split("/")[0])
    beat = 60.0 / a.bpm * 4 / int(a.meter.split("/")[1])
    n = int((len(x) / SR - a.offset) / beat)
    n = n // per_bar * per_bar or n                  # whole bars; the reverb tail is not a bar
    grid = Grid([a.offset + i * beat for i in range(n)], [i % per_bar == 0 for i in range(n)], a.offset + n * beat)
    h = hear(x, SR, grid, a.mode)
    print(format_chart(h, grid, a.file, 1, h.mode, Fraction(4, int(a.meter.split("/")[1]))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
