"""Score -> readable badmidi source.

to_source(score) writes a piece file in the style of AGENTS.md's Skeleton that
rebuilds the score: the same parts, meters, tempo marks, sections,
registrations, drifts, and every note and marking, bar by bar, phrase by
phrase. It is how an imported (MIDI, MusicXML) score becomes something an
agent can read, check and revise. Spelling is kept in the tokens.

Loops that play identically in every pass are written as p.loop(); any other
loop is written out (the sounding events are the same either way).
"""
from __future__ import annotations

import builtins
import keyword
import re
from fractions import Fraction

from .core import Mark, spelling
from .score import INSTRUMENTS, Drift, Meter, Part, Score

LINE = 100          # a phrase that fits this many columns goes on one line


class _Fmt:
    """Number formatting that notices when the file needs `Fraction`."""

    def __init__(self):
        self.fraction = False

    def num(self, x) -> str:
        x = Fraction(x)
        if x.denominator == 1:
            return str(x.numerator)
        self.fraction = True
        return f"Fraction({x.numerator}, {x.denominator})"

    def where(self, score: Score, t: Fraction) -> str:
        """A bar, or (bar, beat), for an absolute time."""
        bar, beat = score.position(t)
        return str(bar) if beat == 1 else f"({bar}, {self.num(beat)})"


def _bpm(x) -> str:
    """A metronome mark: 72, or 72.5."""
    return str(int(x)) if x == int(x) else repr(float(x))


def _lit(s: str) -> str:
    return repr(s) if '"' in s or "\\" in s else f'"{s}"'


def _doc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"""', '\\"\\"\\"')


def _spec(p: Part) -> tuple:
    return (p.name, p.instrument, p.program, (p.range[0].midi, p.range[1].midi), p.group, p.staff,
            p.clef, p.brace, p.balance, tuple(p.couplers), p.channel, p.pan)


def _kwargs(p: Part) -> list[str]:
    """Constructor keywords for what differs from what Part would choose."""
    prog, lo, hi = INSTRUMENTS[p.instrument]
    out = []
    if p.program != prog:
        out.append(f"program={p.program}")
    if (p.range[0].midi, p.range[1].midi) != (lo, hi):
        out.append(f"range=({_lit(str(p.range[0]))}, {_lit(str(p.range[1]))})")
    if p.group is not None:
        out.append(f"group={_lit(p.group)}")
    if p.staff != p.name:
        out.append(f"staff={_lit(p.staff)}")
    if p.clef is not None:
        out.append(f"clef={_lit(p.clef)}")
    if not p.brace:
        out.append("brace=False")
    if p.balance:
        out.append(f"balance={p.balance}")
    if tuple(p.couplers) != (0,):
        out.append(f"couplers={tuple(p.couplers)!r}")
    if p.channel != p.name:
        out.append(f"channel={_lit(p.channel)}")
    if p.pan is not None:
        out.append(f"pan={p.pan}")
    return out


def _identifiers(parts: list[Part]) -> dict[str, str]:
    import badmidi
    taken = set(badmidi.__all__) | set(keyword.kwlist) | set(dir(builtins)) | {"score", "Fraction"}
    out: dict[str, str] = {}
    for p in parts:
        base = re.sub(r"\W+", "_", p.name.strip().lower()).strip("_") or "part"
        if base[0].isdigit():
            base = "p_" + base
        name, k = base, 1
        while name in taken:
            k += 1
            name = f"{base}_{k}"
        taken.add(name)
        out[p.name] = name
    return out


def _declarations(score: Score, ids: dict[str, str]) -> list[str]:
    """score.piano() / score.organ() where the parts are exactly what they
    make, otherwise one score.part(...) per part."""
    lines, parts, i = [], score.parts, 0
    while i < len(parts):
        for maker, n in (("piano", 2), ("organ", 3)):
            grp = parts[i:i + n]
            if len(grp) < n:
                continue
            gname = grp[0].group or maker.capitalize()
            scratch = Score()
            made = getattr(scratch, maker)(*[p.name for p in grp], name=gname)
            if all(_spec(a) == _spec(b) for a, b in zip(grp, made)):
                args = []
                default = getattr(Score(), maker)()
                for kw, p, d in zip(("upper", "lower", "pedal"), grp, default):
                    if p.name != d.name:
                        args.append(f"{kw}={_lit(p.name)}")
                if gname != default[0].group:
                    args.append(f"name={_lit(gname)}")
                lines.append(f"{', '.join(ids[p.name] for p in grp)} = score.{maker}({', '.join(args)})")
                i += n
                break
        else:
            p = parts[i]
            args = [_lit(p.name)]
            if p.instrument != (p.name if p.name in INSTRUMENTS else "piano"):
                args.append(_lit(p.instrument))
            args += _kwargs(p)
            lines.append(f"{ids[p.name]} = score.part({', '.join(args)})")
            i += 1
    return lines


def _meter(m: Meter) -> str:
    return _lit(m.text) if Meter.parse(m.text) == m else f"Meter({m.num}, {m.den}, groups={_lit(m.groups)})"


def _score_calls(score: Score, f: _Fmt) -> list[str]:
    lines = []
    for bar, m in sorted(score._meters.items()):
        if bar > 1:
            lines.append(f"score.meter_change({bar}, {_meter(m)})")
    for bar, m in sorted(score._free.items()):
        lines.append(f"score.free_bar({bar}, {f.num(m.free)})")
    marks = score.tempo_marks
    tempo = []
    prev = marks[0].bpm if marks and marks[0].bpm is not None else score.tempo
    for tm in marks[1:]:
        at = f.where(score, tm.start)
        if tm.gradual:
            fast = tm.bpm is not None and tm.bpm > prev
            call, default = ("accel", "accel.") if fast else ("rit", "rit.")
            args = [at, f.where(score, tm.end), f"to={_bpm(tm.bpm)}"]
            if tm.text != default:
                args.append(f"text={_lit(tm.text)}")
            tempo.append(f"score.{call}({', '.join(args)})")
        else:
            args = [at] + ([_lit(tm.text)] if tm.text is not None else [])
            if tm.bpm is not None:
                args.append(_bpm(tm.bpm) if tm.text is not None else f"bpm={_bpm(tm.bpm)}")
            tempo.append(f"score.tempo_mark({', '.join(args)})")
        if tm.bpm is not None:
            prev = tm.bpm
    if lines and tempo:
        lines.append("")
    lines += tempo
    if score.sections and lines:
        lines.append("")
    for s in score.sections:
        lines.append(f"score.section({s.bar}, {_lit(s.label)}" + (f", {_lit(s.description)})" if s.description else ")"))
    return lines


def _part_calls(score: Score, p: Part, var: str, f: _Fmt) -> list[str]:
    lines = []
    for t, text, program in p.registrations:
        bar, beat = score.position(t)
        args = [str(bar), _lit(text)] + ([str(program)] if program is not None else [])
        if beat != 1:
            args.append(f"beat={f.num(beat)}")
        lines.append(f"{var}.registration({', '.join(args)})")
    for d in p.drifts:
        args = [f.where(score, d.start), f.where(score, d.end), f"ahead={f.num(d.ahead)}"]
        if d.text != Drift(d.start, d.end, d.ahead).text:
            args.append(f"text={_lit(d.text)}")
        lines.append(f"{var}.drift({', '.join(args)})")
    return lines


def _plain_loops(score: Score, p: Part, cells: list[list[str]]) -> list[tuple[int, int, int]]:
    """(first bar, bars per pass, passes) for the loops of p that are exactly
    repeats of their first pass, whole bars, in one meter; non-overlapping."""
    out: list[tuple[int, int, int]] = []
    for lp in sorted((l for l in score.loops if l.part is p), key=lambda l: l.start):
        if not (score.is_barline(lp.start) and score.is_barline(lp.start + lp.body)):
            continue
        b0 = score.position(lp.start)[0]
        k = score.position(lp.start + lp.body)[0] - b0
        if k < 1 or b0 + k * lp.times - 1 > len(cells) or (out and b0 < out[-1][0] + out[-1][1] * out[-1][2]):
            continue
        same = all(cells[b0 - 1 + j * k + i] == cells[b0 - 1 + i] and
                   score.meter_at(b0 + j * k + i) == score.meter_at(b0 + i)
                   for j in range(lp.times) for i in range(k))
        if same:
            out.append((b0, k, lp.times))
    return out


def _wrap(head: str, args: list[str], tail: str) -> list[str]:
    ind = " " * len(head)
    lines = [head + args[0] + ("," if len(args) > 1 else "")]
    lines += [ind + a + "," for a in args[1:-1]]
    if len(args) > 1:
        lines.append(ind + args[-1] + (tail or ""))
    else:
        lines[0] += tail
    lines[-1] += ")"
    return lines


def _music(score: Score, p: Part, var: str, cells: list[list[str]], phrase: int) -> list[str]:
    nbars = len(cells)
    loops = {b0: (k, n) for b0, k, n in _plain_loops(score, p, cells)}
    out: list[str] = []
    b = 1
    while b <= nbars:
        if b in loops:
            k, n = loops[b]
            out += _wrap(f"{var}.loop({b}, ", [_lit(f"{' '.join(cells[b - 1 + i])} |") for i in range(k)],
                         f", times={n}")
            b += k * n
            continue
        end = min(((b - 1) // phrase + 1) * phrase + 1, nbars + 1, *(x for x in loops if x > b))
        chunk = cells[b - 1:end - 1]
        if any(tok[0] != "R" for bar in chunk for tok in bar):
            texts = [" ".join(bar) for bar in chunk]
            one = " ".join(f"{t} |" for t in texts) + str(end)
            head = f"{var}.at({b}, "
            if len(head) + len(one) + 3 <= LINE and '"' not in one and "\\" not in one:
                out.append(f'{head}"{one}")')
            else:
                w = max(map(len, texts))
                w = w if w <= 60 else 0
                args = [_lit(f"{t.ljust(w)} |" + (str(end) if i == len(texts) - 1 else ""))
                        for i, t in enumerate(texts)]
                out += _wrap(head, args, "")
        b = end
    return out


def to_source(score: Score, report=None, phrase: int = 4) -> str:
    """Python source of a piece file that rebuilds `score`: a docstring with a
    bar map to fill in (and `report`, any object with a str(), e.g. an import
    report), the Score and its parts, then each part's music in phrases of
    `phrase` bars, every phrase at an explicit bar and closed with a bar
    anchor, so `check` keeps catching miscounts as the piece is edited."""
    from .views import _bar_cells
    f = _Fmt()
    ids = _identifiers(score.parts)
    first = score.meter_at(1)
    doc = [f"{score.title or 'Untitled'}.", ""]
    if report is not None:
        doc += ["Imported. What the importer reported:", ""]
        doc += [("    " + ln).rstrip() for ln in str(report).strip().splitlines()]
        doc.append("")
    ends = [s.bar for s in score.sections[1:]] + [score.bars + 1]
    if score.sections:
        doc += [f"    {s.bar}-{e - 1}".ljust(11) + f"{s.label}" + (f": {s.description}" if s.description else "")
                for s, e in zip(score.sections, ends)]
    else:
        doc.append(f"    1-{score.bars}".ljust(11) + "(fill in what happens in these bars)")

    args = [_lit(score.title), f"meter={_meter(first)}", f"key={_lit(score.key.name)}", f"tempo={_bpm(score.tempo)}"]
    if score.tempo_marks and score.tempo_marks[0].text:
        args.append(f"tempo_text={_lit(score.tempo_marks[0].text)}")
    if score.composer:
        args.append(f"composer={_lit(score.composer)}")
    one = "score = Score(" + ", ".join(args) + ")"
    body = [one] if len(one) <= LINE else ["score = Score(" + ",\n              ".join(args) + ")"]
    body += _declarations(score, ids)
    calls = _score_calls(score, f)
    if calls:
        body += ["", "# --- meter, tempo, form ---------------------------------------------------", *calls]

    music: list[str] = []
    with spelling(score.key):
        for p in score.ordered_parts():
            cells = _bar_cells(score, p, score.bars)
            lines = _part_calls(score, p, ids[p.name], f) + _music(score, p, ids[p.name], cells, phrase)
            if lines:
                music += ["", f"# --- {p.name} " + "-" * max(4, 66 - len(p.name)), *lines]
    if any(lp for lp in score.loops):
        music.insert(0, "# loops that repeat exactly are p.loop(); any other is written out bar by bar")
    head = ["from badmidi import *"] + (["from fractions import Fraction"] if f.fraction else [])
    return f'"""{_doc(chr(10).join(doc))}\n"""\n' + "\n".join(head + ["", *body, "", *music]).rstrip() + "\n"


def write_source(score: Score, path: str, report=None, phrase: int = 4) -> None:
    text = to_source(score, report, phrase)
    with open(path, "w") as fh:
        fh.write(text)
