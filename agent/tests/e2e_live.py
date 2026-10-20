"""End to end against a running mobdaw server (not part of `unittest discover`: it needs one).

    MOBDAW_URL=http://localhost:8787 MOBDAW_TOKEN=mdw_... python tests/e2e_live.py <project id>

Builds a small 3/4 piece in the project through apply_ops (so the project has a meter, a key, a marker, a cello
ground and a violin with a custom device), then drives the real CLI: pull, check, edit the piece, push (dry run, then
--apply with --like), pull again, and asserts the second pull differs from the first by exactly the push.
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from badmidi.bridge import Client  # noqa: E402

HERE = os.path.join(os.path.dirname(__file__), "..")
GROUND = ["D3", "C3", "Bb2", "A2", "G2", "A2", "Bb2", "A2"]


def cli(*args, ok=True):
    r = subprocess.run([sys.executable, "-m", "badmidi", *args], cwd=HERE, capture_output=True, text=True)
    print("$ badmidi", " ".join(args), "\n" + r.stdout.rstrip() + ("\n" + r.stderr.rstrip() if r.stderr.strip() else ""))
    assert (r.returncode == 0) == ok, f"badmidi {args} exited {r.returncode}"
    return r.stdout


def main(pid):
    c = Client()
    c.ops(pid, [
        {"op": "setRegion", "bar": 1, "meter": "3/4", "bpm": 60},
        {"op": "setKey", "key": "D minor"},
        {"op": "addMarker", "bar": 5, "label": "B"},
        {"op": "addTrack", "name": "Cello", "preset": "none"},
        {"op": "addDevice", "trackId": "$3", "type": "bore", "name": "GM Cello", "params": {}},
        {"op": "addMidiClip", "trackId": "$3", "start": "1", "length": "8 bars"},
        {"op": "addNotes", "clipId": "$5", "notes": [{"p": p, "t": f"{i * 3} beats", "d": "3 beats", "v": 90} for i, p in enumerate(GROUND)]},
        {"op": "addTrack", "name": "Violin", "preset": "none"},
        {"op": "addDevice", "trackId": "$7", "type": "bore", "name": "GM Violin", "params": {}},
        {"op": "addMidiClip", "trackId": "$7", "start": "5", "length": "4 bars"},
        {"op": "addNotes", "clipId": "$9", "notes": [{"p": "A4", "t": f"{i * 3} beats", "d": "3 beats"} for i in range(4)]},
    ], "e2e setup")
    state0 = c.state(pid)
    assert state0["regions"][0]["meter"] == "3/4"

    with tempfile.TemporaryDirectory() as tmp:
        piece = os.path.join(tmp, "chaconne.py")
        out = cli("pull", pid, "-o", piece)
        assert "2 parts, 12 notes" in out, out
        cli(piece, "check")
        cli(piece, "grid", "--bars", "5-6")
        assert "nothing to push" in cli("push", piece)

        # edit: a new part (violin 3) from bar 5, and the cello's last ground note a bar shorter
        with open(piece, "a") as f:
            f.write('\nv3 = score.part("violin 3", "violin")\nv3.at(5, "F5.hd | E5.hd | D5.hd | C#5.hd |9")\n')
            f.write('score["cello"].clear(8, 8).at(8, "A2.h R.q |")\n')
        cli(piece, "check")
        dry = cli("push", piece, "--like", "Violin")
        assert "dry run" in dry and "new track 'violin 3'" in dry
        hist = len(c.history_since(pid, 0))
        out = cli("push", piece, "--like", "Violin", "--apply", "--label", "e2e: violin 3")
        assert "pushed as history entry" in out
        assert len(c.history_since(pid, 0)) == hist + 1, "one push must be ONE history entry"
        assert "nothing to push" in cli("push", piece), "the snapshot refresh should make a second push empty"

        state1 = c.state(pid)
        names = [t["name"] for t in state1["tracks"]]
        assert names == ["Cello", "Violin", "violin 3"], names
        chain = lambda t: [(d["type"], d.get("name"), d["params"]) for d in t["devices"]]
        assert chain(state1["tracks"][2]) == chain(state1["tracks"][1]), "like: Violin must copy the device chain"
        v3 = [n for cl in state1["tracks"][2]["clips"] for n in cl["notes"]]
        assert [(n["p"], n["d"]) for n in v3] == [("F5", 2880), ("E5", 2880), ("D5", 2880), ("C#5", 2880)], v3
        cello = [(n["p"], n["d"]) for cl in state1["tracks"][0]["clips"] for n in cl["notes"]]
        assert cello[-1] == ("A2", 1920), cello      # a half note = 1920 ticks
        assert state1["tracks"][0]["clips"][0]["notes"][0]["v"] == 90, "untouched notes keep their velocity"

        # pull again: the new piece must contain exactly that change
        piece2 = os.path.join(tmp, "again.py")
        cli("pull", pid, "-o", piece2)
        a, b = json.load(open(piece + ".mobdaw.json".replace(".py.", ".")) if False else open(os.path.join(tmp, "chaconne.mobdaw.json"))), json.load(open(os.path.join(tmp, "again.mobdaw.json")))
        key = lambda n: (n["track"], n["on"], n["midi"], n["dur"])
        assert sorted(map(key, a["notes"])) == sorted(map(key, b["notes"])), "snapshot after push != fresh pull"
        cli(piece2, "check")

        # a stale pull is refused
        c.ops(pid, [{"op": "addMarker", "bar": 7, "label": "C"}], "someone else")
        with open(piece, "a") as f:
            f.write('\nv3.at(9, "C5.hd |10")\n')
        out = subprocess.run([sys.executable, "-m", "badmidi", "push", piece, "--apply"], cwd=HERE, capture_output=True, text=True)
        assert out.returncode != 0 and "moved since the pull" in out.stderr, out.stderr
        print("stale push refused:", out.stderr.strip())
    print("\nOK: end to end")


if __name__ == "__main__":
    main(sys.argv[1])
