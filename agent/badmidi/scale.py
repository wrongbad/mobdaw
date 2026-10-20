"""Scales and keys: diatonic stepping, key signatures, spelling, scale degrees."""
from __future__ import annotations

import re

from .core import LETTERS, Pitch, pc_name

MODES: dict[str, tuple[int, ...]] = {
    "major": (0, 2, 4, 5, 7, 9, 11),
    "dorian": (0, 2, 3, 5, 7, 9, 10),
    "phrygian": (0, 1, 3, 5, 7, 8, 10),
    "lydian": (0, 2, 4, 6, 7, 9, 11),
    "mixolydian": (0, 2, 4, 5, 7, 9, 10),
    "minor": (0, 2, 3, 5, 7, 8, 10),
    "locrian": (0, 1, 3, 5, 6, 8, 10),
    "harmonic minor": (0, 2, 3, 5, 7, 8, 11),
    "melodic minor": (0, 2, 3, 5, 7, 9, 11),
}
ALIASES = {"ionian": "major", "aeolian": "minor", "maj": "major", "min": "minor", "m": "minor"}
# Semitones from the parent major key's tonic, for key signatures.
PARENT_OFFSET = {"major": 0, "dorian": 2, "phrygian": 4, "lydian": 5, "mixolydian": 7,
                 "minor": 9, "locrian": 11, "harmonic minor": 9, "melodic minor": 9}
MINOR_MODES = {"minor", "harmonic minor", "melodic minor"}
LETTER_ORDER = "CDEFGAB"


class Scale:
    """A tonic plus a mode. Pass one to transpose/invert/sequence to work in
    scale steps instead of semitones:  theme.transpose(2, scale=key("E minor"))"""

    def __init__(self, tonic: str | int, mode: str = "major"):
        mode = ALIASES.get(mode.lower().strip(), mode.lower().strip())
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r}; known: {', '.join(MODES)}")
        spelled = ""
        if isinstance(tonic, str):
            m = re.fullmatch(r"([A-Ga-g])([#sb]?)", tonic.strip())
            if not m:
                raise ValueError(f"can't parse tonic {tonic!r}")
            spelled = m.group(2)
            pc = (LETTERS[m.group(1).upper()] + {"": 0, "#": 1, "s": 1, "b": -1}[spelled]) % 12
        else:
            pc = int(tonic) % 12
        self.tonic = pc
        self.mode = mode
        self.steps = MODES[mode]
        parent = (pc - PARENT_OFFSET[mode]) % 12
        sig = (parent * 7) % 12  # sharps in the parent major key
        if sig > 6 or (spelled == "b" and sig > 0):
            sig -= 12
        if spelled in ("#", "s") and sig < 0:
            sig += 12
        self.signature = sig  # >0 sharps, <0 flats
        self.tonic_name = (m.group(1).upper() + spelled.replace("s", "#")) if isinstance(tonic, str) \
            else pc_name(pc, sig < 0)
        self.names = self._spelling_table()

    def _spelling_table(self) -> list[str]:
        """How to spell each of the 12 pitch classes in this key. Scale notes
        get consecutive letters from the tonic; the rest are the usual
        chromatic alterations: in minor the raised 3rd/4th/6th/7th (E, F#, A, B
        in C minor), in major the flat 2/3/6/7 and sharp 4."""
        li = LETTER_ORDER.index(self.tonic_name[0])

        def spell(k: int, pc: int) -> str:
            letter = LETTER_ORDER[(li + k) % 7]
            alter = (pc - LETTERS[letter] + 6) % 12 - 6
            return letter + ("#" * alter if alter > 0 else "b" * -alter)

        names: list[str | None] = [None] * 12
        for k, st in enumerate(self.steps):
            names[(self.tonic + st) % 12] = spell(k, (self.tonic + st) % 12)
        minorish = self.steps[2] == 3
        for r in range(12):
            pc = (self.tonic + r) % 12
            if names[pc]:
                continue
            below = [k for k, st in enumerate(self.steps) if st == r - 1]
            above = [k for k, st in enumerate(self.steps) if st == r + 1]
            sharp = bool(below) and (r == 6 or (minorish and r != 1) or not above)
            names[pc] = spell(below[0] if sharp else above[0], pc)
        return names  # type: ignore[return-value]

    @property
    def flats(self) -> bool:
        return self.signature < 0

    @property
    def minor(self) -> bool:
        return self.mode in MINOR_MODES

    @property
    def name(self) -> str:
        return f"{self.tonic_name} {self.mode}"

    def __repr__(self) -> str:
        return f"key({self.name!r})"

    def __contains__(self, p) -> bool:
        pc = p.pc if isinstance(p, Pitch) else int(p)
        return (pc - self.tonic) % 12 in self.steps

    def index(self, p: Pitch) -> tuple[int, int]:
        """Absolute diatonic index of a pitch (7 per octave) and its chromatic alteration."""
        octave, r = divmod(p.midi - self.tonic, 12)
        i = max(k for k, s in enumerate(self.steps) if s <= r)
        return octave * len(self.steps) + i, r - self.steps[i]

    def at(self, index: int, alter: int = 0) -> Pitch:
        octave, i = divmod(index, len(self.steps))
        midi = self.tonic + 12 * octave + self.steps[i] + alter
        return Pitch(midi, self.names[midi % 12])        # spelled as this scale spells it

    def step(self, p: Pitch, n: int) -> Pitch:
        """Move a pitch n scale steps (keeping any chromatic alteration)."""
        i, alter = self.index(p)
        return self.at(i + n, alter)

    def degree(self, pc: int) -> tuple[int, int]:
        """Scale degree (0 = tonic) of a pitch class, and its alteration, for
        roman numerals. In minor keys the raised 7th counts as degree 7."""
        r = (pc - self.tonic) % 12
        steps = MODES["minor"] if self.minor else self.steps
        if r in steps:
            return steps.index(r), 0
        if self.minor and r == 11:
            return 6, 0
        if r == 6 and not self.minor:
            return 3, 1  # #IV
        for k, s in enumerate(steps):  # otherwise prefer flat-from-above (bII, bVI, ...)
            if s == r + 1:
                return k, -1
        return max(k for k, s in enumerate(steps) if s < r), 1


def key(spec: str | Scale) -> Scale:
    """key("E minor"), key("Bb major"), key("F# dorian"), key("Em"), key("G")."""
    if isinstance(spec, Scale):
        return spec
    parts = spec.strip().split(None, 1)
    if not parts:
        raise ValueError("empty key")
    tonic, mode = parts[0], parts[1] if len(parts) > 1 else "major"
    if len(parts) == 1 and len(tonic) > 1 and tonic.endswith("m"):
        tonic, mode = tonic[:-1], "minor"
    return Scale(tonic, mode)
