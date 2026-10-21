"""End to end for listening to audio, against a running mobdaw server (not part of `unittest discover`: it needs one).

Easiest: `agent/tests/e2e_audio_live.sh`, which starts a throwaway local server (own port, database and storage), creates the
user, runs this, and stops the server. By hand, against a server you started and a user you made with `npm run admin`:

    MOBDAW_URL=http://localhost:8787 E2E_USER=e2e MOBDAW_PASSWORD=... python tests/e2e_audio_live.py [project id]

It records nothing: `tools/seed-take.ts` puts a generated WAV into a project the way the client does for a recorded take (upload
through the session routes, then `addSample` + `addAudioClip` on the project's collab document), and then the agent side is
checked over the agent API with an API token the seed tool mints (MOBDAW_TOKEN is set from it for the Python Client).
Without a project id it makes a new project, so it can be re-run against the same server.

Needs numpy, scipy and soundfile (the `badmidi[audio]` extra) and `npx tsx`.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from badmidi.audio import source  # noqa: E402
from badmidi.bridge import Client, SampleIncoming  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BPM, BARS, SR = 120, 4, 44100          # a new project is 120 bpm 4/4: a bar is 2 s
CHORDS = [("A2", [0, 7, 12, 15, 19]), ("F2", [0, 7, 12, 16, 19]), ("C3", [0, 7, 12, 16, 19]), ("G2", [0, 7, 12, 16, 19])]   # Am F C G


def midi_hz(m):
    return 440 * 2 ** ((m - 69) / 12)


def pluck(hz, seconds, rng):
    """Karplus-Strong: a noise burst through a delay line with a lowpass in the feedback."""
    n = int(SR * seconds)
    d = int(SR / hz)
    buf = rng.uniform(-1, 1, d)
    out = np.empty(n)
    for i in range(n):
        out[i] = buf[i % d]
        buf[i % d] = 0.996 * 0.5 * (buf[i % d] + buf[(i + 1) % d])
    return out


def make_take(path, seed=1):
    """4 bars of strummed chords, one per bar (Am F C G), each strummed on the downbeat and again on beat 3."""
    rng = np.random.default_rng(seed)
    bar = 60 / BPM * 4
    x = np.zeros(int(SR * bar * BARS))
    for b, (root, intervals) in enumerate(CHORDS):
        base = {"A2": 45, "F2": 41, "C3": 48, "G2": 43}[root]
        for beat in (0, 2):
            t0 = int(SR * (b * bar + beat * 60 / BPM))
            for k, iv in enumerate(intervals):             # strum: each string 15 ms after the last
                s = pluck(midi_hz(base + iv), 60 / BPM * 2, rng)
                i = t0 + int(SR * 0.015 * k)
                x[i:i + len(s)] += s[:len(x) - i] * 0.2
    sf.write(path, np.clip(x, -1, 1).astype(np.float32), SR, subtype="PCM_16")
    return len(x) / SR


def seed(*args):
    """Run tools/seed-take.ts; returns the JSON it prints."""
    r = subprocess.run(["npx", "tsx", "tools/seed-take.ts", *args], cwd=ROOT, capture_output=True, text=True,
                       env={**os.environ, "E2E_SEED": "1"})
    print("$ seed-take", " ".join(a for a in args if not a.startswith("--password")), "\n" + r.stdout.rstrip() + ("\n" + r.stderr.rstrip() if r.stderr.strip() else ""))
    assert r.returncode == 0, f"seed-take exited {r.returncode}"
    return json.loads(r.stdout.strip().splitlines()[-1])


def events(c, pid, since=None, wait=0):
    q = f"?wait={wait}" + (f"&since={since}" if since is not None else "")
    return c._call("GET", f"/projects/{pid}/events{q}")


def until(ok, what, secs=30):
    end = time.time() + secs
    while not ok():
        assert time.time() < end, f"timed out waiting for {what}"
        time.sleep(0.25)


def main(pid=None):
    user = os.environ.get("E2E_USER", "e2e")
    assert os.environ.get("MOBDAW_PASSWORD"), "set MOBDAW_PASSWORD (the password of E2E_USER)"
    who = ["--user", user]
    tmp = tempfile.mkdtemp(prefix="e2e-audio-")
    wav = os.path.join(tmp, "take.wav")
    seconds = make_take(wav)
    assert abs(seconds - BARS * 2) < 1e-6

    # --- 1. a take at bar 1 on "Guitar", the way a recording lands
    s1 = seed(*who, *(["--project", pid] if pid else ["--new-project", f"e2e audio {int(time.time())}"]), "--wav", wav, "--track", "Guitar", "--bar", "1", "--mint-token")
    pid = s1["project"]
    os.environ["MOBDAW_TOKEN"] = s1["token"]
    c = Client()

    state = c.state(pid)
    guitar = next(t for t in state["tracks"] if t["name"] == "Guitar")
    assert guitar["kind"] == "audio", guitar
    (clip,) = [x for x in guitar["clips"] if x["kind"] == "audio"]
    assert clip["id"] == s1["clipId"] and clip["sourceHash"] == s1["hash"], clip
    assert clip["start"] == "1.1.0" and clip["startSeconds"] == 0 and abs(clip["lengthSeconds"] - seconds) < 1e-3, clip
    assert clip["sourceOffsetSeconds"] == 0 and "loopSeconds" not in clip and clip["gain"] == 1, clip
    smp = state["samples"][s1["hash"]]
    assert smp["name"] == "take" and smp["mime"] == "audio/wav" and abs(smp["duration"] - seconds) < 1e-3 and "status" not in smp, smp

    signal, t0 = source.track_audio(c, pid, state, "Guitar", cache_dir=os.path.join(tmp, "cache"))
    assert t0 == 0 and signal.dtype == np.float32 and len(signal) == round(seconds * source.SR), (t0, len(signal))
    ref = source.decode(wav)
    assert np.allclose(signal, ref[:len(signal)], atol=1e-6), "the signal is not the uploaded take"
    assert np.abs(signal).max() > 0.05, "the take is silent"
    print(f"Guitar: {len(signal) / source.SR:.2f} s from t0={t0} s, peak {np.abs(signal).max():.2f}")

    # --- 2. a second take at bar 3 that is still 'incoming' for a while: the sample event, SampleIncoming, then the audio
    wav2 = os.path.join(tmp, "take2.wav")
    make_take(wav2, seed=2)                                # other bytes, so a new sample (the hash is the content)
    since = events(c, pid)["cursor"]                       # (also makes the project's event buffer exist)
    h2 = hashlib.sha256(open(wav2, "rb").read()).hexdigest()
    proc = subprocess.Popen(["npx", "tsx", "tools/seed-take.ts", *who, "--project", pid, "--wav", wav2, "--track", "Keys", "--bar", "3", "--incoming", "3000"],
                            cwd=ROOT, stdout=subprocess.PIPE, text=True)
    try:
        # the take is in the view as incoming (a new sample is not an event: its clip shows up as a history entry) and not downloadable
        until(lambda: c.state(pid)["samples"].get(h2, {}).get("status") == "incoming", "the incoming take")
        try:
            source.fetch(c, pid, h2, os.path.join(tmp, "cache"))
            raise AssertionError("an incoming take must not be fetchable")
        except SampleIncoming:
            pass
        # ... and when it is uploaded the agent hears about it
        seen = []
        deadline = time.time() + 30
        while time.time() < deadline and not seen:
            r = events(c, pid, since, wait=5)
            since = r["cursor"]
            seen += [e for e in r["events"] if e["type"] == "sample"]
        assert seen == [{"type": "sample", "hash": h2}], f"sample events: {seen}"
        print("sample events:", seen)
    finally:
        out, _ = proc.communicate(timeout=60)
    s2 = json.loads(out.strip().splitlines()[-1])
    assert s2["hash"] == h2 != s1["hash"]
    state = c.state(pid)
    keys = next(t for t in state["tracks"] if t["name"] == "Keys")
    assert keys["clips"][0]["start"] == "3.1.0" and keys["clips"][0]["startSeconds"] == 4, keys["clips"][0]
    sig2, t02 = source.track_audio(c, pid, state, "Keys", cache_dir=os.path.join(tmp, "cache"))
    assert t02 == 4 and len(sig2) == len(signal), (t02, len(sig2))
    assert np.allclose(sig2, source.decode(wav2)[:len(sig2)], atol=1e-6)

    # --- 3. (later milestones) `badmidi listen <pid> --track Guitar` must report Am | F | C | G; then write a Bass track, push it
    #        with `badmidi push ... --apply`, and check it against the heard chords. Extend here: `pid`, `c` and the seeded
    #        take (`wav`, 4 bars at 120 bpm, one chord per bar, strummed on beats 1 and 3) are ready.

    print(f"\nOK: end to end (project {pid})")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
