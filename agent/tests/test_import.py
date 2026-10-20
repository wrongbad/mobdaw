"""Importing human music: MIDI files into Scores.  Run with:  python -m unittest discover tests

A tiny MIDI builder stands in for files from the wild; the example pieces
(exported by midi_bytes) prove the whole path on real material.
"""
import random
import unittest
from fractions import Fraction
from pathlib import Path

from badmidi import Meter, key
from badmidi.cli import load_score
from badmidi.core import M
from badmidi.ingest import (Source, SourceNote, SourceTrack, build_score, estimate_key,
                            instrument_for, score_from_source)
from badmidi.midi import PPQ, _meta, _track, midi_bytes, read_midi, read_notes
from badmidi.views import _bar_cells, has_errors

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def ticks(q) -> int:
    return round(Fraction(q) * PPQ)


def smf(tracks, fmt=1) -> bytes:
    body = b"".join(_track(t) for t in tracks)
    return (b"MThd" + (6).to_bytes(4, "big") + fmt.to_bytes(2, "big")
            + len(tracks).to_bytes(2, "big") + PPQ.to_bytes(2, "big") + body)


def notes_events(ch, notes, program=None, name=None, pedal=()):
    """Track events for [(onset, dur, pitch)] in quarters on one channel."""
    evs = [(0, 0, _meta(0x03, name.encode()))] if name else []
    if program is not None:
        evs.append((0, 0, bytes([0xC0 | ch, program])))
    for on, dur, p in notes:
        evs.append((ticks(on), 2, bytes([0x90 | ch, p, 80])))
        evs.append((ticks(Fraction(on) + Fraction(dur)), 1, bytes([0x80 | ch, p, 0])))
    for t, down in pedal:
        evs.append((ticks(t), 0, bytes([0xB0 | ch, 64, 127 if down else 0])))
    return evs


def conductor(meters=((0, 4, 4),), tempos=((0, 120),), sig=None, title="piece", extra=()):
    evs = [(0, 0, _meta(0x03, title.encode()))]
    for t, n, d in meters:
        evs.append((ticks(t), 0, _meta(0x58, bytes([n, d.bit_length() - 1, 24, 8]))))
    for t, bpm in tempos:
        evs.append((ticks(t), 1, _meta(0x51, round(60_000_000 / bpm).to_bytes(3, "big"))))
    if sig is not None:
        evs.append((0, 0, _meta(0x59, bytes([sig[0] & 0xFF, sig[1]]))))
    return evs + list(extra)


def cells(score, name):
    return [" ".join(c) for c in _bar_cells(score, score[name], score.bars)]


def line(src_score, name):
    return [" ".join(c) for c in _bar_cells(src_score, src_score[name], src_score.bars)]


def pitches_of(motif_text, start=Fraction(0)):
    """[(onset, dur, midi)] of a string melody."""
    return [(start + t, n.dur, n.pitch.midi) for t, n in M(motif_text).timed() if not n.is_rest]


MELODY = "C4.q D4.q E4.e F4.e G4.q | A4.h G4.q F4.q | E4.q D4.e C4.e D4.q E4.q | C4.w |"
BARS = [c.strip() for c in MELODY.strip(" |").split("|")]


class TestRead(unittest.TestCase):
    def test_read_notes_unchanged_by_refactor(self):
        data = smf([conductor(), notes_events(0, [(0, 1, 60), (1, 2, 64)])])
        self.assertEqual(read_notes(data), [(0, 60, 1), (1, 64, 2)])

    def test_tracks_programs_and_meta(self):
        data = smf([conductor(meters=[(0, 3, 4)], tempos=[(0, 90)], sig=(-2, 1)),
                    notes_events(2, [(0, 1, 60)], program=40, name="Violin I")])
        src = read_midi(data)
        self.assertEqual(src.title, "piece")
        self.assertEqual(src.key.name, "G minor")
        self.assertEqual(src.meters, [(0, 3, 4)])
        self.assertEqual(src.tempos, [(0, 90.0)])
        tr, = src.tracks
        self.assertEqual((tr.name, tr.program, tr.channel), ("Violin I", 40, 2))
        self.assertEqual((tr.notes[0].onset, tr.notes[0].dur, tr.notes[0].velocity), (0, 1, 80))

    def test_note_on_velocity_zero_is_off_and_running_status(self):
        body = (b"\x00\xc0\x00" b"\x00\x90\x3c\x50" b"\x87\x40\x3c\x00" b"\x00\x40\x50" b"\x87\x40\x40\x00"
                b"\x00\xff\x2f\x00")
        data = (b"MThd" + (6).to_bytes(4, "big") + b"\x00\x00\x00\x01" + PPQ.to_bytes(2, "big")
                + b"MTrk" + len(body).to_bytes(4, "big") + body)
        self.assertEqual(read_notes(data), [(0, 60, 1), (1, 64, 1)])

    def test_format0_splits_by_channel_and_drums_are_marked(self):
        evs = (conductor() + notes_events(0, [(0, 1, 60)], program=73)
               + notes_events(1, [(0, 1, 40)], program=33) + notes_events(9, [(0, .5, 36), (1, .5, 38)]))
        src = read_midi(smf([evs], fmt=0))
        self.assertEqual([(t.channel, t.program) for t in src.tracks], [(0, 73), (1, 33), (9, None)])
        self.assertEqual(src.title, "piece")

    def test_pedal_marks_and_markers(self):
        data = smf([conductor(extra=[(ticks(4), 0, _meta(0x06, b"Verse"))]),
                    notes_events(0, [(0, 4, 60)], pedal=[(0, True), (2, False), (3, True), (3.5, True)])])
        src = read_midi(data)
        self.assertEqual(src.markers, [(4, "Verse")])
        self.assertEqual([(t, m.token) for t, m in src.tracks[0].marks], [(0, "ped"), (2, "*"), (3, "ped")])


class TestBuild(unittest.TestCase):
    def build(self, tracks, **kw):
        score, rep = build_score(read_midi(smf([conductor(**kw.pop("cond", {}))] + tracks)), **kw)
        self.assertFalse(has_errors(score), score.check())
        return score, rep

    def test_on_grid_import_is_exact(self):
        score, rep = self.build([notes_events(0, pitches_of(MELODY), program=73, name="Flute")],
                                key="C major")
        self.assertEqual(cells(score, "flute"), BARS)
        self.assertEqual(rep.notes_moved, 0)
        self.assertEqual(score["flute"].instrument, "flute")
        self.assertEqual(score["flute"].program, 73)
        self.assertEqual(score.bars, 4)

    def test_performance_jitter_snaps_back(self):
        rng = random.Random(7)
        notes = pitches_of(MELODY)
        jitter = lambda t: t + Fraction(rng.randint(-29 if t else 0, 29), PPQ)
        played = [(jitter(on), jitter(on + d) - jitter(on), p) for on, d, p in notes]
        score, rep = self.build([notes_events(0, played, name="tune")], key="C major")
        self.assertEqual(cells(score, "tune"), BARS)
        self.assertGreater(rep.notes_moved, len(notes) - 4)
        self.assertEqual(rep.notes_total, len(notes))
        self.assertLessEqual(rep.max_move, Fraction(58, PPQ))
        self.assertIn(rep.max_move_text, ("a 32nd", "a sixteenth"))
        self.assertIn("quantize: ", str(rep))

    def test_jittered_triplets_pick_the_triplet_grid(self):
        rng = random.Random(3)
        text = "C4.q E4.e3 F4.e3 G4.e3 A4.h | B4.e3 A4.e3 G4.e3 E4.q C4.h |"
        played = [(on + Fraction(rng.randint(-25 if on else 0, 25), PPQ), d, p) for on, d, p in pitches_of(text)]
        score, _ = self.build([notes_events(0, played, name="t")], key="C major")
        self.assertEqual(cells(score, "t"), [c.strip() for c in text.strip(" |").split("|")])

    def test_triplets_survive_auto_exactly(self):
        text = "C4.e3 D4.e3 E4.e3 F4.s3 G4.s3 A4.s3 B4.s3 C5.s3 D5.s3 E4.h |"
        score, rep = self.build([notes_events(0, pitches_of(text), name="t")], key="C major")
        self.assertEqual(rep.notes_moved, 0)
        self.assertEqual(cells(score, "t"), [text.strip(" |")])

    def test_forced_grid_and_none(self):
        rough = [(Fraction(1, 100), Fraction(99, 100), 60), (1, 1, 62), (2, 2, 64)]
        data = smf([conductor(), notes_events(0, rough, name="x")])
        score, rep = build_score(read_midi(data), quantize="e", key="C major")
        self.assertEqual(cells(score, "x"), ["C4.q D4.q E4.h"])
        with self.assertRaisesRegex(ValueError, "C4 at 1:1\\+"):
            build_score(read_midi(data), quantize="none")
        exact = smf([conductor(), notes_events(0, [(0, 1, 60)], name="x")])
        build_score(read_midi(exact), quantize="none", key="C major")

    def test_tiny_notes_are_dropped_and_counted(self):
        notes = [(0, 1, 60), (Fraction(1, 2) + Fraction(1, 100), Fraction(1, 50), 64)]
        score, rep = self.build([notes_events(0, notes, name="x")], key="C major")
        self.assertEqual(rep.lengthened, 1)
        self.assertEqual(len(score["x"].events()), 2)
        self.assertIn("lengthened: 1 notes shorter", str(rep))

    def test_overlapping_notes_become_two_lines(self):
        notes = [(0, 4, 48), (0, 1, 60), (1, 1, 62), (2, 1, 64), (3, 1, 65), (4, 2, 55), (4, 1, 67), (5, 1, 69)]
        score, rep = self.build([notes_events(0, notes, name="piano")], key="C major")
        self.assertEqual([p.name for p in score.parts], ["piano", "piano 2"])
        self.assertEqual(rep.lines["piano"], 2)
        self.assertIn("piano -> piano, piano 2 (overlapping notes split into 2 lines)", str(rep))
        self.assertEqual(cells(score, "piano")[0], "C4.q D4.q E4.q F4.q")
        self.assertEqual(cells(score, "piano 2")[0], "C3.w")
        # same sound as the file
        got = sorted((t, p.midi) for part in score.parts for t, n in part.events() for p in n.pitches)
        self.assertEqual(got, sorted((o, p) for o, _, p in notes))

    def test_chords_stay_chords_and_stuck_notes_truncate(self):
        notes = [(0, 1, 60), (0, 1, 64), (0, 1, 67), (1, 4, 60), (2, 1, 60)]
        score, _ = self.build([notes_events(0, notes, name="c")], key="C major")
        self.assertEqual(cells(score, "c")[0], "[C4 E4 G4].q C4.q C4.h~")   # the stuck C4 is cut short by the next

    def test_format0_two_channels_make_two_parts(self):
        evs = (conductor() + notes_events(0, [(0, 4, 72)], program=40) + notes_events(1, [(0, 4, 40)], program=42))
        score, rep = build_score(read_midi(smf([evs], fmt=0)), key="C major")
        self.assertEqual([(p.name, p.instrument) for p in score.parts],
                         [("channel 1", "violin"), ("channel 2", "cello")])
        self.assertFalse(has_errors(score))

    def test_drum_channel_is_skipped(self):
        evs = conductor() + notes_events(0, [(0, 4, 60)]) + notes_events(9, [(0, .5, 36)])
        score, rep = build_score(read_midi(smf([evs], fmt=0)), key="C major")
        self.assertEqual(len(score.parts), 1)
        self.assertIn("skipped: drum track", str(rep))

    def test_key_from_file_and_given(self):
        track = notes_events(0, [(0, 1, 62)], name="x")
        score, rep = self.build([track], cond=dict(sig=(-1, 1)))
        self.assertEqual((score.key.name, rep.key_source), ("D minor", "from file"))
        score, rep = self.build([track], cond=dict(sig=(-1, 1)), key="E dorian")
        self.assertEqual((score.key.name, rep.key_source), ("E dorian", "given"))
        self.assertIn("key: E dorian (given)", str(rep))

    def test_key_estimated(self):
        scale = [(i, 1, p) for i, p in enumerate([60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60, 60])]
        score, rep = self.build([notes_events(0, scale, name="x")])
        self.assertEqual((score.key.name, rep.key_source), ("C major", "estimated"))
        # A minor: the tune leans on A and E, with a G# leading note
        tune = [69, 72, 71, 69, 64, 68, 69, 64, 72, 71, 69, 68, 69, 64, 65, 64, 62, 60, 59, 68, 69]
        score, rep = self.build([notes_events(0, [(i / 2, .5, p) for i, p in enumerate(tune)], name="x")])
        self.assertEqual(score.key.name, "A minor")
        self.assertEqual(estimate_key([0] * 12).name, "C major")

    def test_meter_and_tempo_changes(self):
        notes = [(i, 1, 60 + i % 5) for i in range(14)]
        score, rep = self.build([notes_events(0, notes, name="x")], key="C major",
                                cond=dict(meters=[(0, 4, 4), (8, 3, 4), (14, 6, 8)],
                                          tempos=[(0, 100), (8, 120), (8.25, 120.2), (11, 90)]))
        self.assertEqual(score.meter_at(2), Meter(4, 4))
        self.assertEqual(score.meter_at(3), Meter(3, 4))
        self.assertEqual(score.meter_at(5), Meter(6, 8))
        self.assertEqual([(m.start, m.bpm) for m in score.tempo_marks], [(0, 100), (8, 120), (11, 90)])
        self.assertEqual(score.tempo, 100)

    def test_meter_change_off_barline_moves_to_next(self):
        _, rep = self.build([notes_events(0, [(i, 1, 60) for i in range(8)], name="x")], key="C major",
                            cond=dict(meters=[(0, 4, 4), (5, 3, 4)]))
        self.assertTrue(any("not on a barline" in n for n in rep.notes), str(rep))

    def test_markers_become_sections(self):
        data = smf([conductor(extra=[(ticks(4), 0, _meta(0x06, b"Verse")), (ticks(8), 0, _meta(0x06, b"Chorus"))]),
                    notes_events(0, [(i, 1, 60) for i in range(12)], name="x")])
        score, _ = build_score(read_midi(data), key="C major")
        self.assertEqual([(s.bar, s.label, s.description) for s in score.sections],
                         [(2, "A", "Verse"), (3, "B", "Chorus")])

    def test_notes_across_barlines_are_tied(self):
        score, _ = self.build([notes_events(0, [(0, 2, 60), (2, 3, 64), (5, 3, 67)], name="x")], key="C major")
        self.assertEqual(cells(score, "x"), ["C4.h E4.h~", "E4.q G4.hd"])
        self.assertEqual([(t, n.dur) for t, n in score["x"].events()], [(0, 2), (2, 3), (5, 3)])

    def test_pedal_marks_land_in_the_music(self):
        score, _ = self.build([notes_events(0, [(0, 4, 60), (4, 4, 62)], name="x",
                                            pedal=[(1, True), (4, False)])], key="C major")
        self.assertEqual(cells(score, "x")[0], "C4.q~ ped C4.hd")
        self.assertEqual([(t, m.token) for t, m in score["x"].marks() if hasattr(m, "kind")],
                         [(1, "ped"), (4, "*")])
        self.assertEqual([(t, n.dur) for t, n in score["x"].events()], [(0, 4), (4, 4)])

    def test_phrase_chunks_skip_silent_bars(self):
        notes = [(0, 4, 60), (36, 4, 62)]
        score, _ = self.build([notes_events(0, notes, name="x")], key="C major", phrase=4)
        self.assertEqual([t for t, _ in score["x"].placements], [0, 32])
        self.assertEqual(score.bars, 10)

    def test_grouped_tracks_get_clefs(self):
        src = Source("g", [SourceTrack("rh", 0, [SourceNote(Fraction(0), Fraction(4), 72)], staff_group="Piano"),
                           SourceTrack("lh", 0, [SourceNote(Fraction(0), Fraction(4), 40)], staff_group="Piano")],
                     key=key("C major"))
        score = score_from_source(src)
        self.assertEqual([(p.group, p.clef, p.channel) for p in score.parts],
                         [("Piano", "treble", "Piano"), ("Piano", "bass", "Piano")])

    def test_voices_and_ties_from_the_source(self):
        n = lambda on, dur, p, **kw: SourceNote(Fraction(on), Fraction(dur), p, **kw)
        src = Source("v", [SourceTrack("s", 0, [n(0, 3, 72, voice=1, tie=True), n(3, 3, 72, voice=1),
                                               n(0, 6, 60, voice=2), n(6, 2, 71, spell="Cb5", voice=1)])],
                     key=key("C major"))
        score = score_from_source(src)
        self.assertEqual([p.name for p in score.parts], ["s", "s 2"])
        self.assertEqual(cells(score, "s"), ["C5.w~", "C5.h Cb5.h"])
        self.assertEqual([(t, n.dur) for t, n in score["s"].events()][:1], [(0, 6)])
        self.assertEqual(score["s"].events()[-1][1].pitch.name, "Cb5")
        self.assertEqual(score["s 2"].events()[0][1].pitch.midi, 60)

    def test_instrument_mapping(self):
        self.assertEqual([instrument_for(p) for p in (0, 19, 52, 48, 40, 73)],
                         ["piano", "organ", "choir", "strings", "violin", "flute"])
        self.assertEqual(instrument_for(2), "piano")           # same family
        self.assertEqual(instrument_for(125), "piano")           # nothing close: piano
        self.assertEqual(instrument_for(None, "cello"), "cello")

    def test_part_names_are_sanitised_and_unique(self):
        src = Source("n", [SourceTrack("  Lead  Guitar! ", 24, [SourceNote(Fraction(0), Fraction(1), 60)]),
                           SourceTrack("lead guitar", 24, [SourceNote(Fraction(0), Fraction(1), 62)]),
                           SourceTrack("", 24, [SourceNote(Fraction(0), Fraction(1), 64)])], key=key("C major"))
        score, rep = build_score(src)
        self.assertEqual([p.name for p in score.parts], ["lead guitar", "lead guitar 2", "track 3"])
        self.assertEqual(score.parts[0].program, 24)


class TestExamples(unittest.TestCase):
    def test_examples_roundtrip_through_midi(self):
        checked = 0
        for path in sorted(EXAMPLES.glob("*.py")):
            original = load_score(str(path))
            if any(p.drifts for p in original.parts):
                continue
            with self.subTest(example=path.name):
                score, rep = build_score(read_midi(midi_bytes(original)))
                self.assertFalse(has_errors(score), score.check())
                want = [sorted({(t, p.midi + c) for t, n in part.events() if not n.is_rest
                                for p in n.pitches for c in part.couplers})
                        for part in original.parts if any(not n.is_rest for _, n in part.events())]
                by_name = {p.name: p for p in score.parts}
                got = [sorted({(t, p.midi) for name in names for t, n in by_name[name].events()
                               if not n.is_rest for p in n.pitches}) for _, names in rep.parts]
                self.assertEqual(len(got), len(want))
                self.assertEqual(rep.notes_moved, 0)
                for i, (g, w) in enumerate(zip(got, want)):
                    self.assertEqual(g, w, f"track {i} ({rep.parts[i][0]})")
                checked += 1
        self.assertGreater(checked, 5)


class TestImportExtras(unittest.TestCase):
    def test_tempo_ramp_becomes_rit(self):
        tempos = [(0, 120)] + [(8 + i * Fraction(1, 2), 120 - 4 * (i + 1)) for i in range(8)]
        score, rep = build_score(read_midi(smf([conductor(tempos=tempos),
                                                notes_events(0, [(q, 1, 60) for q in range(16)])])))
        self.assertEqual([(m.text, m.bpm) for m in score.tempo_marks], [(None, 120), ("rit.", 88)])
        self.assertTrue(any("rit." in n for n in rep.notes))

    def test_a_stand_in_instrument_does_not_warn_about_its_range(self):
        # 66 is a tenor sax: badmidi has no sax, so it sounds as the nearest reed
        score, _ = build_score(read_midi(smf([conductor(),
                                              notes_events(0, [(0, 4, 44), (4, 4, 80)], program=66, name="sax")])))
        self.assertEqual(score["sax"].program, 66)
        self.assertNotIn("WARN", score.check())
        exact, _ = build_score(read_midi(smf([conductor(),
                                              notes_events(0, [(0, 4, 30)], program=40, name="violin")])))
        self.assertIn("WARN", exact.check())          # a real violin can't play F#1

    def test_named_instrument_wins_among_equal_programs(self):
        self.assertEqual(instrument_for(52, "alto"), "alto")
        self.assertEqual(instrument_for(52, "sopranos"), "choir")

    def test_cli_import_writes_a_piece_that_rebuilds_the_score(self):
        import tempfile, contextlib, io
        from badmidi.cli import main
        data = smf([conductor(), notes_events(0, [(0, 1, 60), (1, 1, 62), (2, 2, 64)], name="tune")])
        with tempfile.TemporaryDirectory() as d:
            mid = Path(d) / "tune.mid"
            mid.write_bytes(data)
            with contextlib.redirect_stdout(io.StringIO()) as out:
                main(["import", str(mid)])
            self.assertIn("wrote", out.getvalue())
            piece = load_score(str(Path(d) / "tune.py"))
            direct = load_score(str(mid))
            self.assertEqual(cells(piece, "tune"), cells(direct, "tune"))
            self.assertEqual(cells(piece, "tune"), ["C4.q D4.q E4.h"])

    def test_layering_on_a_loaded_file(self):
        data = smf([conductor(), notes_events(0, [(q, 1, 60 + q % 8) for q in range(16)], name="melody")])
        src = read_midi(data)
        score = score_from_source(src)
        score.part("harmony", "viola").at(1, "E3.w | F3.w | G3.w | C3.w |5")
        score["melody"].clear(2, 3).at(2, "G4.w | E4.w |4")
        self.assertFalse(has_errors(score), score.check())
        self.assertEqual(cells(score, "melody")[1:3], ["G4.w", "E4.w"])
        self.assertEqual(cells(score, "melody")[3], "E4.q F4.q Fs4.q G4.q")


if __name__ == "__main__":
    unittest.main()
