"""A project's audio as signals on the project timeline: fetch a sample, decode it, lay a track's clips out as it plays.

    path = fetch(client, pid, hash)               # ~/.cache/badmidi/samples/<hash> (env BADMIDI_CACHE), sha256-checked
    x = decode(path, sr=22050)                    # mono float32
    signal, t0 = track_audio(client, pid, state, "Guitar")   # the track as heard; signal[0] is at score second t0

Imports numpy, scipy and soundfile (the `badmidi[audio]` extra); the rest of badmidi needs none of them.
"""
from __future__ import annotations

import hashlib
import math
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
from scipy.signal import resample_poly

from ..bridge import BridgeError, Client, SampleIncoming

SR = 22050


def default_cache_dir() -> str:
    return os.environ.get("BADMIDI_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "badmidi", "samples")


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(client: Client, pid: str, hash: str, cache_dir: str | None = None, wait: float = 0) -> str:
    """The sample's bytes as a local file named by its hash. The hash is the content (sha256 of the file), so a cached file
    never goes stale. `wait` seconds: while the take is still uploading (SampleIncoming) retry with backoff, then raise."""
    d = cache_dir or default_cache_dir()
    path = os.path.join(d, hash)
    if os.path.exists(path):
        return path
    deadline, delay = time.monotonic() + wait, 1.0
    while True:
        try:
            url = client.sample_url(pid, hash)
            break
        except SampleIncoming:
            left = deadline - time.monotonic()
            if left <= 0:
                raise
            time.sleep(min(delay, left))
            delay = min(delay * 2, 10.0)
    # local storage answers with a path on the server (already holding its base path); S3 with an absolute URL
    url = urllib.parse.urljoin(client.base + "/", url)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".part")
    try:
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(url, timeout=120) as r:
            shutil.copyfileobj(r, out, 1 << 20)
        got = _sha256(tmp)
        if got != hash:
            raise BridgeError(f"sample {hash[:12]}: downloaded bytes hash to {got[:12]}, not the sample's hash (corrupt download?)")
        os.replace(tmp, path)
    except urllib.error.URLError as e:
        raise BridgeError(f"cannot download sample {hash[:12]}: {getattr(e, 'reason', e)}") from None
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return path


def decode(path: str, sr: int = SR) -> np.ndarray:
    """The file as mono float32 at `sr`. libsndfile first; `ffmpeg` on PATH for what it cannot read (mp3 in old builds, m4a, ...)."""
    try:
        import soundfile as sf
        x, rate = sf.read(path, dtype="float32", always_2d=True)
        x = x.mean(axis=1, dtype=np.float32)
        if rate != sr:
            g = math.gcd(int(rate), sr)
            x = resample_poly(x, sr // g, int(rate) // g).astype(np.float32)
        return np.ascontiguousarray(x)
    except Exception as e:                                   # libsndfile: unknown format, or soundfile itself missing
        first = e
    ff = shutil.which("ffmpeg")
    if not ff:
        raise BridgeError(f"cannot decode {os.path.basename(path)}: libsndfile says {first}; install ffmpeg to read other formats") from None
    r = subprocess.run([ff, "-v", "error", "-i", path, "-vn", "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"], capture_output=True)
    if r.returncode != 0 or not r.stdout:
        raise BridgeError(f"cannot decode {os.path.basename(path)}: libsndfile says {first}; ffmpeg says {r.stderr.decode(errors='replace').strip() or 'nothing'}")
    return np.frombuffer(r.stdout, dtype="<f4").astype(np.float32)


def clip_signal(src: np.ndarray, clip: dict, sr: int = SR) -> np.ndarray:
    """What an audio clip plays, `lengthSeconds` long, from the decoded sample `src`: frames [sourceOffset, +length), or when
    `loopSeconds` is shorter than the length, the pass [sourceOffset, +loop) repeated to fill it (`loopPhaseSeconds`, if the view
    gives it, is where in the pass the clip starts). Past the end of the sample is silence. Gain applied; fades are not."""
    off, n = round(clip.get("sourceOffsetSeconds", 0) * sr), round(clip["lengthSeconds"] * sr)
    loop = round((clip.get("loopSeconds") or 0) * sr)
    if 0 < loop < n:
        one = np.zeros(loop, np.float32)
        seg = src[off:off + loop]
        one[:len(seg)] = seg
        idx = (np.arange(n) + round(clip.get("loopPhaseSeconds", 0) * sr)) % loop
        out = one[idx]
    else:
        out = np.zeros(n, np.float32)
        seg = src[off:off + n]
        out[:len(seg)] = seg
    return out * np.float32(clip.get("gain", 1.0))


def _find_track(state: dict, track: str) -> dict:
    ts = state["tracks"]
    hits = [t for t in ts if t["id"] == track] or [t for t in ts if t["name"].lower() == track.lower()]
    if len(hits) != 1:
        raise BridgeError(f"{'no' if not hits else 'several'} track named {track!r}; tracks: " + ", ".join(t["name"] for t in ts))
    return hits[0]


def track_audio(client: Client, pid: str, state: dict, track: str, sr: int = SR, wait: float = 0,
                cache_dir: str | None = None) -> tuple[np.ndarray, float]:
    """The track's audio clips mixed into one mono float32 signal covering from the first clip's start to the last clip's end,
    and the score second its first sample sits at. Clips that overlap add."""
    t = _find_track(state, track)
    clips = [c for c in t["clips"] if c["kind"] == "audio"]
    if not clips:
        raise BridgeError(f"track {t['name']!r} has no audio clips")
    t0 = min(c["startSeconds"] for c in clips)
    t1 = max(c["startSeconds"] + c["lengthSeconds"] for c in clips)
    out = np.zeros(math.ceil((t1 - t0) * sr), np.float32)
    decoded: dict[str, np.ndarray] = {}
    for c in clips:
        h = c["sourceHash"]
        if h not in decoded:
            decoded[h] = decode(fetch(client, pid, h, cache_dir, wait), sr)
        x = clip_signal(decoded[h], c, sr)
        i = round((c["startSeconds"] - t0) * sr)
        x = x[:max(0, len(out) - i)]
        out[i:i + len(x)] += x
    return out, t0
