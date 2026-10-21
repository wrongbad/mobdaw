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
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from badmidi.audio import source  # noqa: E402
from badmidi import patches  # noqa: E402
from badmidi.core import as_pitch  # noqa: E402
from badmidi.bridge import Client, SampleIncoming  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "examples"))
import bass_for_take  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BPM, BARS, SR = 120, 4, 44100          # a new project is 120 bpm 4/4: a bar is 2 s


def make_take(path, seed=1, bpm=BPM):
    """4 bars of Am F C G in open-position guitar shapes (x02210, 133211, x32010, 320003: one third among five or six strings),
    strummed down and up on six Karplus-Strong strings through a body and a room (tests/synth.py), at `bpm`."""
    bar = 60 / bpm * 4
    x = synth.render(["Am", "F", "C", "G"][:BARS], bpm, 4, seed=seed, sr=SR)
    x = x[:int(SR * bar * BARS)]
    sf.write(path, x, SR, subtype="PCM_16")
    return len(x) / SR


def seed(*args):
    """Run tools/seed-take.ts; returns the JSON it prints."""
    r = subprocess.run(["npx", "tsx", "tools/seed-take.ts", *args], cwd=ROOT, capture_output=True, text=True,
                       env={**os.environ, "E2E_SEED": "1"})
    print("$ seed-take", " ".join(a for a in args if not a.startswith("--password")), "\n" + r.stdout.rstrip() + ("\n" + r.stderr.rstrip() if r.stderr.strip() else ""))
    assert r.returncode == 0, f"seed-take exited {r.returncode}"
    return json.loads(r.stdout.strip().splitlines()[-1])


def cli(*args, ok=True):
    """Run the real CLI as an agent would (MOBDAW_URL and MOBDAW_TOKEN from the environment); returns stdout+stderr."""
    r = subprocess.run([sys.executable, "-m", "badmidi", *args], cwd=os.path.join(ROOT, "agent"), capture_output=True, text=True)
    print("$ badmidi", " ".join(args), "\n" + r.stdout.rstrip() + ("\n" + r.stderr.rstrip() if r.stderr.strip() else ""))
    assert (r.returncode == 0) == ok, f"badmidi {args} exited {r.returncode}"
    return r.stdout + r.stderr


def history(c, pid):
    return c._call("GET", f"/projects/{pid}/history?since=0&limit=100")


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

    # --- 3. the CLI as an agent runs it: listen, pull --listen, draft a bass, push --patch bass
    chart = cli("listen", pid, "--track", "Guitar", "--bars", "1-4")
    assert "on the grid" in chart and "heard as chords" in chart and "key A minor" in chart and "unsure" not in chart, chart
    roots = re.findall(r"^\s*(\d+)\s+(\S+)", chart, re.M)
    assert roots == [("1", "Am"), ("2", "F"), ("3", "C"), ("4", "G")], roots

    piece = os.path.join(tmp, "piece.py")
    out = cli("pull", pid, "--listen", "Guitar", "-o", piece)
    assert "guitar (heard)" in out or "heard" in out, out
    src = open(piece).read()
    assert 'HEARD = {' in src and '"guitar"' in src, "the piece has no HEARD"
    with open(piece, "a") as f:
        f.write('\nbass_guitar = score.part("bass guitar")\n'
                'bass_guitar.at(HEARD["guitar"].bar, bass.line(HEARD["guitar"], style="root-fifth", key=score.key))\n')
    cli(piece, "check")
    grid = cli(piece, "grid", "--bars", "1-4")
    assert all(sym in grid for sym in ("Am", "F", "C", "G")), grid

    n_hist = len(history(c, pid))
    dry = cli("push", piece, "--patch", "bass")
    assert "dry run" in dry and "new track 'bass guitar'" in dry and "heard" not in dry, dry
    assert len(history(c, pid)) == n_hist, "a dry run changed the project"
    applied = cli("push", piece, "--patch", "bass", "--apply", "--label", "bass for Guitar")
    assert "pushed as history entry" in applied, applied
    hist = history(c, pid)
    assert len(hist) == n_hist + 1 and hist[-1]["text"] == "bass for Guitar", hist[-3:]

    state = c.state(pid)
    assert not any("heard" in t["name"] for t in state["tracks"]), [t["name"] for t in state["tracks"]]
    bass_track = next(t for t in state["tracks"] if t["name"] == "bass guitar")
    (dev,) = [d for d in bass_track["devices"] if d["type"] == "finnwave"]
    for k, v in patches.get("bass").params.items():
        assert abs(dev["params"][k] - v) < 1e-6, (k, v, dev["params"])
    (bclip,) = [x for x in bass_track["clips"] if x["kind"] == "midi"]
    notes = bclip["notes"]
    ppq = state["meta"]["ppq"]
    assert notes and all(as_pitch("E1").midi <= as_pitch(n["p"]).midi <= as_pitch("G3").midi for n in notes), [n["p"] for n in notes]
    for bar, root in enumerate((9, 5, 0, 7)):                   # A F C G on beat 1 of bars 1-4 (4/4, so a bar is 4 * ppq ticks)
        at = [n for n in notes if n["t"] == bar * ppq * 4]
        assert at, f"no bass note on beat 1 of bar {bar + 1}: {[(n['p'], n['t']) for n in notes]}"
        assert as_pitch(at[0]["p"]).midi % 12 == root, (bar + 1, at[0]["p"], root)
    print("bass:", " ".join(f"{n['p']}@{n['t'] / ppq:g}" for n in notes))

    # --- d. a take that is not on the click is refused with advice, not guessed at
    drift = os.path.join(tmp, "drift.wav")
    make_take(drift, seed=3, bpm=BPM * 1.03)
    seed(*who, "--project", pid, "--wav", drift, "--track", "Drift", "--bar", "1")
    bad = cli("listen", pid, "--track", "Drift", "--bars", "1-4", ok=False)
    assert "OFF the grid" in bad and "drifts from the project's beats" in bad and "Re-record" in bad, bad

    # --- e. the chat loop: a person asks in chat, the example agent listens, drafts, pushes, and answers in chat
    n_hist = len(history(c, pid))
    agent = subprocess.Popen([sys.executable, "-u", os.path.join(ROOT, "agent", "examples", "bass_for_take.py"), pid, "--track", "Guitar",
                              "--style", "walk", "--watch", "--once"], cwd=os.path.join(ROOT, "agent"), stdout=subprocess.PIPE, text=True)
    try:
        assert "waiting" in agent.stdout.readline(), "the agent did not start waiting"      # it holds an event cursor now
        seed(*who, "--project", pid, "--chat", f"@{user}(api) bass for Guitar, bars 1-4, walk")
        until(lambda: agent.poll() is not None, "the agent to answer", 90)
    finally:
        if agent.poll() is None:
            agent.kill()
        rest = agent.stdout.read()
    print(rest.rstrip())
    assert agent.returncode == 0, f"bass_for_take exited {agent.returncode}"
    chat = c._call("GET", f"/projects/{pid}/chat?since=0")["messages"]
    replies = [m for m in chat if m["username"] == f"{user} (api)"]
    assert any("heard: Am | F | C | G\n" in m["text"] and "Unsure" not in m["text"] for m in replies), [m["text"] for m in replies]
    hist = history(c, pid)
    assert len(hist) == n_hist + 1 and hist[-1]["text"] == "bass for Guitar", hist[-2:]
    assert f"revert with history seq {hist[-1]['seq']}" in replies[-1]["text"], replies[-1]["text"]
    print("chat reply:", replies[-1]["text"].replace("\n", " / "))
    state = c.state(pid)
    assert [t["name"] for t in state["tracks"]].count("bass guitar 2") == 1, [t["name"] for t in state["tracks"]]

    print(f"\nOK: end to end (project {pid})")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
