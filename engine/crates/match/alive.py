"""Noise between harmonics (4 bands), pitch jitter and amplitude shimmer of the held part, target vs best, per program.
usage: python3 -I alive.py <run dir>"""
import sys, wave, glob, os, numpy as np
sr = 44100
def rd(p):
    w = wave.open(p); return np.frombuffer(w.readframes(w.getnframes()), np.int16)/32768.0
def contour(x, key, n=2048, hop=128):
    per = sr/(440*2**((key-69)/12)); lo, hi = int(per*0.9), int(per*1.1)+1
    out = []
    for s in range(int(0.3*sr), int(1.1*sr)-n, hop):
        f = x[s:s+n]; ac = np.array([np.dot(f[:n-l], f[l:]) for l in range(lo-1, hi+2)])
        i = int(np.argmax(ac[1:-1]))+1; a, b, c = ac[i-1], ac[i], ac[i+1]
        lag = lo-1+i + 0.5*(a-c)/(a-2*b+c)
        out.append(1200*np.log2(per/lag))
    return np.array(out)
def hp_contour(c, hop=128, fc=12.0):
    # remove vibrato/drift: subtract a moving average ~1/fc s long
    w = max(3, int(sr/hop/fc)); k = np.ones(w)/w
    return (c - np.convolve(c, k, 'same'))[w:-w]
def jitter(x, key): return np.std(hp_contour(contour(x, key)))
def shimmer(x):
    c = 441; seg = x[int(0.3*sr):int(1.1*sr)]
    e = 20*np.log10(np.sqrt([np.mean(seg[i:i+c]**2) for i in range(0, len(seg)-c, c)])+1e-9)
    w = 9; return np.std((e - np.convolve(e, np.ones(w)/w, 'same'))[w:-w])
def noise_bands(x, key):
    f0 = 440*2**((key-69)/12); n = 8192; seg = x[int(0.3*sr):int(1.1*sr)]
    P = np.mean([np.abs(np.fft.rfft(seg[i:i+n]*np.hanning(n)))**2 for i in range(0, len(seg)-n, n//4)], 0)
    f = np.arange(len(P))*sr/n; tot = P[(f>80)&(f<12000)].sum()
    harm = np.zeros_like(P, bool)
    for k in range(1, int(16000/f0)+1): harm |= np.abs(f-k*f0) < f0*0.2
    edges = [100, 500, 1500, 4000, 12000]
    return [10*np.log10(P[(f>=a)&(f<b)&~harm].sum()/tot+1e-12) for a, b in zip(edges, edges[1:])]
run = sys.argv[1]
print("noise between harmonics, dB re total, bands 0.1-0.5 / 0.5-1.5 / 1.5-4 / 4-12 kHz; jitter cents rms (>12 Hz); shimmer dB rms (>~11 Hz)")
for name in ["clarinet", "alto-sax", "flute", "cello", "violin"]:
    d = f"{run}/{name}"
    if not os.path.isdir(d): continue
    for kind in ["target", "best"]:
        fs = sorted(glob.glob(f"{d}/*_dry_{kind}.wav")); keys = [int(os.path.basename(p).split('_')[0]) for p in fs]; xs = [rd(p) for p in fs]
        nb = np.mean([noise_bands(x, k) for x, k in zip(xs, keys)], 0)
        print(f"{name:9s} {kind:6s} noise {' '.join(f'{v:6.1f}' for v in nb)}   jitter {np.mean([jitter(x,k) for x,k in zip(xs,keys)]):5.2f}   shimmer {np.mean([shimmer(x) for x in xs]):5.2f}")
