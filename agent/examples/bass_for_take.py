"""A bass for a recorded take, the deterministic baseline of the chat loop in AGENTS.md "Making a part for a recording".

    MOBDAW_TOKEN=mdw_... python examples/bass_for_take.py "My Song" --track Guitar [--style walk] [--bars 1-16] [--dry-run]
    MOBDAW_TOKEN=mdw_... python examples/bass_for_take.py "My Song" --track Guitar --watch

Once (no --watch): listen to the track, draft a bass with `bass.line`, check it against the heard chords, push it as a new
"bass guitar" track with the `bass` patch as ONE history entry labelled "bass for Guitar", and say what happened in chat.
It follows whatever timing the take has and never refuses it: with a click track or MIDI in the project the bass is on the project's
grid and the reply says how the take sits against it ("the take sits +35 ms behind the beats: move the clip 35 ms earlier"); in an
audio-only project the time map is set from the audio in the same entry ("set the project tempo to 92 bpm 4/4 (pickup 0.4 s) to
match the take"; a revert undoes both; `--keep-map` leaves the map alone), with a warning naming the other reading when it is unsure.
With --watch it waits in the project for a chat message that mentions this token's handle ("@you(api) bass for Guitar,
bars 1-8, walk") and does that for each one, answering in chat. Needs `pip install 'badmidi[audio]'` and MOBDAW_URL if the
server is not the default.

This does no thinking: the style is a flag and the line is the generator's draft. A model replaces `draft()` with a part
written by taste (edit the Motif, `lens` it against "guitar (heard)"), and keeps everything around it.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from dataclasses import dataclass, field

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from badmidi import bass  # noqa: E402
from badmidi.audio.listen import Listened, listen  # noqa: E402
from badmidi.bridge import BridgeError, Client, SampleIncoming, plan, pull  # noqa: E402
from badmidi.views import has_errors  # noqa: E402


@dataclass
class Result:
    chart: str                  # "Am | F | C | G", one entry per bar
    summary: str                # what was pushed
    seq: int | None             # the history entry (None: dry run)
    unsure: list[str]
    warnings: list[str] = field(default_factory=list)       # the timing's: how the take sits on the beats, or what was guessed
    map_note: str = ""          # audio-only project: the time map the push sets (empty: the project's map is untouched)


def bar_spans(got: Listened) -> list[tuple]:
    part = got.part
    if part.rhythm and part.rhythm.bars:
        spans = part.rhythm.bar_spans()
        first = part.chords[0].start if part.chords else spans[0][0]
        return ([(first, spans[0][0])] if first < spans[0][0] else []) + spans           # (a pickup bar of an audio-only project has no rhythm row)
    return [(part.chords[0].start + 4 * i, part.chords[0].start + 4 * i + 4) for i in range(got.bars[1] - got.bars[0] + 1)]


def chart_line(got: Listened) -> str:
    """The heard chords, bar by bar: `Am | F | C | G` (two chords in a bar: `Am F`), `?` after a chord it is unsure of."""
    part, spans = got.part, bar_spans(got)
    bars = [" ".join(c.symbol + ("?" if c.is_unsure() else "") for c in part.chords if a <= c.start < z and not c.silent) or "-" for a, z in spans]
    return " | ".join(bars)


def draft(got: Listened, score, style: str):
    """The bass Motif for the heard chords. A model writes this part by taste; this is the generator's draft."""
    return bass.line(got.part, style=style, key=score.key)


def map_note(got: Listened, applied: bool) -> str:
    """The sentence about the time map an audio-only project gets from its audio ('' when the map is not touched)."""
    p = got.proposal
    if p is None:
        return ""
    pickup = f" (pickup {p.pickup_s:.1f} s)" if p.pickup_s else ""
    what = f"the project tempo to {p.bpm:.0f} bpm {p.meter}{pickup}" if p.kind == "steady" else f"the project's tempo map to follow the take, about {p.bpm:.0f} bpm {p.meter}{pickup}, {len(p.metered())} tempo regions"
    return f"{'I set' if applied else 'would set'} {what} to match the take (the project had no click or MIDI to follow)."


def make_bass(c: Client, pid: str, track: str, style: str = "root-fifth", bars: tuple[int, int] | None = None,
              apply: bool = True, wait: float = 0, cache_dir: str | None = None, case: str = "auto", keep_map: bool = False) -> Result:
    """Listen to `track`, draft a bass, check it, push it. Raises BridgeError (SampleIncoming while the take uploads; the
    draft having errors). A take's timing is never a reason to stop: it is followed and reported in the Result."""
    state = c.state(pid)
    got = listen(c, pid, state, track, bars, "chords", wait, cache_dir, case=case, keep_map=keep_map)
    pulled = pull(state, pid, None, [got.part], got.proposal)
    score = pulled.score
    taken = {p.name for p in score.parts}
    name = next(n for n in ["bass guitar"] + [f"bass guitar {i}" for i in range(2, 99)] if n not in taken)
    score.part(name, "bass guitar").at(got.part.bar, draft(got, score, style))
    if has_errors(score):
        raise BridgeError("the draft has errors:\n" + score.check())
    pl = plan(score, pulled.snapshot, sound="bass")
    asks = [f"bar {got.bars[0] + i}: {c_.symbol} or {c_.alt}" for i, (a, z) in enumerate(bar_spans(got))
            for c_ in got.part.chords if a <= c_.start < z and c_.is_unsure()]
    if not apply:
        return Result(chart_line(got), f"dry run: {len(pl.ops)} ops, +{pl.adds} notes, {pl.new_tracks} new track", None, asks, got.warnings, map_note(got, False))
    res = c.ops(pid, pl.ops, f"bass for {track}")
    return Result(chart_line(got), f"{pl.adds} notes on a new {name!r} track ({style})", res["seq"], asks, got.warnings, map_note(got, True))


def reply_text(r: Result) -> str:
    text = f"heard: {r.chart}\nbass: {r.summary}."
    if r.unsure:
        text += " Unsure: " + "; ".join(r.unsure) + " (tell me the right chord and I will redo it)."
    if r.map_note:
        text += "\n" + r.map_note
    if r.warnings:
        text += "\ntiming: " + "; ".join(r.warnings) + "."
    if r.seq is not None:
        text += f"\nThe audio is unheard by me, so check it by ear; revert with history seq {r.seq}" + (" (it undoes the tempo change and the bass together)." if r.map_note else ".")
    return text


REQUEST = re.compile(r"bass\s+(?:for|to|under)\s+(?P<track>[\w ]+?)(?=\s*(?:,|\.|!|\?|bars?\s+\d|$|\b(?:" + "|".join(bass.STYLES) + r")\b))", re.I)


def parse_request(text: str, default_track: str, default_style: str) -> tuple[str, str, tuple[int, int] | None] | None:
    """(track, style, bars) from a chat line such as "@k(api) bass for Guitar, bars 1-8, walk", or None if it asks for no bass."""
    m = REQUEST.search(text)
    if not m:
        return None
    b = re.search(r"bars?\s+(\d+)(?:\s*-\s*(\d+))?", text, re.I)
    style = next((s for s in bass.STYLES if re.search(rf"\b{re.escape(s)}\b", text, re.I)), default_style)
    return m["track"].strip() or default_track, style, (int(b[1]), int(b[2] or b[1])) if b else None


def handle(c: Client, pid: str, track: str, style: str, bars, apply: bool = True, wait: float = 120, say=print,
           case: str = "auto", keep_map: bool = False) -> Result | None:
    """One request, answered in chat (and `say`)."""
    def tell(text: str):
        say(text)
        c.chat(pid, text)
    try:
        try:
            r = make_bass(c, pid, track, style, bars, apply, case=case, keep_map=keep_map)
        except SampleIncoming:
            tell(f"waiting for the take on {track} to upload")
            r = make_bass(c, pid, track, style, bars, apply, wait=wait, case=case, keep_map=keep_map)
    except BridgeError as e:
        tell(f"cannot make a bass for {track}: {e}")
        return None
    tell(reply_text(r))
    return r


def watch(c: Client, pid: str, track: str, style: str, apply: bool = True, once: bool = False, timeout: float | None = None,
          case: str = "auto", keep_map: bool = False) -> None:
    """Wait for chat messages that mention this token's handle and ask for a bass. `once`: return after the first one."""
    since = c.events(pid)["cursor"]
    print(f"waiting in the project's chat for a mention such as 'bass for {track}' ...", flush=True)
    end = None if timeout is None else time.time() + timeout
    while end is None or time.time() < end:
        r = c.events(pid, since, wait=25 if end is None else min(25, max(0, end - time.time())))
        since = r["cursor"]
        if r.get("gap"):
            print("(events were missed; only new messages are answered)")
        for e in r["events"]:
            if e["type"] != "chat" or not e["mentionsMe"]:
                continue
            req = parse_request(e["message"]["text"], track, style)
            if req:
                print(f"{e['message']['username']}: {e['message']['text']}")
                handle(c, pid, req[0], req[1], req[2], apply, case=case, keep_map=keep_map)
                if once:
                    return
    raise BridgeError("timed out waiting for a chat request for a bass")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", help="project id or name")
    ap.add_argument("--track", required=True, help="the audio track to hear")
    ap.add_argument("--style", default="root-fifth", choices=bass.STYLES)
    ap.add_argument("--bars", help="bar range such as 1-16 (default: where the audio is)")
    ap.add_argument("--watch", action="store_true", help="wait for chat requests instead of doing it once")
    ap.add_argument("--once", action="store_true", help="with --watch: stop after the first request")
    ap.add_argument("--dry-run", action="store_true", help="draft and check, push nothing")
    ap.add_argument("--case", default="auto", choices=("auto", "a", "b"), help="a: follow the project's time map; b: the audio defines it; auto: by the project's click track and MIDI notes")
    ap.add_argument("--keep-map", action="store_true", help="audio-only project: leave the time map alone (the bass will not sit on its bar lines)")
    args = ap.parse_args(argv)
    c = Client()
    pid = c.project_id(args.project)
    if args.watch:
        watch(c, pid, args.track, args.style, not args.dry_run, args.once, case=args.case, keep_map=args.keep_map)
        return 0
    from badmidi.cli import _bars
    r = handle(c, pid, args.track, args.style, _bars(args.bars), not args.dry_run, case=args.case, keep_map=args.keep_map)
    return 0 if r else 1


if __name__ == "__main__":
    sys.exit(main())
