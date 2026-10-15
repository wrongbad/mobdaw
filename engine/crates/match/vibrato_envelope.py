"""Vibrato depth (cents) in 0.2 s windows from onset, per program, from <run>/<program>/<key>_dry_<kind>.wav.
usage: python3 -I vibrato_envelope.py <run dir> [target|best]"""
import sys, wave, numpy as np
def rd(p):
    w = wave.open(p); return np.frombuffer(w.readframes(w.getnframes()), np.int16)/32768.0
def contour(x, key, sr=44100, n=2048, hop=256):
    per = sr/(440*2**((key-69)/12)); lo, hi = int(per*0.92), int(per*1.08)+1
    out = []
    for s in range(0, int(1.2*sr)-n, hop):
        f = x[s:s+n]
        if np.sqrt(np.mean(f**2)) < 1e-3: out.append(np.nan); continue
        ac = [np.dot(f[:n-l], f[l:]) for l in range(lo, hi+1)]
        out.append(1200*np.log2(per/(lo+int(np.argmax(ac)))))
    return np.array(out)
run = sys.argv[1]; KIND = sys.argv[2] if len(sys.argv) > 2 else "target"
for name, keys in [("violin",[60,69,79]),("cello",[41,52,62]),("alto-sax",[57,64,71]),("flute",[67,74,81])]:
    rows = []
    for k in keys:
        c = contour(rd(f"{run}/{name}/{k}_dry_{KIND}.wav"), k)
        t = np.arange(len(c))*256/44100
        rows.append([np.nanstd(c[(t>=a)&(t<a+0.2)])*np.sqrt(2) for a in np.arange(0, 1.0, 0.2)])
    r = np.nanmean(rows, 0)
    print(f"{name:9s} {KIND:6s} vibrato depth (cents) in 0.2 s windows from onset: " + "  ".join(f"{v:4.1f}" for v in r))
