"""Standard MIDI File (format 1) writer. No dependencies.

Playback decisions (velocities, tempo changes, pedal) come from perform.py.
"""
from __future__ import annotations

from fractions import Fraction

from . import perform
from .score import Score

PPQ = 960  # ticks per quarter note; divisible by 3 and 5, so triplets and quintuplets are exact


def _vlq(n: int) -> bytes:
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def _meta(kind: int, data: bytes) -> bytes:
    return bytes([0xFF, kind]) + _vlq(len(data)) + data


def _track(events: list[tuple[int, int, bytes]]) -> bytes:
    """events: (tick, order-within-tick, message). Lower order sorts first:
    controller and note-off messages go before note-ons at the same tick."""
    body, last = bytearray(), 0
    for tick, _, msg in sorted(events, key=lambda e: (e[0], e[1])):
        body += _vlq(tick - last) + msg
        last = tick
    body += _vlq(0) + _meta(0x2F, b"")
    return b"MTrk" + len(body).to_bytes(4, "big") + bytes(body)


def _time_signature(m) -> bytes | None:
    """A time-signature meta event; a free bar gets the plain signature of its
    length (11 quarters -> 11/4) if it has one."""
    num, den = m.num, m.den
    if m.free is not None:
        den = next((d for d in (4, 8, 16, 32) if (m.free * d / 4).denominator == 1), None)
        if den is None or m.free * den / 4 > 255:
            return None
        num = int(m.free * den / 4)
    return _meta(0x58, bytes([num, den.bit_length() - 1, 24, 8]))


def midi_bytes(score: Score) -> bytes:
    conductor = [
        (0, 0, _meta(0x03, (score.title or "badmidi").encode())),
        (0, 0, _meta(0x59, bytes([score.key.signature & 0xFF, 1 if score.key.minor else 0]))),
    ]
    for bar, m in score.meter_changes(score.bars):
        sig = _time_signature(m)
        if sig:
            conductor.append((round(score.bar_start(bar) * PPQ), 0, sig))
    for t, bpm in perform.tempo_map(score):
        conductor.append((round(t * PPQ), 1, _meta(0x51, round(60_000_000 / bpm).to_bytes(3, "big"))))
    tracks = [_track(conductor)]

    # one MIDI channel per part.channel (a piano's hands share one), skipping GM percussion
    free = [c for c in range(16) if c != 9]
    keys = list(dict.fromkeys(p.channel for p in score.parts if not p.drums))
    channel_of = {k: free[i % len(free)] for i, k in enumerate(keys)}
    drum_keys = [p.channel for p in score.parts if p.drums]
    channel_of.update({k: 9 for k in drum_keys})
    keys += [k for k in dict.fromkeys(drum_keys)]
    n = len(keys)

    for part in score.parts:
        ch = channel_of[part.channel]
        first_in_channel = next(p for p in score.parts if p.channel == part.channel) is part
        at = perform.warp(part)           # this part's playback clock (drift)
        evs = [(0, 0, _meta(0x03, part.name.encode()))]
        if first_in_channel and part.drums:
            pass                          # the GM kit: no program change, fixed channel
        elif first_in_channel:
            i = keys.index(part.channel)
            pan = part.pan if part.pan is not None else (64 if n == 1 else round(34 + 60 * i / (n - 1)))
            evs += [(0, 0, bytes([0xC0 | ch, part.program])), (0, 0, bytes([0xB0 | ch, 10, pan]))]
            for t, value in perform.pedal_events(part):
                evs.append((round(at(t) * PPQ), 0, bytes([0xB0 | ch, 64, value])))
        for t, _, program in part.registrations:
            if program is not None:
                evs.append((round(at(t) * PPQ), 0, bytes([0xC0 | ch, program])))
        dyn = perform.Dynamics(part)
        for t, note in part.events():
            if note.is_rest:
                continue
            on = round(at(t) * PPQ)
            off = round(at(t + perform.sounding_dur(note)) * PPQ)
            vel = perform.velocity(dyn, part, t, note)
            for m in sorted({p.midi + c for p in note.pitches for c in part.couplers if 0 <= p.midi + c < 128}):
                evs.append((on, 2, bytes([0x90 | ch, m, vel])))
                evs.append((off, 1, bytes([0x80 | ch, m, 0])))
        tracks.append(_track(evs))
    header = (b"MThd" + (6).to_bytes(4, "big") + (1).to_bytes(2, "big")
              + len(tracks).to_bytes(2, "big") + PPQ.to_bytes(2, "big"))
    return header + b"".join(tracks)


def write_midi(score: Score, path: str) -> None:
    with open(path, "wb") as f:
        f.write(midi_bytes(score))


# --- reading -------------------------------------------------------------------


def _vlq_at(data: bytes, pos: int) -> tuple[int, int]:
    n = 0
    while True:
        b = data[pos]
        pos += 1
        n = (n << 7) | (b & 0x7F)
        if b < 0x80:
            return n, pos


def _read_events(data: bytes):
    """Parse a Standard MIDI File into (format, ticks per quarter, tracks); each
    track is a list of (tick, status, payload) in file order. A channel message
    has its status byte and the data bytes; a meta event has status 0xFF and
    (type, bytes); sysex is status 0xF0 with its bytes. Running status works."""
    if data[:4] != b"MThd":
        raise ValueError("not a MIDI file")
    fmt = int.from_bytes(data[8:10], "big")
    ntracks = int.from_bytes(data[10:12], "big")
    ppq = int.from_bytes(data[12:14], "big")
    if ppq & 0x8000:
        raise ValueError("MIDI files timed in SMPTE frames are not supported")
    pos, tracks = 14, []
    for _ in range(ntracks):
        if data[pos:pos + 4] != b"MTrk":
            raise ValueError("bad track header")
        end = pos + 8 + int.from_bytes(data[pos + 4:pos + 8], "big")
        pos += 8
        tick, status, events = 0, 0, []
        while pos < end:
            delta, pos = _vlq_at(data, pos)
            tick += delta
            if data[pos] >= 0x80:
                status = data[pos]
                pos += 1
            if status == 0xFF:
                kind = data[pos]
                length, pos = _vlq_at(data, pos + 1)
                events.append((tick, 0xFF, (kind, data[pos:pos + length])))
                pos += length
            elif status in (0xF0, 0xF7):
                length, pos = _vlq_at(data, pos)
                events.append((tick, 0xF0, data[pos:pos + length]))
                pos += length
            else:
                n = 1 if status & 0xF0 in (0xC0, 0xD0) else 2
                events.append((tick, status, tuple(data[pos:pos + n])))
                pos += n
        tracks.append(events)
        pos = end
    return fmt, ppq, tracks


def read_notes(data: bytes) -> list[tuple[Fraction, int, Fraction]]:
    """(onset, pitch, duration) for every note in a Standard MIDI File, times in
    quarter notes. Used to prove an engraving contains exactly the score's notes."""
    _, ppq, tracks = _read_events(data)
    notes = []
    for events in tracks:
        sounding = {}
        for tick, status, p in events:
            kind = status & 0xF0
            if status >= 0xF0 or kind not in (0x80, 0x90):
                continue
            k = (status & 0x0F, p[0])
            if kind == 0x90 and p[1] > 0:
                sounding.setdefault(k, []).append(tick)
            elif sounding.get(k):
                on = sounding[k].pop(0)
                notes.append((Fraction(on, ppq), p[0], Fraction(tick - on, ppq)))
    return sorted(notes)


_MAJOR_TONICS = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"]
_MINOR_TONICS = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"]


def _text(raw: bytes) -> str:
    try:
        return raw.decode("utf-8").strip()
    except UnicodeDecodeError:
        return raw.decode("latin-1").strip()


def read_midi(data: bytes, title: str = ""):
    """A Standard MIDI File as an ingest.Source, ready for build_score.

    One SourceTrack per (track, channel) that has notes (so a format 0 file, or
    a track mixing channels, splits by channel); program changes, sustain
    pedal (CC 64, as PED / PED_UP marks) and note velocities come along. Tempo,
    time signature, key signature and markers (meta 0x06, 0x07, and text 0x01
    in tracks without notes) go to the Source. `title` is used when the file
    names none (the name of a note-less first track, or of a format 0 file)."""
    from .core import PED, PED_UP
    from .ingest import Source, SourceNote, SourceTrack
    from .scale import key as parse_key

    fmt, ppq, tracks = _read_events(data)

    def T(tick: int) -> Fraction:
        return Fraction(tick, ppq)

    src = Source(title=title)
    tempos, meters, markers = {}, {}, []
    for ti, events in enumerate(tracks):
        name, text_events = "", []
        chans: dict[int, dict] = {}

        def chan(c: int) -> dict:
            return chans.setdefault(c, dict(notes=[], on={}, program=None, seen=None, marks=[], pedal=False))
        for tick, status, p in events:
            if status == 0xFF:
                kind, raw = p
                if kind == 0x03 and not name:
                    name = _text(raw)
                elif kind in (0x06, 0x07) and _text(raw):
                    markers.append((T(tick), _text(raw)))
                elif kind == 0x01 and _text(raw):
                    text_events.append((T(tick), _text(raw)))
                elif kind == 0x51 and len(raw) == 3:
                    tempos[T(tick)] = round(60_000_000 / int.from_bytes(raw, "big"), 3)
                elif kind == 0x58 and len(raw) >= 2:
                    meters[T(tick)] = (raw[0], 1 << raw[1])
                elif kind == 0x59 and len(raw) == 2 and src.key is None:
                    sf = raw[0] - 256 if raw[0] > 127 else raw[0]
                    if -7 <= sf <= 7:
                        tonics = _MINOR_TONICS if raw[1] else _MAJOR_TONICS
                        src.key = parse_key(f"{tonics[sf + 7]} {'minor' if raw[1] else 'major'}")
                continue
            if status >= 0xF0:
                continue
            kind, c = status & 0xF0, status & 0x0F
            if kind == 0xC0:
                chan(c)["seen"] = p[0]
            elif kind == 0xB0 and p[0] == 64:
                st = chan(c)
                if (p[1] >= 64) != st["pedal"]:
                    st["pedal"] = p[1] >= 64
                    st["marks"].append((T(tick), PED if st["pedal"] else PED_UP))
            elif kind in (0x80, 0x90):
                st = chan(c)
                if kind == 0x90 and p[1] > 0:
                    if st["program"] is None:
                        st["program"] = st["seen"] if st["seen"] is not None else -1
                    st["on"].setdefault(p[0], []).append((tick, p[1]))
                elif st["on"].get(p[0]):
                    on, vel = st["on"][p[0]].pop(0)
                    if tick > on:
                        st["notes"].append(SourceNote(T(on), T(tick - on), p[0], vel))
        last = events[-1][0] if events else 0
        for st in chans.values():                       # notes never released end with the track
            for pitch, ons in st["on"].items():
                st["notes"] += [SourceNote(T(on), T(last - on), pitch, vel) for on, vel in ons if last > on]
        playing = sorted(c for c, st in chans.items() if st["notes"])
        if not playing:
            if ti == 0 and fmt == 1 and name and not src.title:
                src.title = name
            markers += text_events
            continue
        if fmt == 0 and name and not src.title:
            src.title = name
        for c in playing:
            st = chans[c]
            label = name if len(playing) == 1 else (f"{name} {c + 1}" if name and fmt == 1 else f"channel {c + 1}")
            st["notes"].sort(key=lambda n: (n.onset, n.midi))
            src.tracks.append(SourceTrack(label, None if st["program"] in (None, -1) else st["program"],
                                          st["notes"], st["marks"], channel=c))
    src.tempos = sorted(tempos.items())
    src.meters = sorted((t, n, d) for t, (n, d) in meters.items())
    src.markers = sorted(dict.fromkeys(markers), key=lambda m: m[0])
    return src
