"""HNR (dB) of the held part of each <key>_dry_{target,best}.wav: harmonic bins (±4% of f0, vibrato smear) vs the rest,
80 Hz-8 kHz. usage: python3 -I hnr.py <run dir>..."""
import sys, wave, glob, os, numpy as np
def rd(p):
    w = wave.open(p); return np.frombuffer(w.readframes(w.getnframes()), np.int16)/32768.0
def hnr(x, key):
    f0 = 440*2**((key-69)/12); n = 8192; sr = 44100
    seg = x[int(0.3*sr):int(1.1*sr)]
    fr = [np.abs(np.fft.rfft(seg[i:i+n]*np.hanning(n)))**2 for i in range(0, len(seg)-n, n//2)]
    P = np.mean(fr, 0); f = np.arange(len(P))*sr/n
    m = (f > 80) & (f < 8000)
    h = np.zeros_like(P, bool)
    for k in range(1, int(8000/f0)+1):
        h |= np.abs(f - k*f0) < max(0.03*f0*k**0, 2.5*sr/n) + f0*0.04  # allow vibrato smear
    return 10*np.log10(P[m & h].sum()/P[m & ~h].sum())
for run in sys.argv[1:]:
    for d in sorted(glob.glob(f"{run}/*/")):
        name = os.path.basename(d[:-1]); out = []
        for kind in ["dry_target", "dry_best"]:
            v = [hnr(rd(fp), int(os.path.basename(fp).split('_')[0])) for fp in sorted(glob.glob(f"{d}*_{kind}.wav"))]
            out.append(np.mean(v))
        print(f"{os.path.basename(run):28s} {name:9s} HNR target {out[0]:5.1f} dB  fit {out[1]:5.1f} dB")
