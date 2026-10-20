"""Note-name constants: C4 is middle C (MIDI 60). s = sharp, b = flat.

Written out explicitly (not generated at import) so editors and readers
can see every name.
"""
from .core import Pitch

C0 = Pitch(12); Cs0 = Pitch(13, "C#"); Cb0 = Pitch(11, "Cb")
D0 = Pitch(14); Ds0 = Pitch(15, "D#"); Db0 = Pitch(13, "Db")
E0 = Pitch(16); Es0 = Pitch(17, "E#"); Eb0 = Pitch(15, "Eb")
F0 = Pitch(17); Fs0 = Pitch(18, "F#"); Fb0 = Pitch(16, "Fb")
G0 = Pitch(19); Gs0 = Pitch(20, "G#"); Gb0 = Pitch(18, "Gb")
A0 = Pitch(21); As0 = Pitch(22, "A#"); Ab0 = Pitch(20, "Ab")
B0 = Pitch(23); Bs0 = Pitch(24, "B#"); Bb0 = Pitch(22, "Bb")

C1 = Pitch(24); Cs1 = Pitch(25, "C#"); Cb1 = Pitch(23, "Cb")
D1 = Pitch(26); Ds1 = Pitch(27, "D#"); Db1 = Pitch(25, "Db")
E1 = Pitch(28); Es1 = Pitch(29, "E#"); Eb1 = Pitch(27, "Eb")
F1 = Pitch(29); Fs1 = Pitch(30, "F#"); Fb1 = Pitch(28, "Fb")
G1 = Pitch(31); Gs1 = Pitch(32, "G#"); Gb1 = Pitch(30, "Gb")
A1 = Pitch(33); As1 = Pitch(34, "A#"); Ab1 = Pitch(32, "Ab")
B1 = Pitch(35); Bs1 = Pitch(36, "B#"); Bb1 = Pitch(34, "Bb")

C2 = Pitch(36); Cs2 = Pitch(37, "C#"); Cb2 = Pitch(35, "Cb")
D2 = Pitch(38); Ds2 = Pitch(39, "D#"); Db2 = Pitch(37, "Db")
E2 = Pitch(40); Es2 = Pitch(41, "E#"); Eb2 = Pitch(39, "Eb")
F2 = Pitch(41); Fs2 = Pitch(42, "F#"); Fb2 = Pitch(40, "Fb")
G2 = Pitch(43); Gs2 = Pitch(44, "G#"); Gb2 = Pitch(42, "Gb")
A2 = Pitch(45); As2 = Pitch(46, "A#"); Ab2 = Pitch(44, "Ab")
B2 = Pitch(47); Bs2 = Pitch(48, "B#"); Bb2 = Pitch(46, "Bb")

C3 = Pitch(48); Cs3 = Pitch(49, "C#"); Cb3 = Pitch(47, "Cb")
D3 = Pitch(50); Ds3 = Pitch(51, "D#"); Db3 = Pitch(49, "Db")
E3 = Pitch(52); Es3 = Pitch(53, "E#"); Eb3 = Pitch(51, "Eb")
F3 = Pitch(53); Fs3 = Pitch(54, "F#"); Fb3 = Pitch(52, "Fb")
G3 = Pitch(55); Gs3 = Pitch(56, "G#"); Gb3 = Pitch(54, "Gb")
A3 = Pitch(57); As3 = Pitch(58, "A#"); Ab3 = Pitch(56, "Ab")
B3 = Pitch(59); Bs3 = Pitch(60, "B#"); Bb3 = Pitch(58, "Bb")

C4 = Pitch(60); Cs4 = Pitch(61, "C#"); Cb4 = Pitch(59, "Cb")
D4 = Pitch(62); Ds4 = Pitch(63, "D#"); Db4 = Pitch(61, "Db")
E4 = Pitch(64); Es4 = Pitch(65, "E#"); Eb4 = Pitch(63, "Eb")
F4 = Pitch(65); Fs4 = Pitch(66, "F#"); Fb4 = Pitch(64, "Fb")
G4 = Pitch(67); Gs4 = Pitch(68, "G#"); Gb4 = Pitch(66, "Gb")
A4 = Pitch(69); As4 = Pitch(70, "A#"); Ab4 = Pitch(68, "Ab")
B4 = Pitch(71); Bs4 = Pitch(72, "B#"); Bb4 = Pitch(70, "Bb")

C5 = Pitch(72); Cs5 = Pitch(73, "C#"); Cb5 = Pitch(71, "Cb")
D5 = Pitch(74); Ds5 = Pitch(75, "D#"); Db5 = Pitch(73, "Db")
E5 = Pitch(76); Es5 = Pitch(77, "E#"); Eb5 = Pitch(75, "Eb")
F5 = Pitch(77); Fs5 = Pitch(78, "F#"); Fb5 = Pitch(76, "Fb")
G5 = Pitch(79); Gs5 = Pitch(80, "G#"); Gb5 = Pitch(78, "Gb")
A5 = Pitch(81); As5 = Pitch(82, "A#"); Ab5 = Pitch(80, "Ab")
B5 = Pitch(83); Bs5 = Pitch(84, "B#"); Bb5 = Pitch(82, "Bb")

C6 = Pitch(84); Cs6 = Pitch(85, "C#"); Cb6 = Pitch(83, "Cb")
D6 = Pitch(86); Ds6 = Pitch(87, "D#"); Db6 = Pitch(85, "Db")
E6 = Pitch(88); Es6 = Pitch(89, "E#"); Eb6 = Pitch(87, "Eb")
F6 = Pitch(89); Fs6 = Pitch(90, "F#"); Fb6 = Pitch(88, "Fb")
G6 = Pitch(91); Gs6 = Pitch(92, "G#"); Gb6 = Pitch(90, "Gb")
A6 = Pitch(93); As6 = Pitch(94, "A#"); Ab6 = Pitch(92, "Ab")
B6 = Pitch(95); Bs6 = Pitch(96, "B#"); Bb6 = Pitch(94, "Bb")

C7 = Pitch(96); Cs7 = Pitch(97, "C#"); Cb7 = Pitch(95, "Cb")
D7 = Pitch(98); Ds7 = Pitch(99, "D#"); Db7 = Pitch(97, "Db")
E7 = Pitch(100); Es7 = Pitch(101, "E#"); Eb7 = Pitch(99, "Eb")
F7 = Pitch(101); Fs7 = Pitch(102, "F#"); Fb7 = Pitch(100, "Fb")
G7 = Pitch(103); Gs7 = Pitch(104, "G#"); Gb7 = Pitch(102, "Gb")
A7 = Pitch(105); As7 = Pitch(106, "A#"); Ab7 = Pitch(104, "Ab")
B7 = Pitch(107); Bs7 = Pitch(108, "B#"); Bb7 = Pitch(106, "Bb")

C8 = Pitch(108); Cs8 = Pitch(109, "C#"); Cb8 = Pitch(107, "Cb")
D8 = Pitch(110); Ds8 = Pitch(111, "D#"); Db8 = Pitch(109, "Db")
E8 = Pitch(112); Es8 = Pitch(113, "E#"); Eb8 = Pitch(111, "Eb")
F8 = Pitch(113); Fs8 = Pitch(114, "F#"); Fb8 = Pitch(112, "Fb")
G8 = Pitch(115); Gs8 = Pitch(116, "G#"); Gb8 = Pitch(114, "Gb")
A8 = Pitch(117); As8 = Pitch(118, "A#"); Ab8 = Pitch(116, "Ab")
B8 = Pitch(119); Bs8 = Pitch(120, "B#"); Bb8 = Pitch(118, "Bb")

__all__ = [
    "C0", "Cs0", "Cb0", "D0", "Ds0", "Db0", "E0", "Es0", "Eb0", "F0", "Fs0", "Fb0",
    "G0", "Gs0", "Gb0", "A0", "As0", "Ab0", "B0", "Bs0", "Bb0", "C1", "Cs1", "Cb1",
    "D1", "Ds1", "Db1", "E1", "Es1", "Eb1", "F1", "Fs1", "Fb1", "G1", "Gs1", "Gb1",
    "A1", "As1", "Ab1", "B1", "Bs1", "Bb1", "C2", "Cs2", "Cb2", "D2", "Ds2", "Db2",
    "E2", "Es2", "Eb2", "F2", "Fs2", "Fb2", "G2", "Gs2", "Gb2", "A2", "As2", "Ab2",
    "B2", "Bs2", "Bb2", "C3", "Cs3", "Cb3", "D3", "Ds3", "Db3", "E3", "Es3", "Eb3",
    "F3", "Fs3", "Fb3", "G3", "Gs3", "Gb3", "A3", "As3", "Ab3", "B3", "Bs3", "Bb3",
    "C4", "Cs4", "Cb4", "D4", "Ds4", "Db4", "E4", "Es4", "Eb4", "F4", "Fs4", "Fb4",
    "G4", "Gs4", "Gb4", "A4", "As4", "Ab4", "B4", "Bs4", "Bb4", "C5", "Cs5", "Cb5",
    "D5", "Ds5", "Db5", "E5", "Es5", "Eb5", "F5", "Fs5", "Fb5", "G5", "Gs5", "Gb5",
    "A5", "As5", "Ab5", "B5", "Bs5", "Bb5", "C6", "Cs6", "Cb6", "D6", "Ds6", "Db6",
    "E6", "Es6", "Eb6", "F6", "Fs6", "Fb6", "G6", "Gs6", "Gb6", "A6", "As6", "Ab6",
    "B6", "Bs6", "Bb6", "C7", "Cs7", "Cb7", "D7", "Ds7", "Db7", "E7", "Es7", "Eb7",
    "F7", "Fs7", "Fb7", "G7", "Gs7", "Gb7", "A7", "As7", "Ab7", "B7", "Bs7", "Bb7",
    "C8", "Cs8", "Cb8", "D8", "Ds8", "Db8", "E8", "Es8", "Eb8", "F8", "Fs8", "Fb8",
    "G8", "Gs8", "Gb8", "A8", "As8", "Ab8", "B8", "Bs8", "Bb8",
]
