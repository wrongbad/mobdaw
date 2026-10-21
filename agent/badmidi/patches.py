"""Named sounds for new tracks: a device type and its params, sent by `badmidi push --patch NAME`.

A patch becomes `addTrack {preset: "none"}` plus `addDevice {trackId: "$N", type, params}` in the same batch (an addTrack
with a preset returns the track's id, not its device's, so the params go in the addDevice). Param names are the device's
(`/catalog`; shared/src/devices.ts).

The values are chosen from the DSP (engine/crates/dsp/src/finnwave.rs, synth.rs), not by ear: they want a listening pass.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Patch:
    device: str
    params: dict[str, float] = field(default_factory=dict)
    about: str = ""


# finnwave has no filter, vibrato or mono switch: its tone is `rolloff` (harmonic k is e^-kb) and the envelope, which also
# darkens the note (b = rolloff + env->rolloff * (1 - env)). Rolloff 0.5 leaves the 2nd harmonic at 0.6 and the 4th at 0.14
# of the fundamental: round, a little reedy at the attack, mellowing as the note decays to its sustain.
PATCHES: dict[str, Patch] = {
    "bass": Patch("finnwave", {"rolloff": 0.5, "env→rolloff": 0.5, "attack": 3, "decay": 180, "sustain": 0.5,
                               "release": 90, "gain": 0.8},
                  "round electric bass: 3 ms attack, 180 ms decay to half level, short release, dark and mellowing"),
}


def get(name: str) -> Patch:
    if name not in PATCHES:
        raise ValueError(f"unknown patch {name!r}; known: {', '.join(PATCHES)}")
    return PATCHES[name]


def device_op(name: str, track_ref: str) -> dict:
    """The addDevice op that gives the track (an id, or "$N" for an addTrack earlier in the batch) the patch's sound."""
    p = get(name)
    return {"op": "addDevice", "trackId": track_ref, "type": p.device, "name": name, "params": dict(p.params)}
