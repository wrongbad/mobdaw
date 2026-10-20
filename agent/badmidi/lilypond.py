"""Engraving: export a score as LilyPond source, and render it to PDF/PNG.

Notes are split at barlines (and into printable values) with ties, exactly
as in the melody view. Markings go where a printed score puts them:
dynamics, hairpins and expression text on a Dynamics line under the staff
(between the hands for piano), pedal under the bottom staff, tempo marks
and rit./accel. spanners above the top staff.
"""
from __future__ import annotations

import bisect
import os
import shutil
import subprocess
from fractions import Fraction

from .core import Mark, Note, derived_tuplet, fmt_number, octave_of, pc_name, spelling, tuplet_space
from .loops import Plan, plan_loops
from .midi import read_notes
from .score import Part, Score

PLAIN = {Fraction(4, 2 ** k): str(2 ** k) for k in range(6)}          # 4 -> "1" ... 1/8 -> "32"
DOTTED = {d * Fraction(3, 2): s + "." for d, s in PLAIN.items()}
NORMAL = dict(sorted({**PLAIN, **DOTTED}.items(), reverse=True))
ARTICULATION = {">": "->", "^": "-^", "'": "-.", "_": "--", "@": "\\fermata"}
MODES = {"major": "major", "minor": "minor", "harmonic minor": "minor", "melodic minor": "minor",
         "dorian": "dorian", "phrygian": "phrygian", "lydian": "lydian",
         "mixolydian": "mixolydian", "locrian": "locrian"}


# --- small pieces ------------------------------------------------------------


def _pitch(p) -> str:
    name = p.spell or pc_name(p.pc)
    acc = "s" * name.count("#") + "f" * name.count("b")
    octave = octave_of(p.midi, name)
    return name[0].lower() + acc + ("'" * (octave - 3) if octave > 3 else "," * (3 - octave))


def _whole(d: Fraction) -> str:
    """A spacer/rest length in LilyPond's multiplier syntax: 1*3/4 etc."""
    w = d / 4
    return "1" if w == 1 else f"1*{w.numerator}/{w.denominator}"


def _tuplet(d: Fraction) -> tuple[int, int] | None:
    """(n, space) of the tuplet a length belongs to: the odd part of its
    denominator, in the time of the power of two below it. 1/3 -> (3, 2),
    2/5 -> (5, 4), 1/7 -> (7, 4); None for plain and dotted values."""
    q = d.denominator
    while q % 2 == 0:
        q //= 2
    return None if q == 1 else (q, tuplet_space(q))


def _pieces(d: Fraction, tup: tuple[int, int] | None):
    """d broken into printable values under one tuplet ratio, or None if it
    can't be written (a ratio-free fallback is handled by the caller)."""
    scale = Fraction(tup[0], tup[1]) if tup else Fraction(1)
    written, out = d * scale, []
    while written > 0:
        for v, s in NORMAL.items():
            if v <= written:
                out.append((v / scale, s, tup))
                written -= v
                break
        else:
            return None
    return out


def _split(d: Fraction, written_as=None) -> list[tuple[Fraction, str, tuple[int, int] | None]]:
    """Break a length into printable values: (length, lily duration, tuplet).
    Inside a tuplet the written values are the sounding ones scaled by n/space.
    The ratio is the note's own (written_as, 5:3 for .q5:3) when it fits the
    length; otherwise whichever of the odd-denominator ratio (3:2, 5:4) and the
    ratio the length is spelled with (12:11 for 11/48) needs fewer tied pieces."""
    candidates = []
    if written_as and d * Fraction(*written_as) in NORMAL:
        candidates.append(tuple(written_as))
    candidates += [_tuplet(d), derived_tuplet(d)]
    best = None
    for tup in candidates:
        pieces = _pieces(d, tup)
        if pieces is not None and (best is None or len(pieces) < len(best)):
            best = pieces
    return best or [(d, f"4*{d.numerator}/{d.denominator}", None)]


def _clef(parts: list[Part]) -> str:
    if parts[0].clef:
        return parts[0].clef
    if parts[0].instrument in ("tenor", "guitar"):
        return '"treble_8"'
    ps = sorted(p.midi for part in parts for _, n in part.events() for p in n.pitches)
    return "bass" if ps and ps[len(ps) // 2] < 57 else "treble"


# --- note voices ---------------------------------------------------------------


# Ottava rule: a bar that sits this far off the staff gets an 8va/8vb sign
# rather than a ladder of ledger lines. (clef, lowest, highest, shift)
OTTAVA = {"treble": lambda lo, hi: 1 if lo >= 76 and hi >= 88 else 0,     # all above E5, reaching E6
          "bass": lambda lo, hi: -1 if hi <= 48 and lo <= 33 else 0}      # all below C3, reaching A1


def _ottavas(score: Score, part: Part, nbars: int, clef: str) -> list[int]:
    rule = OTTAVA.get(clef)
    shifts = [0] * nbars
    if rule is None:
        return shifts
    starts = score.barlines(nbars)
    ranges: list[list[int]] = [[] for _ in range(nbars)]
    for t, n in part.events(merge_ties=False):
        first = bisect.bisect_right(starts, t) - 1
        last = bisect.bisect_left(starts, t + n.dur) - 1
        for b in range(first, min(nbars, last + 1)):
            ranges[b].extend(p.midi for p in n.pitches)
    return [rule(min(r), max(r)) if r else 0 for r in ranges]


def _voice(score: Score, part: Part, nbars: int, primary: bool, clef: str | None = None,
           plan: Plan | None = None) -> str:
    """One voice as LilyPond music, with a bar check after every bar.
    Gaps print as rests in a staff's first voice and as invisible spacers in
    the others. With a clef, bars far off the staff get an ottava sign."""
    starts = score.barlines(nbars)
    total = starts[-1]
    timeline: list[tuple[Fraction, Fraction, Note | None]] = []
    cur = Fraction(0)
    for t, n in part.events(merge_ties=False):
        if t > cur:
            timeline.append((cur, t - cur, None))
        timeline.append((t, n.dur, n))
        cur = max(cur, t + n.dur)
    if cur < total:
        timeline.append((cur, total - cur, None))

    bars: list[list[tuple[str, tuple | None]]] = [[] for _ in range(nbars)]   # (token, (tuplet, length))
    for start, dur, note in timeline:
        s, left = start, dur
        while left > 0:
            b = bisect.bisect_right(starts, s) - 1
            if b >= nbars:
                break
            seg = min(left, starts[b + 1] - s)
            if note is None and seg == starts[b + 1] - starts[b]:
                bars[b].append((("R" if primary else "s") + _whole(seg), False))
            else:
                pieces = _split(seg, note.tuplet if note is not None else None)
                for i, (v, ly, tup) in enumerate(pieces):
                    first = s == start and i == 0
                    last = seg == left and i == len(pieces) - 1
                    if note is None:
                        tok = ("r" if primary else "s") + ly
                    elif note.is_rest:
                        tok = "r" + ly + (ARTICULATION["@"] if "@" in note.art and last else "")
                    else:
                        head = _pitch(note.pitches[0]) if len(note.pitches) == 1 \
                            else "<" + " ".join(_pitch(p) for p in note.pitches) + ">"
                        tie = "~" if (not last or note.tied) else ""
                        arts = "".join(ARTICULATION[c] for c in note.art
                                       if (c == "@" and last) or (c != "@" and first))
                        tok = head + ly + tie + arts
                    bars[b].append((tok, (tup, v) if tup else None))
            s += seg
            left -= seg

    shifts = _ottavas(score, part, nbars, clef) if clef else [0] * nbars
    rests = []
    for bar in bars:
        words, run = [], []
        held, kind = Fraction(0), None
        first_len = None

        def close():
            nonlocal run, held, first_len
            if run:
                words.append(f"\\tuplet {kind[0]}/{kind[1]} {{ " + " ".join(run) + " }")
            run, held, first_len = [], Fraction(0), None
        for tok, tup in bar + [("", None)]:
            if tup and tup[0] == kind:
                run.append(tok)
            elif tup:
                close()
                kind, run = tup[0], [tok]
            else:
                close()
                kind = None
                if tok:
                    words.append(tok)
                continue
            # one bracket per beat's worth (or per n equal notes), not one across a whole run
            written = tup[1] * Fraction(kind[0], kind[1])
            first_len = written if first_len is None else first_len
            held += tup[1]
            if held.denominator == 1 or (written_total(held, kind) == first_len * kind[0]
                                         and written_total(held, kind) in NORMAL):
                close()
        rests.append(" ".join(words))

    # Assemble bar by bar, carrying the ottava state. A repeated stretch must
    # hand the next pass the state it started with.
    pieces, state = [], 0
    for t0, t1, sp in (plan.segments(total) if plan else [(Fraction(0), total, None)]):
        b0, b1 = score.position(t0)[0] - 1, score.position(t1)[0] - 1
        chunk = []
        for b in range(b0, b1):
            word = f"\\ottava #{shifts[b]} " if shifts[b] != state else ""
            state = shifts[b]
            chunk.append(word + rests[b] + " |")
        if sp is not None:
            if shifts[b1 - 1] != shifts[b0]:
                chunk[-1] = chunk[-1][:-1] + f"\\ottava #{shifts[b0]} |"
                state = shifts[b0]
            chunk = [f"\\repeat volta {sp.times} {{"] + ["  " + c for c in chunk] + ["}"]
        pieces.extend(chunk)
    return "\n    ".join(pieces)


def written_total(held: Fraction, kind: tuple[int, int]) -> Fraction:
    return held * Fraction(kind[0], kind[1])


# --- marking lines -------------------------------------------------------------


def _spacers(segments: list[tuple[Fraction, Fraction, str]]) -> str:
    """segments: (start, length, attachments) -> spacer rests with attachments."""
    return " ".join(f"s{_whole(d)}{att}" for _, d, att in segments if d > 0)


def _mark_line(times_marks: list[tuple[Fraction, str]], total: Fraction, clamp: bool = True) -> str:
    """Spacer music carrying attachments at the given times. Attachments at
    the very end go on a short final spacer."""
    tail = Fraction(1, 8)
    at: dict[Fraction, str] = {}
    for t, ly in times_marks:
        t = min(t, total - tail) if clamp else t
        at[t] = at.get(t, "") + ly
    cuts = sorted(set(at) | {Fraction(0), total})
    return _spacers([(a, b - a, at.get(a, "")) for a, b in zip(cuts, cuts[1:])])


def _cut(plan: Plan, items: list[tuple[Fraction, str]], total: Fraction, render, extra=()) -> str:
    """A line of spacer music for the whole score, built stretch by stretch
    so that a repeated stretch is written once: render(items, length, final)
    makes the music of one stretch from its (time within it, attachment)
    items. A line's items at the very end belong to the last stretch."""
    segs = plan.segments(total)
    out = []
    for i, (t0, t1, sp) in enumerate(segs):
        final = i == len(segs) - 1
        sel = [(t - t0, ly) for t, ly in items if t0 <= t < t1 or (final and t >= total)]
        sel += [(t - t0, ly) for t, ly in extra if t0 <= t < t1]
        if sp is not None:
            sel = [(min(t, t1 - t0), ly) for t, ly in sel]
        music = render(sel, t1 - t0, final)
        out.append(f"\\repeat volta {sp.times} {{ {music} }}" if sp else music)
    return " ".join(out)


def _dynamics_line(parts: list[Part], total: Fraction, defs: list[str], plan: Plan) -> str | None:
    seen, items = set(), []
    for p in parts:
        for t, m in p.marks(Mark):
            if m.kind in ("dyn", "cresc", "dim", "end", "text") and (t, m) not in seen:
                seen.add((t, m))
                items.append((t, m))
    if not items:
        return None
    ly = {"cresc": "\\<", "dim": "\\>", "end": "\\!"}
    by_time: dict[Fraction, list[Mark]] = {}
    for t, m in sorted(items, key=lambda x: x[0]):
        by_time.setdefault(t, []).append(m)
    out = []
    for t, ms in by_time.items():
        dyns = [m for m in ms if m.kind == "dyn"]
        texts = [m.value for m in ms if m.kind == "text"]
        if len(dyns) == 1 and texts:          # "p dolce" side by side, as one dynamic
            name = f"dynText{_letters(len(defs))}"
            words = " ".join(f'#:normal-text #:italic "{_esc(x)}"' for x in texts)
            defs.append(f'{name} = #(make-dynamic-script (markup #:dynamic "{dyns[0].value}" {words}))')
            out.append((t, "\\" + name))
            ms = [m for m in ms if m.kind not in ("dyn", "text")]
        for m in ms:
            if m.kind == "dyn":
                out.append((t, "\\" + m.value))
            elif m.kind == "text":
                out.append((t, f'-\\markup {{ \\italic "{_esc(m.value)}" }}'))
            else:
                out.append((t, ly[m.kind]))
    return _cut(plan, out, total, _mark_line)


def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


def _letters(n: int) -> str:
    """0 -> 'A', 25 -> 'Z', 26 -> 'BA': LilyPond names can't contain digits."""
    out = ""
    while True:
        out = chr(65 + n % 26) + out
        n //= 26
        if not n:
            return out


def _pedal_line(parts: list[Part], total: Fraction, plan: Plan) -> str | None:
    seen, items = set(), []
    for p in parts:
        for t, m in p.marks(Mark):
            if m.kind in ("ped", "pedup") and (t, m) not in seen:
                seen.add((t, m))
                items.append((t, m))
    if not items:
        return None
    out, down = [], False
    for t, m in sorted(items, key=lambda x: x[0]):
        if m.kind == "ped":
            out.append((t, "\\sustainOff\\sustainOn" if down else "\\sustainOn"))
            down = True
        elif down:
            out.append((t, "\\sustainOff"))
            down = False
    if down:
        out.append((total, "\\sustainOff"))
    return _cut(plan, out, total, _mark_line)


def _render_around(items, length, final):
    """Spacer music for one stretch where \\tempo, \\mark and \\override come
    before a spacer and \\startTextSpan and markup after it."""
    tail = Fraction(1, 8)
    before: dict[Fraction, str] = {}
    after: dict[Fraction, str] = {}
    for t, ly in items:
        t = min(t, length - tail) if t >= length else t
        d = after if ly.startswith(("\\st", "^")) else before
        d[t] = d.get(t, "") + ly
    cuts = sorted(set(before) | set(after) | {Fraction(0), length})
    return " ".join(f"{before.get(a, '')}s{_whole(b - a)}{after.get(a, '')}" for a, b in zip(cuts, cuts[1:]))


def _drift_line(members: list[Part], total: Fraction, plan: Plan) -> str | None:
    """A dashed text spanner over each drift of the staff's parts."""
    items = []
    for p in members:
        for d in p.drifts:
            items.append((d.start, "\\once \\override TextSpanner.bound-details.left.text = "
                                   f'\\markup {{ \\italic "{_esc(d.text)}" }} '))
            items.append((d.start, "\\startTextSpan"))
            items.append((d.end, "\\stopTextSpan"))
    return _cut(plan, items, total, _render_around) if items else None


def _tempo_line(score: Score, total: Fraction, plan: Plan) -> str:
    """The top staff's spacer line: tempo marks, rit. spans, rehearsal marks
    (sections), and the x8 over each repeat with the bar number that follows it."""
    items = []
    for m in score.tempo_marks:
        if m.gradual:
            items.append((m.start, "\\once \\override TextSpanner.bound-details.left.text = "
                                   f'\\markup {{ \\italic "{m.text}" }} '))
            items.append((m.start, "\\startTextSpan"))
            items.append((m.end, "\\stopTextSpan"))
        elif m.text or m.bpm:
            txt = f'"{m.text}" ' if m.text else ""
            bpm = f"4 = {round(m.bpm)}" if m.bpm else ""
            items.append((m.start, f"\\tempo {txt}{bpm} "))
    for sec in score.sections:
        t = score.bar_start(sec.bar)
        items.append((t, f'\\mark \\markup {{ \\box "{_esc(sec.label)}" }} '))
        if sec.description:
            items.append((t, f'^\\markup {{ \\small \\italic "{_esc(sec.description)}" }}'))
    for sp in plan.spans:
        items.append((sp.start, f'^\\markup {{ \\bold "\u00d7{sp.times}" }}'))
        if sp.end < total:
            items.append((sp.end, f"\\set Score.currentBarNumber = #{sp.after} "))
    return _cut(plan, items, total, _render_around)


# --- the whole score -----------------------------------------------------------


def _global_time(score: Score, nbars: int, plan: Plan) -> str:
    """Time signatures and the bars' lengths as spacers. A free bar is an
    irregular measure with no time signature, breakable at every beat.
    A repeated stretch is written once."""
    starts = score.barlines(nbars)
    pieces: list[str] = []
    prev = None
    for t0, t1, sp in plan.segments(starts[-1]):
        out: list[str] = []
        run = Fraction(0)          # length of metered bars not yet written
        for b in range(score.position(t0)[0], score.position(t1)[0]):
            m = score.meter_at(b)
            if m.free is None and m == prev:
                run += starts[b] - starts[b - 1]
                continue
            if run:
                out.append(f"s{_whole(run)}")
                run = Fraction(0)
            if m.free is None:
                if m.explicit:     # printed as 2+2+3 over 8, beamed in those groups
                    out.append(f"\\compoundMeter #'(({' '.join(map(str, m.groups))} {m.den}))")
                else:
                    out.append(f"\\time {m.num}/{m.den}")
                run = starts[b] - starts[b - 1]
            else:
                if b == 1:
                    out.append("\\once \\omit Staff.TimeSignature")
                w = m.free / 4
                out.append(f"\\set Timing.measureLength = #(ly:make-moment {w.numerator}/{w.denominator})")
                beats, rest = int(m.free), m.free - int(m.free)
                out.append(" \\bar \"\" ".join(["s4"] * beats + ([f"s{_whole(rest)}"] if rest else [])))
            prev = m
        if run:
            out.append(f"s{_whole(run)}")
        text = " ".join(out)
        pieces.append(f"\\repeat volta {sp.times} {{ {text} }}" if sp else text)
    return " ".join(pieces)


def lilypond(score: Score) -> str:
    nbars = score.bars
    total = score.barlines(nbars)[-1]
    k = score.key
    plan = plan_loops(score)
    with spelling(k):
        tonic = _pitch_name_only(k.tonic_name)
        glob = f"\\key {tonic} \\{MODES[k.mode]} {_global_time(score, nbars, plan)} \\bar \"|.\""

        # staves in score order; each staff = parts sharing .staff
        staves: list[tuple[str, list[Part]]] = []
        for p in score.parts:
            for name, members in staves:
                if name == p.staff:
                    members.append(p)
                    break
            else:
                staves.append((p.staff, [p]))

        def staff_ly(name: str, members: list[Part], top: bool) -> str:
            m0 = members[0]
            title = "Ped." if m0.instrument == "pedal" else name.title()
            label = f'\\with {{ instrumentName = "{title}" }} ' if not (m0.group and m0.brace) else ""
            lines = [f'\\new Staff = "{name}" {label}<<', "  \\global", f"  \\clef {_clef(members)}"]
            if top:
                lines.append("  { " + _tempo_line(score, total, plan) + " }")
            texts: dict[Fraction, list[str]] = {}
            for m in members:                       # one label per moment, duplicates merged
                for t, text, _ in m.registrations:
                    if text not in texts.setdefault(t, []):
                        texts[t].append(text)
            regs = [(t, f'^\\markup {{ \\small \\italic "{_esc(" / ".join(ts))}" }}')
                    for t, ts in sorted(texts.items())]
            if regs:
                lines.append("  { " + _cut(plan, regs, total, _mark_line) + " }")
            drift = _drift_line(members, total, plan)
            if drift:
                lines.append("  { " + drift + " }")
            if len(members) == 1:   # ottava signs only where one voice owns the staff
                lines.append("  {\n    " + _voice(score, members[0], nbars, True, _clef(members), plan) + "\n  }")
            else:
                for i, m in enumerate(members):
                    vo = ["\\voiceOne", "\\voiceTwo", "\\voiceThree", "\\voiceFour"][min(i, 3)]
                    lines.append(f'  \\new Voice = "{m.name}" {{ {vo}\n    '
                                 + _voice(score, m, nbars, i == 0, None, plan) + "\n  }")
            lines.append(">>")
            return "\n".join(lines)

        defs: list[str] = []
        body: list[str] = []
        done_groups: set[str] = set()
        for i, (name, members) in enumerate(staves):
            group = members[0].group
            if group is None:
                body.append(staff_ly(name, members, i == 0))
                dyn = _dynamics_line(members, total, defs, plan)
                ped = _pedal_line(members, total, plan)
                for line in (dyn, ped):
                    if line:
                        body.append("\\new Dynamics { " + line + " }")
                continue
            if group in done_groups:
                continue
            done_groups.add(group)
            gstaves = [(n, ms) for n, ms in staves if ms[0].group == group]
            gparts = [p for _, ms in gstaves for p in ms]
            braced = [(n, ms) for n, ms in gstaves if ms[0].brace]
            loose = [(n, ms) for n, ms in gstaves if not ms[0].brace]   # e.g. organ pedal
            inner = []
            for j, (n, ms) in enumerate(braced):
                inner.append(staff_ly(n, ms, i == 0 and j == 0))
                if j == 0:
                    dyn = _dynamics_line(gparts, total, defs, plan)
                    if dyn:
                        inner.append("\\new Dynamics { " + dyn + " }")
            ped = _pedal_line(gparts, total, plan)
            if ped:
                inner.append("\\new Dynamics \\with { pedalSustainStyle = #'mixed } { " + ped + " }")
            body.append(f'\\new PianoStaff \\with {{ instrumentName = "{group}" }} <<\n'
                        + _indent("\n".join(inner)) + "\n>>")
            body.extend(staff_ly(n, ms, False) for n, ms in loose)

    header = [f'  title = "{score.title}"'] if score.title else []
    if score.composer:
        header.append(f'  composer = "{score.composer}"')
    header.append("  tagline = ##f")
    layout = "  \\layout { }\n  \\midi { }\n"
    if plan.spans:     # play the repeats out for the MIDI the engraving is verified against
        score_blocks = ["music = <<", _indent(_indent("\n".join(body))), ">>",
                        "\\score {", "  \\music", "  \\layout { }", "}",
                        "\\score {", "  \\unfoldRepeats \\music", "  \\midi { }", "}", ""]
    else:
        score_blocks = ["\\score {", "  <<", _indent(_indent("\n".join(body))), "  >>", layout.rstrip("\n"), "}", ""]
    return "\n".join([
        '\\version "2.24.0"',
        '\\language "english"',
        "\\header {", *header, "}",
        *defs,
        "global = { " + glob + " }",
        *score_blocks,
    ])


def _pitch_name_only(name: str) -> str:
    return name[0].lower() + "s" * name.count("#") + "f" * name.count("b")


def _indent(text: str) -> str:
    return "\n".join("  " + line if line else line for line in text.splitlines())


class EngraveError(RuntimeError):
    pass


def score_notes(score: Score) -> list[tuple[Fraction, int, Fraction]]:
    """Every sounding (onset, pitch, duration) in the score as written (ties
    merged; no couplers, staccato or other performance changes)."""
    return sorted((t, p.midi, n.dur) for part in score.parts for t, n in part.events()
                  if not n.is_rest for p in n.pitches)


def verify(score: Score, engraved_midi: bytes) -> list[str]:
    """Compare the notes LilyPond engraved (via the MIDI it writes from the
    same source) with the score. Returns the differences, empty if identical."""
    from collections import Counter
    from .core import Pitch
    from .views import fmt_pos
    # LilyPond's MIDI plays staccato notes short, so those match on onset and pitch only
    short = {(t, p.midi) for part in score.parts for t, n in part.events() if "'" in n.art for p in n.pitches}

    # LilyPond writes ticks rounded down at its own resolution, so tuplets
    # that resolution can't hold (quintuplets at 384 per quarter) are compared there
    ppq = int.from_bytes(engraved_midi[12:14], "big")

    def key(t, m, d):
        tick, length = int(t * ppq), int(d * ppq)
        return (tick, m, None) if (t, m) in short else (tick, m, length)
    want = Counter(key(*n) for n in score_notes(score))
    got = Counter(key(*n) for n in read_notes(engraved_midi))
    problems = []
    for label, diff in (("missing from the engraving", want - got), ("extra in the engraving", got - want)):
        for (tick, m, ticks), n in sorted(diff.items(), key=lambda x: (x[0][0], x[0][1])):
            t = Fraction(tick, ppq)
            length = "staccato" if ticks is None else f"{fmt_number(Fraction(ticks, ppq))} quarters"
            problems.append(f"{label}: {Pitch(m)} at {fmt_pos(score, t)}, {length}" + (f" (x{n})" if n > 1 else ""))
    return problems


def engrave(score: Score, path: str, fmt: str = "pdf", strict: bool = True, keep_ly: bool = False) -> str:
    """Render the score with LilyPond to pdf or png at `path`.

    Then prove the engraving: LilyPond also writes MIDI from the same source,
    and every note in it must match the score exactly (pitch, onset, length).
    With strict, any LilyPond warning is an error too. The LilyPond source
    (<stem>.ly) is left next to the output only if something went wrong, or
    with keep_ly. Returns LilyPond's log."""
    exe = shutil.which("lilypond")
    if not exe:
        raise FileNotFoundError("lilypond not found (brew install lilypond)")
    stem = os.path.splitext(path)[0]
    with open(stem + ".ly", "w", encoding="utf-8") as f:
        f.write(lilypond(score))
    args = [exe, "-s", "-o", stem]
    args += ["--png", "-dresolution=110"] if fmt == "png" else ["--pdf"]
    r = subprocess.run(args + [stem + ".ly"], capture_output=True, text=True)
    if os.path.exists(stem + ".midi") and r.returncode != 0:
        os.remove(stem + ".midi")
    if r.returncode != 0:
        raise EngraveError(f"lilypond failed:\n{r.stderr}")
    warnings = [line for line in r.stderr.splitlines() if "warning:" in line or "error:" in line]
    if strict and warnings:
        raise EngraveError("lilypond warnings (see " + stem + ".ly):\n" + "\n".join(warnings))
    midi_path = stem + ".midi"
    with open(midi_path, "rb") as f:
        problems = verify(score, f.read())
    os.remove(midi_path)
    if problems:
        raise EngraveError(f"the engraving does not match the score ({len(problems)} differences; "
                           f"see {stem}.ly):\n" + "\n".join(problems[:20]))
    if not keep_ly:
        os.remove(stem + ".ly")
    return r.stderr
