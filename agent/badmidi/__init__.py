"""badmidi: music as code.

    from badmidi import *

    theme  = M(E4.q, G4.e, A4.e, B4.h)
    answer = theme.invert(around=A4).transpose(5)

    score = Score("Sketch", meter=(4, 4), tempo=80, key="E minor")
    score.part("violin").at(1, theme, answer)
    print(score.melody())
"""
from .analysis import interval_vector, normal_order, observe, prime_form, set_label, stretti
from .core import (ARTICULATIONS, BAR, CRESC, DIM, DURATIONS, DYNAMICS, HAIRPIN_END,
                   PED, PED_UP, Bar, Chord, Event, M, Mark, Motif, Note, Pitch, R, as_pitch, duration,
                   dyn, isorhythm, spelling, text)
from .ingest import (ImportReport, Source, SourceNote, SourceTrack, build_score, import_midi,
                     load_midi, score_from_source)
from .musicxml import import_musicxml, load_musicxml
from .notes import *  # noqa: F401,F403  C4, Fs4, Bb3, ...
from .notes import __all__ as _note_names
from .scale import MODES, Scale, key
from .score import INSTRUMENTS, Meter, Part, Score
from .source import to_source, write_source

__all__ = ["ARTICULATIONS", "BAR", "Bar", "CRESC", "Chord", "DIM", "DURATIONS", "DYNAMICS", "Event",
           "HAIRPIN_END", "INSTRUMENTS", "M", "MODES", "Mark", "Meter", "Motif", "PED", "PED_UP",
           "dyn", "text", "Note", "Part", "Pitch", "R", "Scale", "Score", "as_pitch",
           "duration", "interval_vector", "isorhythm", "key", "normal_order", "observe", "prime_form",
           "set_label", "spelling", "stretti",
           "ImportReport", "Source", "SourceNote", "SourceTrack", "build_score", "import_midi", "load_midi",
           "import_musicxml", "load_musicxml", "score_from_source", "to_source", "write_source",
           *_note_names]
