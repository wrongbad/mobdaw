import sys, wave, numpy as np, matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
root = sys.argv[1]
pre = sys.argv[2:4] if len(sys.argv) > 3 else ["target", "best"]  # file prefixes, e.g. target_wet best_wet
progs = [("clarinet",62),("alto-sax",64),("flute",74),("cello",52),("violin",69)]
def rd(p):
    w = wave.open(p); return np.frombuffer(w.readframes(w.getnframes()), np.int16)/32768.0
def st(x, n=2048):
    h=n//4; win=np.hanning(n); fr=[np.abs(np.fft.rfft(x[i:i+n]*win)) for i in range(0,len(x)-n,h)]
    return 20*np.log10(np.array(fr).T+1e-6)
fig, ax = plt.subplots(5, 2, figsize=(11, 14))
for r,(nm,k) in enumerate(progs):
    for c,(lab,f) in enumerate([(pre[0],f"{pre[0]}_{k}.wav"),(pre[1],f"{pre[1]}_{k}.wav")]):
        S = st(rd(f"{root}/{nm}/{f}"))[:300]
        ax[r,c].imshow(S, origin="lower", aspect="auto", vmin=S.max()-90, vmax=S.max(), extent=[0,len(rd(f"{root}/{nm}/{f}"))/44100,0,300*44100/2048]); ax[r,c].set_title(f"{nm} {lab} (key {k})", fontsize=9)
plt.tight_layout(); plt.savefig(f"{root}/compare_{pre[1]}.png", dpi=70)
