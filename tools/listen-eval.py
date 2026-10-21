#!/usr/bin/env python3
"""listen-eval: how well does badmidi hear a folder of recorded takes?

    tools/listen-eval.py docs/listen/eval-synth --label synth        # score a folder, write docs/listen/runs/<date>-synth/
    tools/listen-eval.py ~/takes --label my-guitar --out /tmp/x      # another folder, another place for the report
    tools/listen-eval.py --make-synth docs/listen/eval-synth         # (re)write the synthetic demo takes and their labels

A take is an audio file (wav, flac, mp3, ogg, m4a: anything `badmidi.audio.source.decode` reads) plus a label file of the same
name:

    take.chords.txt   the chords of a strummed or keyed part, one bar per line
    take.notes.txt    the notes of a sung or single-note line, one bar per line

Both start with header lines (`#` starts a comment, blank lines are ignored):

    bpm: 100              quarter notes per minute (in 6/8, 9/8 and 12/8 the beat is a dotted quarter at this tempo)
    meter: 4/4
    offset: 0.35          seconds from the start of the file to the first downbeat (default 0)
    key: A minor          optional; "A major / A minor" accepts either
    tuning: -12           optional: cents the recording is above A440, if you know (a synthetic take does)

then one bar per line. In a chords file a bar is chord symbols (`Am`, `F`, `C7`, `Dmaj7`, `Bm7`, `E5`, `Dsus4`, `G/B`, `N` for
none); two or more share the bar evenly (`Am E` is two beats each in 4/4). In a notes file a bar is badmidi notes with a duration
(`A3.q C4.e R.e G4.h`, `R` is a rest), as `badmidi listen` prints them.

For every take it hears the audio the way `badmidi listen` does (chords for .chords.txt, notes for .notes.txt, or with --auto
whatever the voicing decides), compares it with the label beat by beat, and writes to docs/listen/runs/<date>-<label>/:

    report.md   accuracy per take and overall, key, tuning, grid check, the commonest confusions, how well the confidence tracks
                the errors, and the bars that were wrong. Commit this one.
    bars.csv    every bar of every take: label, heard, per-bar accuracy, confidence. Git-ignored raw data.

Needs the `badmidi[audio]` extra (numpy, scipy, soundfile).
"""
from __future__ import annotations

import argparse
import csv
import datetime
import os
import re
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "agent"))

import numpy as np  # noqa: E402

from badmidi.audio import hear  # noqa: E402
from badmidi.audio.source import SR, decode  # noqa: E402
from badmidi.core import Pitch, duration, dur_suffix, pc_name  # noqa: E402

AUDIO = (".wav", ".flac", ".mp3", ".ogg", ".oga", ".m4a", ".aiff", ".aif")
PCS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# chord-symbol suffix -> hear.QUALITIES name (extensions are folded into the chord they extend)
SUFFIX = {"": "maj", "maj": "maj", "M": "maj", "6": "maj", "add9": "maj", "add2": "maj", "2": "maj", "69": "maj", "6/9": "maj",
          "m": "min", "min": "min", "mi": "min", "-": "min", "m6": "min", "madd9": "min",
          "7": "7", "9": "7", "11": "7", "13": "7", "dom7": "7", "7b9": "7", "7#9": "7", "7#11": "7", "aug": "maj", "+": "maj",
          "maj7": "maj7", "M7": "maj7", "maj9": "maj7", "M9": "maj7", "Δ": "maj7", "Δ7": "maj7",
          "m7": "m7", "min7": "m7", "-7": "m7", "mi7": "m7", "m9": "m7", "m11": "m7", "m13": "m7",
          "sus2": "sus2", "sus4": "sus4", "sus": "sus4", "7sus4": "sus4", "7sus": "sus4",
          "dim": "dim", "o": "dim", "°": "dim", "dim7": "dim", "o7": "dim", "m7b5": "dim", "ø": "dim",
          "5": "5"}
FAMILY = {"maj": "major", "7": "major", "maj7": "major", "min": "minor", "m7": "minor", "sus2": "sus2", "sus4": "sus4",
          "dim": "dim", "5": "power", "N": "N"}


class LabelError(ValueError):
    pass


def chord_of(sym: str) -> tuple[int, str]:
    """(root pitch class, quality) of a chord symbol; ('N') for no chord. The slash bass is ignored."""
    if sym.upper() in ("N", "N.C.", "NC", "X"):
        return 0, "N"
    m = re.fullmatch(r"([A-G])([#b]?)([^/]*)(?:/[A-G][#b]?)?", sym)
    if not m or m[3] not in SUFFIX:
        raise LabelError(f"cannot read the chord symbol {sym!r} (try Am, F, C7, Dmaj7, Bm7, E5, Dsus4, N)")
    return (PCS[m[1]] + {"#": 1, "b": -1, "": 0}[m[2]]) % 12, SUFFIX[m[3]]


def key_of(text: str) -> list[tuple[int, str]]:
    out = []
    for part in re.split(r"\s*[/|]\s*|\s+or\s+", text.strip()):
        m = re.fullmatch(r"([A-Ga-g])([#b]?)\s*(major|minor|maj|min|m|M)?", part.strip())
        if not m:
            raise LabelError(f"cannot read the key {text!r} (try 'A minor' or 'C major')")
        mode = "minor" if (m[3] or "major") in ("minor", "min", "m") else "major"
        out.append(((PCS[m[1].upper()] + {"#": 1, "b": -1, "": 0}[m[2]]) % 12, mode))
    return out


@dataclass
class Label:
    kind: str                                   # 'chords' | 'notes'
    bpm: float
    num: int = 4
    den: int = 4
    offset: float = 0.0
    keys: list[tuple[int, str]] = field(default_factory=list)
    tuning: float | None = None
    bars: list[list[str]] = field(default_factory=list)       # chord symbols, or note tokens
    synth: dict = field(default_factory=dict)

    @property
    def compound(self) -> bool:
        return self.den == 8 and self.num % 3 == 0 and self.num > 3

    @property
    def per_bar(self) -> int:
        return self.num // 3 if self.compound else self.num

    @property
    def beat_q(self) -> Fraction:
        """Quarter notes in a beat."""
        return Fraction(3, 2) if self.compound else Fraction(4, self.den)

    def grid(self) -> hear.Grid:
        d = 60.0 / self.bpm * float(self.beat_q)
        n = len(self.bars) * self.per_bar
        return hear.Grid([self.offset + i * d for i in range(n)], [i % self.per_bar == 0 for i in range(n)], self.offset + n * d)


def read_label(path: str) -> Label:
    kind = "chords" if path.endswith(".chords.txt") else "notes"
    lab = Label(kind, 0.0)
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    for n, raw in enumerate(lines, 1):
        if raw.startswith("# synth:"):                          # how a demo take was made (the scoring ignores it)
            lab.synth = dict(kv.split("=", 1) for kv in raw.split(":", 1)[1].split())
            continue
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        h = re.fullmatch(r"(bpm|meter|offset|key|tuning)\s*:\s*(.+)", line)
        try:
            if h:
                k, v = h[1], h[2].strip()
                if k == "bpm":
                    lab.bpm = float(v)
                elif k == "meter":
                    lab.num, lab.den = (int(x) for x in v.split("/"))
                elif k == "offset":
                    lab.offset = float(v)
                elif k == "key":
                    lab.keys = key_of(v)
                else:
                    lab.tuning = float(v)
            else:
                toks = line.replace("|", " ").split()
                if kind == "chords":
                    for t in toks:
                        chord_of(t)
                lab.bars.append(toks)
        except (ValueError, LabelError) as e:
            raise LabelError(f"{os.path.basename(path)} line {n}: {e}") from None
    if not lab.bpm or not lab.bars:
        raise LabelError(f"{os.path.basename(path)}: needs a 'bpm:' header and at least one bar")
    return lab


# --- truth and scoring ---------------------------------------------------------------------------


def truth_beats(lab: Label) -> list[tuple[int, str, str]]:
    """(root, quality, symbol) of every beat of the label's chords."""
    out = []
    for bar in lab.bars:
        for i in range(lab.per_bar):
            s = bar[min(i * len(bar) // lab.per_bar, len(bar) - 1)]
            out.append(chord_of(s) + (s,))
    return out


def truth_notes(lab: Label) -> list[tuple[Fraction, Fraction, int]]:
    """(start beat, end beat, MIDI pitch) of the label's notes, beats counted from the first downbeat."""
    out = []
    bq = lab.beat_q
    for b, bar in enumerate(lab.bars):
        t = Fraction(b * lab.per_bar) * bq                       # quarters
        for tok in bar:
            name, _, dur = tok.rstrip("~?").partition(".")
            d = duration(dur) if dur else Fraction(1)
            if name.upper() != "R":
                out.append((t / bq, (t + d) / bq, Pitch.parse(name).midi))
            t += d
    return out


def same_key(k: hear.Key, want: list[tuple[int, str]]) -> bool:
    return (k.tonic, k.mode) in want


def relative(k: hear.Key, want: list[tuple[int, str]]) -> bool:
    return any(k.mode != m and (k.tonic - t) % 12 == (3 if k.mode == "major" else 9) for t, m in want)


@dataclass
class Result:
    name: str
    lab: Label
    h: hear.Heard
    seconds: float
    rows: list[dict] = field(default_factory=list)            # one per bar
    beats: list[tuple] = field(default_factory=list)          # (bar, truth sym, heard sym, root ok, quality ok, family ok, conf, unsure)
    notes: dict = field(default_factory=dict)


def score_chords(r: Result) -> None:
    exp = truth_beats(r.lab)
    got = {i: c for c in r.h.chords for i in range(c.start_beat, c.end_beat)}
    for i, (root, qual, sym) in enumerate(exp):
        c = got.get(i)
        if c is None:
            r.beats.append((i // r.lab.per_bar, sym, "-", False, False, False, 0.0, False))
            continue
        rok = qual == "N" and c.quality == "N" or (qual != "N" and c.root_pc == root)
        qok = rok and c.quality == qual
        fok = rok and FAMILY[c.quality] == FAMILY[qual]
        r.beats.append((i // r.lab.per_bar, sym, c.symbol, rok, qok, fok, c.confidence, c.unsure()))
    for b in range(len(r.lab.bars)):
        bs = [x for x in r.beats if x[0] == b]
        heard = _runs([x[2] for x in bs])
        r.rows.append(dict(take=r.name, bar=b + 1, label=" ".join(r.lab.bars[b]), heard=heard, beats=len(bs),
                           root_ok=sum(x[3] for x in bs), quality_ok=sum(x[4] for x in bs), family_ok=sum(x[5] for x in bs),
                           mean_conf=round(float(np.mean([x[6] for x in bs])), 2), min_conf=round(min(x[6] for x in bs), 2),
                           unsure_beats=sum(x[7] for x in bs)))


def _runs(seq: list[str]) -> str:
    out = []
    for s in seq:
        if not out or out[-1] != s:
            out.append(s)
    return " ".join(out)


def score_notes(r: Result) -> None:
    want = truth_notes(r.lab)
    got = [(n.start_beat, n.end_beat, n.pitch) for n in r.h.notes]
    tol = Fraction(1, 4)
    used: set[int] = set()
    exact = near = pitch_only = 0
    for s, e, p in want:
        for tolerance, name in ((Fraction(0), "exact"), (tol, "near")):
            hit = next((j for j, (gs, ge, gp) in enumerate(got) if j not in used and gp == p and abs(gs - s) <= tolerance), None)
            if hit is not None:
                used.add(hit)
                if name == "exact":
                    exact += 1
                near += 1
                break
        else:
            pitch_only += any(gp == p and abs(gs - s) <= 1 for gs, ge, gp in got)
    octave = sum(1 for s, e, p in want if not any(gp == p and abs(gs - s) <= tol for gs, ge, gp in got)
                 and any(gp % 12 == p % 12 and abs(gs - s) <= tol for gs, ge, gp in got))
    r.notes = dict(n_true=len(want), n_heard=len(got), exact=exact, near=near, pitch_only=pitch_only, octave=octave,
                   recall=near / max(len(want), 1), precision=near / max(len(got), 1))
    for b in range(len(r.lab.bars)):
        a, z = b * r.lab.per_bar, (b + 1) * r.lab.per_bar
        r.rows.append(dict(take=r.name, bar=b + 1, label=" ".join(r.lab.bars[b]),
                           heard=hear._bar_notes(r.h, a, z, r.lab.beat_q, hear._flats(r.h.key)), beats=r.lab.per_bar,
                           root_ok="", quality_ok="", family_ok="", mean_conf="", min_conf="", unsure_beats=""))


# --- running -------------------------------------------------------------------------------------


def find_takes(folder: str) -> list[tuple[str, str, str]]:
    """(name, audio path, label path) for each label that has audio beside it."""
    out = []
    for f in sorted(os.listdir(folder)):
        m = re.fullmatch(r"(.+)\.(chords|notes)\.txt", f)
        if not m:
            continue
        audio = next((os.path.join(folder, m[1] + e) for e in AUDIO if os.path.exists(os.path.join(folder, m[1] + e))), None)
        if audio is None:
            print(f"skip {f}: no audio file {m[1]}.wav / .flac / .mp3 beside it (the demo set's are made with --make-synth)")
            continue
        out.append((m[1], audio, os.path.join(folder, f)))
    return out


def run_take(name: str, audio: str, labfile: str, auto: bool) -> Result:
    lab = read_label(labfile)
    x = decode(audio, SR)
    g = lab.grid()
    end = int(g.edges()[-1] * SR)
    x = x[:end] if len(x) >= end else np.pad(x, (0, end - len(x)))
    t = time.time()
    h = hear.hear(x, SR, g, "auto" if auto else lab.kind, 4)
    r = Result(name, lab, h, time.time() - t)
    if lab.kind == "chords" and h.mode == "chords":
        score_chords(r)
    elif lab.kind == "notes" and h.mode == "notes":
        score_notes(r)
    return r


# --- the report ----------------------------------------------------------------------------------


def pct(a: float, b: float) -> str:
    return f"{100 * a / b:.0f}%" if b else "-"


def tuning_err(r: Result) -> float | None:
    return None if r.lab.tuning is None else r.h.tuning_cents - r.lab.tuning


def report(results: list[Result], folder: str, label: str, when: str) -> str:
    chords = [r for r in results if r.beats]
    notes = [r for r in results if r.notes]
    wrong_mode = [r for r in results if not (r.beats or r.notes)]
    L = [f"# listen-eval: {label}", "",
         f"{when}, `{os.path.relpath(folder, ROOT) if folder.startswith(ROOT) else folder}`, {len(results)} takes, "
         f"git {_git()}, `tools/listen-eval.py`. Raw per-bar data: `bars.csv` (git-ignored).", ""]
    if results and all(r.lab.synth for r in results):
        L += ["These takes are synthetic (`agent/tests/synth.py`: strummed Karplus-Strong strings, a body, a room), and the hearing was "
              "fitted on the same material: read the numbers as the best case. The point of this tool is a folder of real recordings.", ""]
    nb = sum(len(r.beats) for r in chords)
    allb = [b for r in chords for b in r.beats]
    if chords:
        root, qual, fam = sum(b[3] for b in allb), sum(b[4] for b in allb), sum(b[5] for b in allb)
        keyed = [r for r in chords if r.lab.keys]
        kok = sum(same_key(r.h.key, r.lab.keys) for r in keyed)
        terr = [abs(e) for e in map(tuning_err, chords) if e is not None]
        L += ["## Overall (chords)", "",
              f"- **{len(chords)} takes, {nb} beats**: root right on **{pct(root, nb)}**, quality exactly right on **{pct(qual, nb)}** "
              f"(triad / 7th / power as labelled), major-minor-power family right on {pct(fam, nb)}.",
              f"- key right on **{kok}/{len(keyed)}** takes that name one"
              + (f" (a relative major/minor instead: {sum(relative(r.h.key, r.lab.keys) and not same_key(r.h.key, r.lab.keys) for r in keyed)})" if keyed else "") + ".",
              (f"- tuning within 3 cents of the label on {sum(e <= 3 for e in terr)}/{len(terr)} takes (mean error {np.mean(terr):.1f}, worst {max(terr):.1f} cents)."
               if terr else "- tuning: no take labels it."),
              f"- grid check passed on {sum(r.h.grid_check.on_grid for r in chords)}/{len(chords)} takes; "
              f"hearing took {np.mean([r.seconds for r in chords]):.1f} s per take on average.", ""]
        wrong = [b for b in allb if not b[4]]
        flagged = [b for b in allb if b[7]]
        L += ["### Does the confidence mean anything?", "",
              f"- mean confidence on beats heard right: {np.mean([b[6] for b in allb if b[4]] or [0]):.2f}; on beats heard wrong: "
              f"{np.mean([b[6] for b in wrong]) if wrong else float('nan'):.2f} ({len(wrong)} beats).",
              f"- beats marked `<- unsure`: {len(flagged)} ({pct(len(flagged), nb)}); of the wrong beats {pct(sum(b[7] for b in wrong), len(wrong))} were "
              f"marked, of the marked beats {pct(sum(not b[4] for b in flagged), len(flagged))} were wrong.", ""]
        conf = Counter((a, b) for r in chords for (_, a, b, _, ok, _, _, _) in r.beats if not ok)
        if conf:
            L += ["### Confusions (label -> heard, beats)", "", ", ".join(f"{a} -> {b} x{n}" for (a, b), n in conf.most_common(12)), ""]
        L += ["### Per take", "",
              "| take | bars | bpm | root | quality | family | key (label -> heard) | tuning err | grid | unsure | heard |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in chords:
            bs = r.beats
            te = tuning_err(r)
            k = (", ".join(f"{pc_name(t)} {m}" for t, m in r.lab.keys) + " -> " if r.lab.keys else "") + r.h.key.name
            ok = "" if not r.lab.keys else " ok" if same_key(r.h.key, r.lab.keys) else " REL" if relative(r.h.key, r.lab.keys) else " WRONG"
            heard = " \\| ".join(row["heard"] for row in r.rows)
            L.append(f"| {r.name} | {len(r.lab.bars)} | {r.lab.bpm:g} {r.lab.num}/{r.lab.den} | {pct(sum(b[3] for b in bs), len(bs))} | "
                     f"{pct(sum(b[4] for b in bs), len(bs))} | {pct(sum(b[5] for b in bs), len(bs))} | {k}{ok} | "
                     f"{'-' if te is None else f'{te:+.1f}'} | {'on' if r.h.grid_check.on_grid else 'OFF'} | {sum(b[7] for b in bs)} | "
                     f"{heard} |")
        L.append("")
        bad = [(r, row) for r in chords for row in r.rows if row["quality_ok"] != row["beats"]]
        if bad:
            L += ["### Bars that were not all right", ""]
            for r, row in bad:
                L.append(f"- {r.name} bar {row['bar']}: label `{row['label']}`, heard `{row['heard']}` "
                         f"({row['quality_ok']}/{row['beats']} beats right, confidence {row['mean_conf']:.2f})")
            L.append("")
    if notes:
        L += ["## Overall (notes)", "",
              f"- **{len(notes)} takes**: {sum(r.notes['near'] for r in notes)} of {sum(r.notes['n_true'] for r in notes)} labelled notes heard at the right "
              f"pitch within a 16th (recall {pct(sum(r.notes['near'] for r in notes), sum(r.notes['n_true'] for r in notes))}, precision "
              f"{pct(sum(r.notes['near'] for r in notes), sum(r.notes['n_heard'] for r in notes))}); "
              f"{sum(r.notes['exact'] for r in notes)} exactly on the labelled slot.", "",
              "| take | bpm | notes | heard | on the slot | within a 16th | right pitch, other time | octave errors | key | tuning err |",
              "|---|---|---|---|---|---|---|---|---|---|"]
        for r in notes:
            n, te = r.notes, tuning_err(r)
            L.append(f"| {r.name} | {r.lab.bpm:g} | {n['n_true']} | {n['n_heard']} | {n['exact']} | {n['near']} | {n['pitch_only']} | {n['octave']} | "
                     f"{r.h.key.name} | {'-' if te is None else f'{te:+.1f}'} |")
        L.append("")
    if wrong_mode:
        L += ["## Heard as the other kind", ""] + [f"- {r.name}: labelled {r.lab.kind}, heard as {r.h.mode} ({r.h.decision.why if r.h.decision else ''})"
                                                  for r in wrong_mode] + [""]
    return "\n".join(L)


def _git() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip() or "?"
    except OSError:
        return "?"


# --- the synthetic demo set ----------------------------------------------------------------------

# name -> (progression in tests/synth.py, render options). seed, detune (cents), drive (0 clean .. 4), wet (room)
DEMO = {
    "am-f-c-g": ("Am F C G", dict(seed=101)),
    "am-f-c-g-sharp": ("Am F C G", dict(seed=102, detune=15)),
    "am-f-c-g-flat": ("Am F C G", dict(seed=103, detune=-15)),
    "am-f-c-g-driven": ("Am F C G", dict(seed=104, drive=3)),
    "am-f-c-g-roomy": ("Am F C G", dict(seed=113, wet=0.45, noise=0.01)),
    "c-g-am-f": ("C G Am F", dict(seed=105, detune=5)),
    "em-c-g-d": ("Em C G D", dict(seed=106)),
    "d-a-bm-g": ("D A Bm G", dict(seed=107, detune=12)),
    "am-dm-e-am": ("Am Dm E Am", dict(seed=108)),
    "blues-in-a": ("A blues", dict(seed=109, detune=-8)),
    "g-em-c-d-70": ("G Em C D 70", dict(seed=110)),
    "g-em-c-d-140": ("G Em C D 140", dict(seed=111, detune=15)),
    "d-bm-g-a-waltz": ("D Bm G A 3/4", dict(seed=112)),
}
DEMO_POWER = ("power-e-a-d-e", ["E5", "A5", "D5", "E5"] * 2, 100, "E minor", dict(seed=114, drive=4))


def _write_label(path: str, bpm: float, per_bar: int, bars: list, key: str, detune: float, synth: dict, note: str = "") -> None:
    """A label file for a synthetic take (`key` as the header spells it)."""
    lines = [f"# Synthetic take made by tools/listen-eval.py --make-synth (tests/synth.py){'; ' + note if note else ''}.",
             f"# synth: " + " ".join(f"{k}={v}" for k, v in synth.items()),
             f"bpm: {bpm:g}", f"meter: {per_bar}/4", "offset: 0", f"key: {key}",
             f"tuning: {detune:g}", ""]
    lines += [" ".join(b) if not isinstance(b, str) else b for b in bars]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def make_synth(folder: str) -> None:
    sys.path.insert(0, os.path.join(ROOT, "agent", "tests"))
    import soundfile as sf
    import synth
    os.makedirs(folder, exist_ok=True)
    jobs = [(n, synth.PROGRESSIONS[p], o) for n, (p, o) in DEMO.items()]
    jobs.append((DEMO_POWER[0], synth.Prog(DEMO_POWER[1], DEMO_POWER[2], DEMO_POWER[3]), DEMO_POWER[4]))
    for name, p, opts in jobs:
        x = synth.render(p.bars, p.bpm, p.per_bar, p.pattern, **opts)
        sf.write(os.path.join(folder, name + ".wav"), x, synth.SR, subtype="PCM_16")
        bars = [[b] if isinstance(b, str) else list(b) for b in p.bars]
        key = "A major / A minor" if "blues" in name else p.key             # a blues in A is both
        _write_label(os.path.join(folder, name + ".chords.txt"), p.bpm, p.per_bar, bars, key, opts.get("detune", 0),
                     {**{"pattern": p.pattern or "default"}, **opts}, p.note)
        print(f"{name}: {len(bars)} bars at {p.bpm:g} bpm")
    import test_hear_notes as tn
    x = tn.sung(90, seed=7)
    sf.write(os.path.join(folder, "sung-a-minor.wav"), x, synth.SR, subtype="PCM_16")
    bars = []
    for b in range(tn.BARS):
        toks, t = [], 0
        for m, s, d in tn.MELODY:
            if s // 16 != b:
                continue
            if s - b * 16 > t:
                toks.append("R" + dur_suffix(Fraction(s - b * 16 - t, 4)))
            toks.append(f"{pc_name(m % 12, False)}{m // 12 - 1}{dur_suffix(Fraction(d, 4))}")
            t = s - b * 16 + d
        bars.append(toks)
    _write_label(os.path.join(folder, "sung-a-minor.notes.txt"), 90, 4, bars, "A minor", tn.th.DETUNE, {"voice": "tests/test_hear_notes.sung", "seed": 7},
                 "a sung line with vibrato")
    print(f"sung-a-minor: {tn.BARS} bars")


# --- main ----------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tools/listen-eval.py", description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", nargs="?", help="a folder of takes with <name>.chords.txt / <name>.notes.txt labels")
    ap.add_argument("--label", help="name of the run (default: the folder's name)")
    ap.add_argument("--out", help="where to write (default docs/listen/runs/<date>-<label>)")
    ap.add_argument("--auto", action="store_true", help="let the hearing decide chords or notes (as badmidi listen does) instead of using the label's kind")
    ap.add_argument("--only", help="only takes whose name contains this")
    ap.add_argument("--make-synth", metavar="FOLDER", help="write the synthetic demo takes (WAV) and labels into FOLDER and exit")
    a = ap.parse_args(argv)
    if a.make_synth:
        make_synth(a.make_synth)
        return 0
    if not a.folder:
        ap.error("give a folder of takes")
    folder = os.path.abspath(a.folder)
    takes = [t for t in find_takes(folder) if not a.only or a.only in t[0]]
    if not takes:
        print(f"no takes with labels in {folder}", file=sys.stderr)
        return 1
    label = a.label or os.path.basename(folder.rstrip("/"))
    today = datetime.date.today().isoformat()
    out = a.out or os.path.join(ROOT, "docs", "listen", "runs", f"{today}-{label}")
    results = []
    for name, audio, labfile in takes:
        try:
            r = run_take(name, audio, labfile, a.auto)
        except Exception as e:                    # one bad take must not lose the run
            print(f"{name}: FAILED {type(e).__name__}: {e}", file=sys.stderr)
            continue
        results.append(r)
        ok = f"root {pct(sum(b[3] for b in r.beats), len(r.beats))} quality {pct(sum(b[4] for b in r.beats), len(r.beats))}" if r.beats else \
            f"notes {r.notes.get('near', 0)}/{r.notes.get('n_true', 0)}" if r.notes else f"heard as {r.h.mode}"
        print(f"{name}: {ok}, key {r.h.key.name}, tuning {r.h.tuning_cents:+.1f} ({r.seconds:.1f} s)")
    os.makedirs(out, exist_ok=True)
    text = report(results, folder, label, today)
    with open(os.path.join(out, "report.md"), "w", encoding="utf-8") as f:
        f.write(text + "\n")
    cols = ["take", "bar", "label", "heard", "beats", "root_ok", "quality_ok", "family_ok", "mean_conf", "min_conf", "unsure_beats"]
    with open(os.path.join(out, "bars.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, cols)
        w.writeheader()
        for r in results:
            w.writerows(r.rows)
    print(f"\nwrote {os.path.join(out, 'report.md')} and bars.csv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
