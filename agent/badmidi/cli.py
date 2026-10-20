"""badmidi piece.py [view] -- run a piece script and show or export its score.

    badmidi piece.py                     melody-major view (default)
    badmidi piece.py grid --bars 5-8     harmony-major view of bars 5..8
    badmidi piece.py melody --section B  any view: --section B or B-C instead of --bars
    badmidi piece.py check               is it what you meant? bar counts, overlaps, ranges
    badmidi piece.py lens --bars 9-16    what the voices are doing: passing notes,
                                         suspensions, parallels, crossings (--kinds susp,parallel)
                                         (collapsed by default: 'bars 12-19: same as 11'; --all lists every bar)
    badmidi piece.py form [--every 8]    the piece in broad strokes: one row per section
    badmidi piece.py midi [-o out.mid]   write a MIDI file
    badmidi piece.py wav  [-o out.wav]   render audio with fluidsynth
    badmidi piece.py ly                  print LilyPond source
    badmidi piece.py pdf  [-o out.pdf]   engrave sheet music with LilyPond
    badmidi piece.py png  [-o out.png]   engrave to PNG page images
    badmidi piece.py musicxml [-o x.musicxml]  write MusicXML for notation apps
    badmidi piece.py all                 check, melody, grid, and write .mid

    badmidi song.mid grid                any view of a MIDI or MusicXML file directly
                                         (--quantize, --key as for import)
    badmidi pull PROJECT -o piece.py     a mobdaw project as a piece (+ piece.mobdaw.json); see bridge.py
    badmidi push piece.py [--apply]      the piece's note edits back to the project, as ONE history entry
    badmidi projects                     (MOBDAW_URL, MOBDAW_TOKEN in the environment)

    badmidi import song.mid [-o song.py] import MIDI or MusicXML as a badmidi piece to edit
            [--quantize auto|none|s|e3] [--key "D minor"] [--phrase 4]
"""
from __future__ import annotations

import argparse
import os
import runpy
import sys
from fractions import Fraction

from .core import duration
from .score import Score


MIDI_EXT = (".mid", ".midi")
MUSICXML_EXT = (".musicxml", ".xml", ".mxl")


def import_file(path: str, **kw):
    """(Score, ImportReport) for a MIDI or MusicXML file."""
    ext = os.path.splitext(path)[1].lower()
    if ext in MIDI_EXT:
        from .ingest import import_midi
        return import_midi(path, **kw)
    if ext in MUSICXML_EXT:
        from .musicxml import import_musicxml
        return import_musicxml(path, **kw)
    sys.exit(f"{path}: can only import .mid/.midi and .musicxml/.xml/.mxl files")


def load_score(path: str, name: str | None = None, **import_kw) -> Score:
    """The Score a piece script builds, or an imported MIDI/MusicXML file."""
    if os.path.splitext(path)[1].lower() in MIDI_EXT + MUSICXML_EXT:
        return import_file(path, **import_kw)[0]
    ns = runpy.run_path(path, run_name="__badmidi__")
    if name:
        if not isinstance(ns.get(name), Score):
            sys.exit(f"{path}: no Score named {name!r}")
        return ns[name]
    if isinstance(ns.get("score"), Score):
        return ns["score"]
    found = [v for k, v in ns.items() if isinstance(v, Score) and not k.startswith("_")]
    if len(found) != 1:
        sys.exit(f"{path}: define a variable named `score` (found {len(found)} Score objects)")
    return found[0]


def _bars(text: str | None):
    if not text:
        return None
    a, _, b = text.partition("-")
    return int(a), int(b or a)


def _step(text: str | None):
    if not text:
        return None
    try:
        return duration(text)
    except ValueError:
        return Fraction(text)


def _import_kw(args) -> dict:
    kw = {}
    if args.quantize:
        kw["quantize"] = args.quantize
    if args.key:
        kw["key"] = args.key
    return kw


def import_main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="badmidi import",
                                 description="Import a MIDI or MusicXML file as a badmidi piece to edit.")
    ap.add_argument("file", help=".mid/.midi or .musicxml/.xml/.mxl")
    ap.add_argument("-o", "--out", help="piece to write (default: next to the file, .py)")
    ap.add_argument("--quantize", help="auto (default), none, or a grid: s, e, e3, s3")
    ap.add_argument("--key", help='the key, if the file has none or a wrong one: "D minor"')
    ap.add_argument("--phrase", type=int, default=4, help="bars per at() call (default 4)")
    args = ap.parse_args(argv)
    from .source import write_source
    from .views import has_errors
    try:
        score, report = import_file(args.file, phrase=args.phrase, **_import_kw(args))
    except ValueError as e:
        sys.exit(f"{args.file}: {e}")
    out = args.out or os.path.splitext(args.file)[0] + ".py"
    if os.path.abspath(out) == os.path.abspath(args.file):
        sys.exit("refusing to overwrite the file being imported; give -o")
    write_source(score, out, report, phrase=args.phrase)
    print(report)
    print(f"wrote {out}" + ("" if not has_errors(score) else "; check reports errors"))
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["import"]:
        return import_main(argv[1:])
    if argv[:1] in (["pull"], ["push"], ["projects"]):
        from .bridge import main as bridge_main
        return bridge_main(argv[0], argv[1:])
    ap = argparse.ArgumentParser(prog="badmidi", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("piece", help="python file that builds a Score")
    ap.add_argument("view", nargs="?", default="melody",
                    choices=["melody", "grid", "check", "lens", "form", "midi", "wav", "ly", "pdf", "png", "musicxml", "all"])
    ap.add_argument("-o", "--out", help="output path for midi/wav (default: next to the piece)")
    ap.add_argument("--bars", help="bar range, e.g. 5-8 or 12")
    ap.add_argument("--section", help="a section label (B) or span (B-C), instead of --bars")
    ap.add_argument("--every", type=int, help="form: one row per N bars instead of per section")
    ap.add_argument("--collapse", action="store_true",
                    help="melody, grid: fold bars identical to the one before into 'bars 12-19: same as 11'")
    ap.add_argument("--all", action="store_true", help="lens: list every bar, don't collapse repeats")
    ap.add_argument("--parts", help="comma-separated part names to show")
    ap.add_argument("--width", type=int, default=4, help="bars per line in the melody view")
    ap.add_argument("--step", help="grid: also add a row every STEP (e.g. e, s, 0.5)")
    ap.add_argument("--score", help="name of the Score variable, if not `score`")
    ap.add_argument("--soundfont", help="soundfont for wav rendering")
    ap.add_argument("--quantize", help="MIDI/MusicXML input: auto (default), none, or a grid: s, e, e3")
    ap.add_argument("--key", help='MIDI/MusicXML input: the key, e.g. "D minor"')
    ap.add_argument("--kinds", help="lens: only observations naming these, e.g. susp,parallel")
    args = ap.parse_args(argv)

    try:
        score = load_score(args.piece, args.score, **_import_kw(args))
    except ValueError as e:
        sys.exit(f"{args.piece}: {e}")
    parts = args.parts.split(",") if args.parts else None
    bars = _bars(args.bars)
    if args.section and args.bars:
        sys.exit("give --bars or --section, not both")
    if args.section:
        try:
            bars = score.section_bars(args.section)
        except ValueError as e:
            sys.exit(str(e))
    where = dict(bars=bars)
    stem = os.path.splitext(args.piece)[0]

    if args.view in ("check", "all"):
        print(score.check())
    if args.view == "lens":
        print(score.lens(**where, parts=parts, kinds=args.kinds.split(",") if args.kinds else None,
                         collapse=not args.all))
    if args.view == "form":
        print(score.form(**where, every=args.every, parts=parts))
    if args.view in ("melody", "all"):
        print(score.melody(**where, parts=parts, width=args.width, collapse=args.collapse))
    if args.view in ("grid", "all"):
        print(score.grid(**where, parts=parts, step=_step(args.step), collapse=args.collapse))
    if args.view in ("midi", "all"):
        out = args.out if args.view == "midi" and args.out else stem + ".mid"
        score.write_midi(out)
        print(f"wrote {out}")
    if args.view == "wav":
        out = args.out or stem + ".wav"
        score.render_wav(out, args.soundfont)
        print(f"wrote {out}")
    if args.view == "musicxml":
        out = args.out or stem + ".musicxml"
        if os.path.abspath(out) == os.path.abspath(args.piece):
            sys.exit("refusing to overwrite the input; give -o")
        from .musicxml import write_musicxml
        write_musicxml(score, out)
        print(f"wrote {out}")
    if args.view == "ly":
        print(score.lilypond())
    if args.view in ("pdf", "png"):
        out = args.out or stem + "." + args.view
        from .lilypond import EngraveError
        try:
            score.engrave(out, args.view)
        except EngraveError as e:
            sys.exit(str(e))
        print(f"engraved {os.path.splitext(out)[0]}.{args.view}; verified: all notes match the score")
    return 0


if __name__ == "__main__":
    sys.exit(main())
