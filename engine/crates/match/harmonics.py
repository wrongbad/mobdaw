"""Harmonic levels (dB re the strongest, h1..h16) of the held part of <dir>/<key>_dry_{target,best}.wav for keys 55/62/69.
usage: python3 -I harmonics.py <run dir>/<program>"""
import sys, wave, numpy as np
def rd(p):
    w = wave.open(p); return np.frombuffer(w.readframes(w.getnframes()), np.int16)/32768.0
def harmonics(x, key, H=16):
    f0 = 440*2**((key-69)/12); n = 16384; sr = 44100
    seg = x[int(0.3*sr):int(0.3*sr)+n]
    P = np.abs(np.fft.rfft(seg*np.hanning(n)))**2; f = np.arange(len(P))*sr/n
    hs = [P[(np.abs(f-k*f0) < 0.03*k*f0+5)].max() for k in range(1, H+1)]
    hs = 10*np.log10(np.array(hs)/max(hs))
    return hs
d = sys.argv[1]
for key in [55, 62, 69]:
    for kind in ["dry_target", "dry_best"]:
        h = harmonics(rd(f"{d}/{key}_{kind}.wav"), key)
        print(f"{key} {kind:10s} " + " ".join(f"{v:4.0f}" for v in h))
    print()
