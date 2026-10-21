"""End to end for listening to audio, against a running mobdaw server (not part of `unittest discover`: it needs one).

Easiest: `agent/tests/e2e_audio_live.sh`, which starts a throwaway local server (own port, database and storage), creates the
user, runs this, and stops the server. By hand, against a server you started and a user you made with `npm run admin`:

    MOBDAW_URL=http://localhost:8787 E2E_USER=e2e MOBDAW_PASSWORD=... python tests/e2e_audio_live.py [project id]

It records nothing: `tools/seed-take.ts` puts a generated WAV into a project the way the client does for a recorded take (upload
through the session routes, then `addSample` + `addAudioClip` on the project's collab document), and then the agent side is
checked over the agent API with an API token the seed tool mints (MOBDAW_TOKEN is set from it for the Python Client).
Without a project id it makes a new project, so it can be re-run against the same server.

Two projects are made. The first has the click track on (what the metronome button creates), so its time map is the truth and
a take that rushes the click is followed, warned about and answered with a bass on the project's grid. The second has no click and
no MIDI (a new project's state): a take at 87 bpm with a pickup defines the map, which the chat-loop agent sets in the same
history entry as the bass, and one revert undoes both.

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
TRIAD = {"Am": {9, 0, 4}, "F": {5, 9, 0}, "C": {0, 4, 7}, "G": {7, 11, 2}}      # (a bass note may be an inversion's)


def make_take(path, seed=1, bpm=BPM, pickup=0):
    """4 bars of Am F C G in open-position guitar shapes (x02210, 133211, x32010, 320003: one third among five or six strings),
    strummed down and up on six Karplus-Strong strings through a body and a room (tests/synth.py), at `bpm`, after `pickup` beats
    of the last chord."""
    beat = 60 / bpm
    x = synth.render(["Am", "F", "C", "G"][:BARS], bpm, 4, seed=seed, sr=SR, pickup=pickup)
    x = x[:int(SR * (beat * (pickup + 4 * BARS) + (0 if not pickup else 0.4)))]
    sf.write(path, x, SR, subtype="PCM_16")
    return len(x) / SR


NAMES: dict[str, str] = {}              # project id -> its name: the CLI is given names (an id can start with "-", which argparse reads as an option)


def seed(*args):
    """Run tools/seed-take.ts; returns the JSON it prints."""
    args = [f"--project={a[1]}" if a[0] == "--project" else a[0] for a in _pairs(args)]
    r = subprocess.run(["npx", "tsx", "tools/seed-take.ts", *args], cwd=ROOT, capture_output=True, text=True,
                       env={**os.environ, "E2E_SEED": "1"})
    print("$ seed-take", " ".join(a for a in args if not a.startswith("--password")), "\n" + r.stdout.rstrip() + ("\n" + r.stderr.rstrip() if r.stderr.strip() else ""))
    assert r.returncode == 0, f"seed-take exited {r.returncode}"
    return json.loads(r.stdout.strip().splitlines()[-1])


def _pairs(args):
    """The args as lists: ["--project", id] stays one item, so it can be written --project=id (an id may start with "-")."""
    out, i = [], 0
    while i < len(args):
        if args[i] == "--project" and i + 1 < len(args):
            out.append(("--project", args[i + 1]))
            i += 2
        else:
            out.append((args[i],))
            i += 1
    return [tuple(x) for x in out]


def cli(*args, ok=True):
    """Run the real CLI as an agent would (MOBDAW_URL and MOBDAW_TOKEN from the environment); returns stdout+stderr."""
    args = tuple(NAMES.get(a, a) for a in args)
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
    name1 = f"e2e audio {int(time.time())}"
    s1 = seed(*who, *(["--project", pid] if pid else ["--new-project", name1]), "--wav", wav, "--track", "Guitar", "--bar", "1", "--mint-token", "--click")
    pid = s1["project"]
    NAMES[pid] = name1 if not sys.argv[1:] else pid
    os.environ["MOBDAW_TOKEN"] = s1["token"]
    c = Client()

    state = c.state(pid)
    (click,) = [t for t in state["tracks"] if t.get("role") == "click"]            # the agent view marks the metronome's track
    assert click["name"] == "click" and not click["muted"] and click["clips"] == [], click
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
    proc = subprocess.Popen(["npx", "tsx", "tools/seed-take.ts", *who, f"--project={pid}", "--wav", wav2, "--track", "Keys", "--bar", "3", "--incoming", "3000"],
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
    assert "timing: project grid (a click track)" in chart and "tight to the project's beats" in chart, chart
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

    # --- d. a take that rushes the click is followed, not refused: exit 0, the warning and the hint, the bass on the project's grid
    drift = os.path.join(tmp, "drift.wav")
    make_take(drift, seed=3, bpm=BPM * 1.03)
    seed(*who, "--project", pid, "--wav", drift, "--track", "Drift", "--bar", "1")
    out = cli("listen", pid, "--track", "Drift", "--bars", "1-4")                  # (cli() asserts exit 0)
    assert "OFF the grid" not in out and "Re-record it" not in out, out
    assert re.search(r"warning: the take rushes to -\d+ ms by bar 4: it is about 3% faster than the project's 120 bpm", out), out
    assert re.search(r"set the project's tempo to about 12[34] bpm", out) and "stays on the click" in out, out
    assert re.findall(r"^\s*(\d+)\s+(\S+)", out, re.M)[:4] == [("1", "Am"), ("2", "F"), ("3", "C"), ("4", "G")], out
    piece2 = os.path.join(tmp, "drift.py")
    cli("pull", pid, "--listen", "Drift", "-o", piece2)
    with open(piece2, "a") as f:
        f.write('\ndrift_bass = score.part("drift bass", "bass guitar")\n'
                'drift_bass.at(HEARD["drift"].bar, bass.line(HEARD["drift"], style="root-fifth", key=score.key))\n')
    cli(piece2, "check")
    cli("push", piece2, "--patch", "bass", "--apply", "--label", "bass for Drift")
    state = c.state(pid)
    dclip, = [x for x in next(t for t in state["tracks"] if t["name"] == "drift bass")["clips"] if x["kind"] == "midi"]
    for bar, sym in enumerate(("Am", "F", "C", "G")):                            # the chord changes are on the project's bar lines
        at = [n for n in dclip["notes"] if dclip["startTick"] + n["t"] == bar * ppq * 4]
        assert at and as_pitch(at[0]["p"]).midi % 12 in TRIAD[sym], (bar + 1, sym, [(n["p"], n["t"]) for n in dclip["notes"]])
    assert all((dclip["startTick"] + n["t"]) % ppq == 0 for n in dclip["notes"]), "every bass note is on a project beat"
    print("drift bass:", " ".join(f"{n['p']}@{(dclip['startTick'] + n['t']) / ppq:g}" for n in dclip["notes"]))

    # --- e. the chat loop: a person asks in chat, the example agent listens, drafts, pushes, and answers in chat
    n_hist = len(history(c, pid))
    agent = subprocess.Popen([sys.executable, "-u", os.path.join(ROOT, "agent", "examples", "bass_for_take.py"), NAMES.get(pid, pid), "--track", "Guitar",
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

    # --- f. an audio-only project: the audio defines the time map, set in the same history entry as the bass
    BPM2, PICKUP = 87, 2
    wav87 = os.path.join(tmp, "take87.wav")
    make_take(wav87, seed=4, bpm=BPM2, pickup=PICKUP)
    name2 = f"e2e audio only {int(time.time())}"
    s3 = seed(*who, "--new-project", name2, "--wav", wav87, "--track", "Guitar", "--bar", "1", "--mint-token")
    pid2 = s3["project"]
    NAMES[pid2] = name2
    os.environ["MOBDAW_TOKEN"] = s3["token"]
    c = Client()
    state = c.state(pid2)
    assert not any(t.get("role") == "click" for t in state["tracks"]), "a new project has no click track until the metronome is switched on"
    assert not any(cl["kind"] == "midi" and cl["notes"] for t in state["tracks"] for cl in t["clips"])
    assert [(r["kind"], r["bpm"], r["meter"]) for r in state["regions"]] == [("metered", 120, "4/4")], state["regions"]
    chart = cli("listen", pid2, "--track", "Guitar")
    assert re.search(r"timing: audio only \(no click track and no MIDI notes\), so the audio defines the map: 8[67]\.\d bpm 4/4, first downbeat at 1\.\d+ s \(a pickup of 1\.\d+ s\)", chart), chart
    assert re.search(r"map: bar 1: free 1\.\d+ s \| bar 2: 8[67]\.\d+ bpm 4/4", chart), chart
    assert [r["kind"] for r in c.state(pid2)["regions"]] == ["metered"], "listen alone changes nothing"
    n_hist = len(history(c, pid2))
    agent = subprocess.Popen([sys.executable, "-u", os.path.join(ROOT, "agent", "examples", "bass_for_take.py"), name2, "--track", "Guitar",
                              "--style", "roots", "--watch", "--once"], cwd=os.path.join(ROOT, "agent"), stdout=subprocess.PIPE, text=True)
    try:
        assert "waiting" in agent.stdout.readline(), "the agent did not start waiting"
        seed(*who, "--project", pid2, "--chat", f"@{user}(api) bass for Guitar")
        until(lambda: agent.poll() is not None, "the agent to answer", 120)
    finally:
        if agent.poll() is None:
            agent.kill()
        rest = agent.stdout.read()
    print(rest.rstrip())
    assert agent.returncode == 0, f"bass_for_take exited {agent.returncode}"
    hist = history(c, pid2)
    assert len(hist) == n_hist + 1 and hist[-1]["text"] == "bass for Guitar", hist[-2:]          # the map and the bass: ONE entry
    seq = hist[-1]["seq"]
    chat = c._call("GET", f"/projects/{pid2}/chat?since=0")["messages"]
    reply = [m for m in chat if m["username"] == f"{user} (api)"][-1]["text"]
    print("chat reply:", reply.replace("\n", " / "))
    assert re.search(r"I set the project tempo to 8[67] bpm 4/4 \(pickup 1\.4 s\) to match the take", reply), reply
    assert f"revert with history seq {seq} (it undoes the tempo change and the bass together)" in reply, reply
    state = c.state(pid2)
    free, bar2 = state["regions"]
    assert free["kind"] == "free" and abs(free["seconds"] - PICKUP * 60 / BPM2) < 0.03, free             # the pickup is a free bar
    assert bar2["kind"] == "metered" and bar2["bar"] == 2 and bar2["meter"] == "4/4" and abs(bar2["bpm"] / BPM2 - 1) < 0.02, bar2
    from badmidi.bridge import Timeline
    tl = Timeline(state)
    bclip, = [x for x in next(t for t in state["tracks"] if t["name"] == "bass guitar")["clips"] if x["kind"] == "midi"]
    notes = [(bclip["startTick"] + n["t"], n["p"]) for n in bclip["notes"]]
    for k, sym in enumerate(("Am", "F", "C", "G")):                  # the bass changes with the take, within 20 ms, under the NEW map
        tick = tl.bar_start(2 + k)
        at = [p for t_, p in notes if abs(t_ - float(tick)) < 0.01]               # (the free bar's nominal ticks need not be whole)
        assert at and as_pitch(at[0]).midi % 12 in TRIAD[sym], (k, sym, notes)
        want = (PICKUP + 4 * k) * 60 / BPM2
        assert abs(tl.seconds_at(tick) - want) < 0.02, (k, tl.seconds_at(tick), want)
    assert any(t_ < tl.bar_start(2) for t_, _ in notes), "the pickup has its bass note"
    print("map:", [(r["bar"], r["kind"], r.get("seconds") or r["bpm"]) for r in state["regions"]], "bass:", " ".join(f"{p}@{t_ / ppq:g}" for t_, p in notes))
    r = c._call("POST", f"/projects/{pid2}/history/{seq}/revert")                # one revert undoes both
    assert not r.get("skipped"), r
    state = c.state(pid2)
    assert [(x["kind"], x["bar"], x["bpm"], x["meter"]) for x in state["regions"]] == [("metered", 1, 120, "4/4")], state["regions"]
    assert not any(t["name"] == "bass guitar" for t in state["tracks"]), [t["name"] for t in state["tracks"]]
    print("revert: the project is back to its default map and has no bass track")

    print(f"\nOK: end to end (projects {pid}, {pid2})")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
