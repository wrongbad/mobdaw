"""Text views of a score.

melody(): melody-major. Each part is a horizontal line, bars in aligned columns.
          Each row is valid string notation: paste it into M("...") or part.at().
grid():   harmony-major. Time runs down, parts run across, one row per onset,
          with the sounding chord, its roman numeral and its set class.
check():  is the score what you meant to write: bar counts, overlaps, ranges.
lens():   what the voices are doing: dissonances named by how they move,
          parallels, crossings. Descriptive, not prescriptive.
"""
from __future__ import annotations

import bisect
from fractions import Fraction

from .core import DURATIONS, Bar, Mark, Note, dur_suffix, fmt_number, pc_name, spelling
from .score import Part, Score, ahead_name

# --- formatting --------------------------------------------------------------


def fmt_beat(beat: Fraction) -> str:
    """3 -> '3', 5/2 -> '2.5', 7/3 -> '2+1/3'."""
    if beat.denominator == 1 or beat.denominator & (beat.denominator - 1) == 0:
        return fmt_number(beat)
    whole = beat.numerator // beat.denominator
    frac = beat - whole
    return f"{whole}+{frac.numerator}/{frac.denominator}"


def fmt_pos(score: Score, t: Fraction) -> str:
    bar, beat = score.position(t)
    return f"{bar}:{fmt_beat(beat)}"


_REST_UNITS = sorted((d for k, d in DURATIONS.items() if "3" not in k), reverse=True)


def _rest_tokens(d: Fraction) -> list[str]:
    """Spell a rest of arbitrary length as standard values, largest first."""
    out = []
    for unit in _REST_UNITS:
        while d >= unit:
            out.append("R" + dur_suffix(unit))
            d -= unit
    if d > 0:
        out.append("R" + dur_suffix(d))
    return out


def _select(score: Score, parts) -> list[Part]:
    if not parts:
        return score.ordered_parts()
    names = [parts] if isinstance(parts, str) else list(parts)
    return [score[n] for n in names]


def _bar_range(score: Score, bars, section: str | None = None) -> tuple[int, int]:
    if section is not None:
        return score.section_bars(section)
    if bars is None:
        return 1, score.bars
    if isinstance(bars, int):
        return bars, bars
    return bars[0], bars[1]


def _header(score: Score) -> str:
    title = score.title or "untitled"
    return f"{title}  ({score.meter_at(1).text}, {score.key.name}, q={fmt_number(Fraction(score.tempo))})"


def _bar_label(score: Score, bar: int) -> str:
    """'9' or, where the meter changes, '9 3/4'."""
    m = score.meter_at(bar)
    label = f"{bar} {m.text}" if bar > 1 and m != score.meter_at(bar - 1) else str(bar)
    sec = next((x.label for x in score.sections if x.bar == bar), None)
    return f"{label} [{sec}]" if sec else label


def _runs(sigs: list) -> list[tuple[int, int]]:
    """Index ranges (first, last) of consecutive equal items."""
    out: list[tuple[int, int]] = []
    for i, sg in enumerate(sigs):
        if out and sigs[out[-1][0]] == sg:
            out[-1] = (out[-1][0], i)
        else:
            out.append((i, i))
    return out


def _same_as(first: int, last: int, of: int) -> str:
    return f"{'bar ' + str(first) if first == last else f'bars {first}-{last}'}: same as {of}"


# --- melody-major ------------------------------------------------------------


def _bar_cells(score: Score, part: Part, nbars: int) -> list[list[str]]:
    """Tokens per bar for one part, markings included; notes crossing a
    barline are split and tied (~)."""
    starts = score.barlines(nbars)
    total = starts[-1]
    placed: list[list[tuple[Fraction, int, str]]] = [[] for _ in range(nbars)]
    for t, m in part.marks(Mark):
        b = min(bisect.bisect_right(starts, t) - 1, nbars - 1)
        placed[b].append((t, 2 if t >= starts[b + 1] else 0, m.token))
    timeline: list[tuple[Fraction, Fraction, Note | None]] = []
    cur = Fraction(0)
    for t, n in part.events(merge_ties=False):  # show ties as written
        if t > cur:
            timeline.append((cur, t - cur, None))
        timeline.append((t, n.dur, n))
        cur = max(cur, t + n.dur)
    if cur < total:
        timeline.append((cur, total - cur, None))

    for start, dur, note in timeline:
        s, left = start, dur
        while left > 0:
            b = bisect.bisect_right(starts, s) - 1
            if b >= nbars:
                break
            seg = min(left, starts[b + 1] - s)
            if note is None:
                placed[b].append((s, 1, " ".join(_rest_tokens(seg))))
            else:
                last = seg == left
                # attack articulations on the first piece, a fermata on the last
                art = "".join(c for c in note.art if (c == "@" and last) or (c != "@" and s == start))
                tie = (not last or note.tied) and not note.is_rest
                head = "R" if note.is_rest else note.head()
                length = note.suffix() if seg == note.dur else dur_suffix(seg)
                placed[b].append((s, 1, head + length + art + ("~" if tie else "")))
            s += seg
            left -= seg
    return [[tok for _, _, tok in sorted(bar, key=lambda x: (x[0], x[1]))] for bar in placed]


def melody(score: Score, bars=None, parts=None, width: int = 4, section: str | None = None,
           collapse: bool = False) -> str:
    """With collapse, a run of bars identical (in every shown part) to the
    bar before is one line, 'bars 12-19: same as 11'."""
    first, last = _bar_range(score, bars, section)
    sel = _select(score, parts)
    with spelling(score.key):
        cells = {p.name: _bar_cells(score, p, max(last, score.bars)) for p in sel}
    nw = max([len(p.name) for p in sel] + [3])
    lines = [_header(score), ""]
    # what to print: runs of bars as ("bars", [bar...]) or ("same", first, last, of)
    items: list[tuple] = []
    chunk: list[int] = []
    anchor = first
    for b in range(first, last + 1):
        if collapse and b > first and all(c[b - 1] == c[b - 2] for c in cells.values()):
            if chunk:
                items.append(("bars", chunk))
                chunk = []
            if items and items[-1][0] == "same":
                items[-1] = ("same", items[-1][1], b, anchor)
            else:
                items.append(("same", b, b, anchor))
        else:
            chunk.append(b)
            anchor = b
    if chunk:
        items.append(("bars", chunk))
    for item in items:
        if item[0] == "same":
            lines += [_same_as(item[1], item[2], item[3]), ""]
            continue
        bars_ = item[1]
        for i in range(0, len(bars_), width):
            chunk = bars_[i:i + width]
            texts = {name: [" ".join(c[b - 1]) for b in chunk] for name, c in cells.items()}
            widths = [max([len(_bar_label(score, b))] + [len(texts[p.name][j]) for p in sel])
                      for j, b in enumerate(chunk)]
            lines.append((f"{'bar':<{nw}} | " + " | ".join(_bar_label(score, b).ljust(w)
                                                          for b, w in zip(chunk, widths))).rstrip())
            for p in sel:
                lines.append(f"{p.name:<{nw}} | " + " | ".join(t.ljust(w) for t, w in zip(texts[p.name], widths)) + " |")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


# --- chord naming ------------------------------------------------------------

# (intervals above root, chord-symbol suffix, roman-numeral suffix, minor-ish?)
CHORDS = [
    ((0, 4, 7), "", "", False), ((0, 3, 7), "m", "", True),
    ((0, 3, 6), "dim", "°", True), ((0, 4, 8), "+", "+", False),
    ((0, 4, 7, 10), "7", "7", False), ((0, 4, 7, 11), "maj7", "maj7", False),
    ((0, 3, 7, 10), "m7", "7", True), ((0, 3, 6, 10), "m7b5", "ø7", True),
    ((0, 3, 6, 9), "dim7", "°7", True), ((0, 3, 7, 11), "mMaj7", "maj7", True),
    ((0, 4, 10), "7", "7", False), ((0, 3, 10), "m7", "7", True), ((0, 4, 11), "maj7", "maj7", False),
    ((0, 5, 7), "sus4", "sus4", False), ((0, 2, 7), "sus2", "sus2", False),
    ((0, 7), "5", "5", False),
    ((0, 4), "", "", False), ((0, 3), "m", "", True),  # root + third: read as the implied triad
]
ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"]
INVERSIONS_TRIAD = {3: "6", 4: "6", 6: "64", 7: "64", 8: "64"}
INVERSIONS_7TH = {3: "65", 4: "65", 6: "43", 7: "43", 8: "43", 9: "42", 10: "42", 11: "42"}


def name_chord(midis: list[int], score: Score) -> tuple[str, str]:
    """('B7/D#', 'V65') for a list of sounding MIDI pitches; ('', '') if silent."""
    if not midis:
        return "", ""
    bass = min(midis) % 12
    pcs = {m % 12 for m in midis}
    if len(pcs) == 1:
        return f"({pc_name(bass)})", ""
    roots = [bass] + sorted(pcs - {bass})
    for ivs, sym, rn_sfx, minorish in CHORDS:
        for root in roots:
            if {(pc - root) % 12 for pc in pcs} == set(ivs):
                name = pc_name(root) + sym
                if root != bass:
                    name += "/" + pc_name(bass)
                return name, _roman(root, bass, ivs, rn_sfx, minorish, score)
    return "{" + " ".join(pc_name(pc) for pc in sorted(pcs, key=lambda p: (p - bass) % 12)) + "}", ""


def _roman(root, bass, ivs, sfx, minorish, score) -> str:
    if sfx == "5":
        return ""
    deg, alter = score.key.degree(root)
    rn = ROMAN[deg].lower() if minorish else ROMAN[deg]
    rn = {-1: "b", 0: "", 1: "#"}[alter] + rn
    inv = (bass - root) % 12
    if inv and not sfx.startswith("sus"):
        if len(ivs) == 4 or sfx in ("7", "ø7", "°7", "maj7"):
            fig = INVERSIONS_7TH.get(inv, "")
            sfx = sfx.replace("7", fig) if fig else sfx
        else:
            sfx += INVERSIONS_TRIAD.get(inv, "")
    return rn + sfx


def harmony_label(midis: list[int], score: Score) -> tuple[str, str, str]:
    """Every reading of the sounding pitches at once: a chord symbol (or the
    pitch classes over the bass), a roman numeral in the score's key where
    one applies, and the set class."""
    from .analysis import set_label
    sym, rn = name_chord(midis, score)
    return sym, rn, set_label(midis) if len({m % 12 for m in midis}) > 1 else ""


# --- harmony-major -----------------------------------------------------------


def _sounding(evs: list[tuple[Fraction, Note]], starts: list[Fraction], t: Fraction):
    """The (start, note) sounding at t in a part, or None."""
    i = bisect.bisect_right(starts, t) - 1
    # Normally only evs[i] can cover t; look a little further back in case
    # placements overlap (check() reports that as an error).
    for j in range(i, max(i - 8, -1), -1):
        s, n = evs[j]
        if s + n.dur > t:
            return s, n
    return None


def grid(score: Score, bars=None, parts=None, step=None, chords: bool = True,
         section: str | None = None, collapse: bool = False) -> str:
    """With collapse, a bar whose rows (onsets, notes, chords) repeat the bar
    before is folded into one line, 'bars 12-19: same as 11'."""
    first, last = _bar_range(score, bars, section)
    sel = _select(score, parts)
    t0, t1 = score.time(first), score.time(last + 1)
    evs = {p.name: p.events() for p in score.parts}
    starts = {name: [s for s, _ in e] for name, e in evs.items()}

    times = {score.time(b) for b in range(first, last + 1)}
    for p in sel:
        for s, n in evs[p.name]:
            times.update((s, s + n.dur))
    if step:
        st = Fraction(step)
        times.update(t0 + k * st for k in range(int((t1 - t0) / st)))
    rows_t = sorted(t for t in times if t0 <= t < t1)

    with spelling(score.key):
        rows = []
        for t in rows_t:
            cells = []
            for p in sel:
                hit = _sounding(evs[p.name], starts[p.name], t)
                if hit is None or hit[1].is_rest:
                    cells.append(".")
                elif hit[0] == t:
                    cells.append(repr(hit[1]))
                else:
                    cells.append("|")
            label = ("", "", "")
            if chords:
                midis = []
                for p in score.parts:
                    hit = _sounding(evs[p.name], starts[p.name], t)
                    if hit and not hit[1].is_rest:
                        midis.extend(x.midi for x in hit[1].pitches)
                label = harmony_label(midis, score)
            rows.append((t, fmt_pos(score, t), cells, label))

    # one entry per bar: its rows, or the run of bars it repeats
    by_bar: dict[int, list] = {}
    for r in rows:
        by_bar.setdefault(score.position(r[0])[0], []).append(r)
    sigs = {b: tuple((r[0] - score.bar_start(b), tuple(r[2]), r[3]) for r in rs) for b, rs in by_bar.items()}
    shown: list = []          # rows, or ("same", first, last, of)
    anchor = None
    for b in sorted(by_bar):
        if collapse and b - 1 in sigs and sigs[b] == sigs[b - 1]:
            if shown and shown[-1][0] == "same":
                shown[-1] = ("same", shown[-1][1], b, anchor)
            else:
                shown.append(("same", b, b, anchor))
        else:
            shown.extend(by_bar[b])
            anchor = b
    rows = [r for r in shown if not isinstance(r[0], str)]
    pw = max([len(r[1]) for r in rows] + [5])
    cw = [max([len(p.name)] + [len(r[2][i]) for r in rows]) for i, p in enumerate(sel)]
    sw = max([len(r[3][0]) for r in rows] + [5])
    rw = max([len(r[3][1]) for r in rows] + [2])
    head = f"{'pos':<{pw}}  " + "  ".join(p.name.ljust(w) for p, w in zip(sel, cw))
    if chords:
        head += f"  | {'chord':<{sw}}  {'rn':<{rw}}  set"
    lines = [_header(score), "", head]
    for r in shown:
        if isinstance(r[0], str):
            text = _same_as(r[1], r[2], r[3])
            lines.append(f"-- {text} " + "-" * max(0, len(head) - len(text) - 4))
            continue
        t, pos, cells, (sym, rn, pcset) = r
        if score.is_barline(t):
            bar = _bar_label(score, score.position(t)[0])
            lines.append(f"-- {bar} " + "-" * max(0, len(head) - len(bar) - 4))
        row = f"{pos:<{pw}}  " + "  ".join(c.ljust(w) for c, w in zip(cells, cw))
        if chords:
            row += f"  | {sym:<{sw}}  {rn:<{rw}}  {pcset}"
        lines.append(row.rstrip())
    return "\n".join(lines) + "\n"


# --- validation & analysis ---------------------------------------------------


def _beats(score: Score, quarters: Fraction, bar: int) -> str:
    n = quarters / score.meter_at(bar).beat_len
    return f"{fmt_number(n)} beat{'' if n == 1 else 's'}"


NOTE_NAMES = {Fraction(4): "a whole note", Fraction(2): "a half note", Fraction(1): "a quarter",
              Fraction(1, 2): "an eighth", Fraction(1, 4): "a sixteenth", Fraction(1, 8): "a 32nd"}


def _amount(d: Fraction) -> str:
    """A length as a musician says it: 'an eighth (.e)', 'a dotted quarter (.qd)'."""
    for v, name in NOTE_NAMES.items():
        if d == v:
            return f"{name} ({dur_suffix(d)})"
        if d == v * Fraction(3, 2):
            return f"a dotted {name.split(' ', 1)[1]} ({dur_suffix(d)})"
    return f"{fmt_number(d)} quarter{'s' if d != 1 else ''} ({dur_suffix(d)})"


def _enters_mid_bar(score: Score, start: Fraction, motif) -> bool:
    """A motif that starts off a barline, and whose barlines each fall one
    whole bar further on counting from its own start, is an entry displaced
    against the metre (a stretto, a canon at the half bar). Its barlines
    describe its own bars, so they aren't held to the score's."""
    if score.is_barline(start):
        return False
    b0, t, k = score.position(start)[0], Fraction(0), 0
    expected = score.meter_at(b0).bar_len
    for it in motif.items:
        if isinstance(it, Note):
            t += it.dur
        elif isinstance(it, Bar) and it.number is None:
            if t != expected:
                return False
            k += 1
            expected += score.meter_at(b0 + k).bar_len
    return k > 0


def _anchor_issues(score: Score, p: Part):
    """Check each barline anchor against the one before it, so a miscounted
    bar is reported once, where it happens. After an error the check resyncs
    to the barline the writer evidently meant, instead of flagging every
    later anchor in the same placement as off by the same amount."""
    for start, motif in p.placements:
        displaced = _enters_mid_bar(score, start, motif)
        t, drift, prev = start, Fraction(0), start  # drift: error carried by earlier bad bars
        for it in motif.items:
            if isinstance(it, Note):
                t += it.dur
                continue
            if not isinstance(it, Bar) or (displaced and it.number is None):
                continue
            pos, prev_pos = t - drift, prev - drift
            if not score.is_barline(pos):
                b1 = score.position(prev_pos)[0]
                here = score.position(pos)[0]
                below, above = score.bar_start(here), score.bar_start(here + 1)
                nearest = max(above if above - pos < pos - below else below, score.bar_start(b1 + 1))
                bars = score.position(nearest)[0] - b1
                which = f"bar {b1} has" if bars == 1 else f"bars {b1}-{b1 + bars - 1} have"
                expected = nearest - prev_pos
                off = (t - prev) - expected
                yield ("ERROR", prev, p.name, f"{which} {_beats(score, t - prev, b1)}, expected "
                       f"{_beats(score, expected, b1)}: {_amount(abs(off))} too {'long' if off > 0 else 'short'} "
                       f"(the barline written at {fmt_pos(score, t)} should be at {fmt_pos(score, prev + expected)})")
                drift += pos - nearest
                pos = nearest
            if it.number is not None and pos != score.time(it.number):
                yield ("ERROR", t, p.name, f"Bar({it.number}) anchor is at the start of bar {score.position(pos)[0]}, "
                       f"not bar {it.number}")
            prev = t


def _marking_issues(score: Score, p: Part):
    """Hairpins that never reach an end, and pedal lifts with no pedal down."""
    hairpin, down = None, False
    for t, m in p.marks(Mark):
        if m.kind in ("cresc", "dim"):
            hairpin = (t, m)
        elif m.kind == "end" or (m.kind == "dyn" and m.value not in ("sf", "sfz", "rfz")):
            if m.kind == "end" and hairpin is None:
                yield ("WARN", t, p.name, "hairpin end (!) with no hairpin open")
            hairpin = None
        elif m.kind == "ped":
            down = True
        elif m.kind == "pedup":
            if not down:
                yield ("WARN", t, p.name, "pedal lift (*) with no pedal down")
            down = False
    if hairpin:
        yield ("NOTE", hairpin[0], p.name, f"hairpin {hairpin[1].token} runs to the end of the piece "
               f"(no dynamic or ! after it)")


def _issues(score: Score) -> list[tuple[str, Fraction, str, str]]:
    """(level, time, where, message) for everything check() reports."""
    out = []
    for p in score.parts:
        out.extend(_anchor_issues(score, p))
        out.extend(_marking_issues(score, p))
        for d in p.drifts:
            out.append(("NOTE", d.start, p.name, f"playback drifts {ahead_name(d.ahead)} over "
                        f"{fmt_pos(score, d.start)}-{fmt_pos(score, d.end)}; the written music, views and "
                        f"engraving stay in written time"))
        # overlaps and range
        lo, hi = p.range
        end, prev = Fraction(0), None
        for t, n in p.events():
            if n.is_rest:
                continue
            if t < end:
                out.append(("ERROR", t, p.name, f"{n!r} overlaps {prev!r}, which sounds until {fmt_pos(score, end)} "
                            f"(a part is one line; for a second voice on this staff use {p.name}.voice(name))"))
            if t + n.dur > end:
                end, prev = t + n.dur, n
            for x in n.pitches:
                if x < lo or x > hi:
                    out.append(("WARN", t, p.name, f"{x} is {'below' if x < lo else 'above'} the {p.instrument} range {lo}..{hi}"))
    if not score.is_barline(score.end):
        out.append(("NOTE", score.end, "-", f"last bar ({score.bars}) is incomplete: music ends at {fmt_pos(score, score.end)}"))
    from .loops import plan_loops
    out.extend(("NOTE", t, where, msg) for t, where, msg in plan_loops(score).notes)
    order = {"ERROR": 0, "WARN": 1, "NOTE": 2}
    out.sort(key=lambda x: (order[x[0]], x[1]))
    return out


def lens(score: Score, bars=None, parts=None, kinds=None, section: str | None = None,
         collapse: bool = True) -> str:
    """What the voices are doing, bar by bar: dissonances named by how they
    move (passing, suspension m7->M6, appoggiatura ...), parallel fifths and
    octaves, crossings. Descriptive only; see analysis.observe(). `kinds`
    keeps only observations whose name contains one of the given words.
    With collapse (the default), a bar with exactly the observations of the
    bar before is folded into 'bars 12-19: same as 11'; collapse=False lists
    every one."""
    from .analysis import observe
    first, last = _bar_range(score, bars, section)
    t0, t1 = score.time(first), score.time(last + 1)
    obs = [o for o in observe(score) if t0 <= o.t < t1
           and (not parts or any(n in o.where.split("/") for n in parts))
           and (not kinds or any(k in o.kind for k in kinds))]
    lines = [_header(score), ""]
    if not obs:
        return "\n".join(lines + ["(nothing to note: consonant throughout)"]) + "\n"
    by_bar: dict[int, list] = {}
    for o in obs:
        by_bar.setdefault(score.position(o.t)[0], []).append(o)
    sig = {b: tuple((o.t - score.bar_start(b), o.where, o.kind, o.detail) for o in os_) for b, os_ in by_bar.items()}
    shown: list = []          # observations, or ("same", first, last, of)
    anchor = None
    for b in sorted(by_bar):
        if collapse and b - 1 in sig and sig[b] == sig[b - 1]:
            if shown and isinstance(shown[-1], tuple):
                shown[-1] = (shown[-1][0], shown[-1][1], b, anchor)
            else:
                shown.append(("same", b, b, anchor))
        else:
            shown.extend(by_bar[b])
            anchor = b
    real = [o for o in shown if not isinstance(o, tuple)]
    pw = max(len(fmt_pos(score, o.t)) for o in real)
    ww = max(len(o.where) for o in real)
    kw = max(len(o.kind) for o in real)
    bar = None
    for o in shown:
        if isinstance(o, tuple):
            text = _same_as(o[1], o[2], o[3])
            lines.append(f"-- {text} " + "-" * max(0, 40 - len(text)))
            bar = None
            continue
        b = score.position(o.t)[0]
        if b != bar:
            label = _bar_label(score, b)
            lines.append(f"-- {label} " + "-" * max(0, 40 - len(label)))
            bar = b
        lines.append(f"{fmt_pos(score, o.t):<{pw}}  {o.where:<{ww}}  {o.kind:<{kw}}  {o.detail}")
    return "\n".join(lines) + "\n"


# --- form ----------------------------------------------------------------------


def _form_rows(score: Score, first: int, last: int, every: int | None) -> list[tuple[str, int, int, str | None]]:
    """(label, first bar, last bar, description) for each row of form():
    the sections inside first..last, or fixed chunks of `every` bars."""
    if every is None and score.sections:
        rows, starts = [], [s.bar for s in score.sections]
        if first < starts[0]:
            rows.append(("-", 1, starts[0] - 1, None))
        for i, sec in enumerate(score.sections):
            end = starts[i + 1] - 1 if i + 1 < len(starts) else score.bars
            rows.append((sec.label, sec.bar, end, sec.description))
        return [(lab, max(a, first), min(b, last), d) for lab, a, b, d in rows if a <= last and b >= first]
    n = every or 8
    return [("-", a, min(a + n - 1, last), None) for a in range(first, last + 1, n)]


def _dyn_levels(score: Score, t0: Fraction, t1: Fraction) -> list[str]:
    """Dynamic levels in force over [t0, t1): the one holding at the start,
    then each new one, across all parts in time order."""
    marks = sorted(((t, m.value) for p in score.parts for t, m in p.marks(Mark) if m.kind == "dyn"),
                   key=lambda x: x[0])
    before = [v for t, v in marks if t <= t0]
    levels = before[-1:] + [v for t, v in marks if t0 < t < t1]
    return [v for i, v in enumerate(levels) if i == 0 or v != levels[i - 1]]


def form(score: Score, bars=None, section: str | None = None, every: int | None = None, parts=None) -> str:
    """The piece in broad strokes: one row per section (or per `every` bars,
    8 when there are no sections), saying which parts play, how many onsets
    per beat, the lowest and highest pitch, the pitch classes in play with
    their set class, the dynamics in force, and what changed since the row
    before. Descriptive only."""
    from .analysis import set_label
    first, last = _bar_range(score, bars, section)
    sel = _select(score, parts)
    names = [p.name for p in sel]
    evs = {p.name: [(t, n) for t, n in p.events() if not n.is_rest] for p in sel}
    data = []
    with spelling(score.key):
        spell: dict[int, str] = {}       # pitch class -> the way the piece spells it
        for e in evs.values():
            for _, n in e:
                for x in n.pitches:
                    spell.setdefault(x.midi % 12, repr(x).rstrip("-0123456789"))
        for label, a, b, desc in _form_rows(score, first, last, every):
            t0, t1 = score.time(a), score.time(b + 1)
            notes = {name: [(t, n) for t, n in e if t0 <= t < t1] for name, e in evs.items()}
            active = [name for name in names if notes[name]]
            pitches = [x for ns in notes.values() for _, n in ns for x in n.pitches]
            beats = sum(score.meter_at(x).bar_len / score.meter_at(x).beat_len for x in range(a, b + 1))
            onsets = sum(len(ns) for ns in notes.values())
            pcs = sorted({x.midi % 12 for x in pitches})
            lo = min(pitches, key=lambda x: x.midi) if pitches else None
            hi = max(pitches, key=lambda x: x.midi) if pitches else None
            data.append(dict(label=label, bars=f"{a}-{b}" if b > a else str(a), desc=desc, active=active,
                             dens=Fraction(onsets) / beats, lo=lo, hi=hi, pcs=pcs,
                             dyn=_dyn_levels(score, t0, t1)))
        for i, d in enumerate(data):
            d["density"] = f"{float(d['dens']):.1f}"
            d["register"] = f"{d['lo']}-{d['hi']}" if d["lo"] is not None else "-"
            d["set"] = (" ".join(spell[x] for x in d["pcs"]) +
                        (f"  {set_label(d['pcs'])}" if len(d["pcs"]) > 1 else "")) if d["pcs"] else "-"
            d["dynamics"] = ", ".join(d["dyn"]) or "-"
            d["parts"] = ",".join(d["active"]) if len(d["active"]) < len(names) else "all"
            d["changed"] = _form_changes(d, data[i - 1], spell) if i else ""
    cols = [("section", "label"), ("bars", "bars"), ("parts", "parts"), ("dens", "density"),
            ("register", "register"), ("pitch classes", "set"), ("dyn", "dynamics")]
    widths = [max([len(h)] + [len(str(d[k])) for d in data]) for h, k in cols]
    lines = [_header(score), ""]
    head = "  ".join(h.ljust(w) for (h, _), w in zip(cols, widths)) + "  changed since previous"
    lines.append(head)
    for d in data:
        row = "  ".join(str(d[k]).ljust(w) for (_, k), w in zip(cols, widths)) + "  " + d["changed"]
        lines.append(row.rstrip())
        if d["desc"]:
            lines.append(" " * (widths[0] + 2) + f"({d['desc']})")
    return "\n".join(lines) + "\n"


def _form_changes(d: dict, prev: dict, spell: dict[int, str]) -> str:
    out = []
    now, was = set(d["active"]), set(prev["active"])
    if now - was:
        out.append("+" + ",".join(n for n in d["active"] if n in now - was))
    if was - now:
        out.append("-" + ",".join(n for n in prev["active"] if n in was - now))
    new, old = set(d["pcs"]) - set(prev["pcs"]), set(prev["pcs"]) - set(d["pcs"])
    if new or old:
        out.append("pcs " + " ".join([f"+{spell[x]}" for x in sorted(new)] + [f"-{spell.get(x, pc_name(x))}" for x in sorted(old)]))
    a, b = float(prev["dens"]), float(d["dens"])
    if a != b and abs(a - b) >= 0.2 * max(a, b):
        out.append(f"density {a:.1f}->{b:.1f}")
    if prev["lo"] is not None and d["lo"] is not None:
        parts = []
        for name, x, y in (("lo", prev["lo"], d["lo"]), ("hi", prev["hi"], d["hi"])):
            if x.midi != y.midi:
                parts.append(f"{name} {y.midi - x.midi:+d}")
        if parts:
            out.append("register " + " ".join(parts))
    if d["dyn"][:1] != prev["dyn"][-1:] and d["dyn"] and prev["dyn"]:
        out.append(f"dyn {prev['dyn'][-1]}->{d['dyn'][0]}")
    return "; ".join(out)


def check(score: Score) -> str:
    """Is the score what you meant to write? Errors (bar anchors, overlaps),
    warnings (instrument ranges, unclosed hairpins, stray pedal lifts) and
    notes (an incomplete last bar). Musical observations are in lens()."""
    issues = _issues(score)
    secs = score.seconds(score.end)
    lines = [_header(score),
             f"{score.bars} bars, {len(score.parts)} parts, {int(secs // 60)}:{int(secs % 60):02d}", ""]
    if not issues:
        lines.append("ok: no problems found")
    ww = max([len(w) for _, _, w, _ in issues] + [4])
    pw = max([len(fmt_pos(score, t)) for _, t, _, _ in issues] + [3])
    for level, t, where, msg in issues:
        lines.append(f"{level:<5}  {fmt_pos(score, t):<{pw}}  {where:<{ww}}  {msg}")
    counts = {lv: sum(1 for x in issues if x[0] == lv) for lv in ("ERROR", "WARN", "NOTE")}
    if issues:
        lines += ["", ", ".join(f"{v} {k.lower()}{'s' if v != 1 else ''}" for k, v in counts.items())]
    return "\n".join(lines) + "\n"


def has_errors(score: Score) -> bool:
    return any(level == "ERROR" for level, *_ in _issues(score))
