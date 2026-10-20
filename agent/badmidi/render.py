"""Audio rendering through FluidSynth and a General MIDI soundfont."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from .midi import write_midi
from .score import Score

SOUNDFONT_CANDIDATES = [
    "/Applications/MuseScore 4.app/Contents/Resources/sound/MS Basic.sf3",
    "/Applications/MuseScore 3.app/Contents/Resources/sound/MuseScore_General.sf3",
    "/usr/share/sounds/sf2/FluidR3_GM.sf2",
    "/usr/share/soundfonts/FluidR3_GM.sf2",
]


def find_soundfont() -> str:
    env = os.environ.get("BADMIDI_SOUNDFONT")
    if env:
        return env
    for path in SOUNDFONT_CANDIDATES:
        if os.path.exists(path):
            return path
    raise FileNotFoundError("no General MIDI soundfont found; set BADMIDI_SOUNDFONT=/path/to/font.sf2")


def render_wav(score: Score, path: str, soundfont: str | None = None) -> None:
    exe = shutil.which("fluidsynth")
    if not exe:
        raise FileNotFoundError("fluidsynth not found (brew install fluid-synth)")
    sf = soundfont or find_soundfont()
    with tempfile.TemporaryDirectory() as tmp:
        mid = os.path.join(tmp, "piece.mid")
        write_midi(score, mid)
        subprocess.run([exe, "-ni", "-q", "-g", "0.8", "-r", "44100", "-F", path, sf, mid],
                       check=True, capture_output=True)
