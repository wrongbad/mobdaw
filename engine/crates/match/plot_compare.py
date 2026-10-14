import sys, wave, numpy as np, matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
root = sys.argv[1]
progs = [("clarinet",62),("alto-sax",64),("flute",74),("cello",52),("violin",69)]
def rd(p):
    w = wave.open(p); return np.frombuffer(w.readframes(w.getnframes()), np.int16)/32768.0
def st(x, n=2048):
    h=n//4; win=np.hanning(n); fr=[np.abs(np.fft.rfft(x[i:i+n]*win)) for i in range(0,len(x)-n,h)]
    return 20*np.log10(np.array(fr).T+1e-6)
fig, ax = plt.subplots(5, 2, figsize=(11, 14))
for r,(nm,k) in enumerate(progs):
    for c,(lab,f) in enumerate([("target",f"target_{k}.wav"),("bore best",f"best_{k}.wav")]):
        S = st(rd(f"{root}/{nm}/{f}"))[:300]
        ax[r,c].imshow(S, origin="lower", aspect="auto", vmin=S.max()-90, vmax=S.max(), extent=[0,1.8,0,300*44100/2048]); ax[r,c].set_title(f"{nm} {lab} (key {k})", fontsize=9)
plt.tight_layout(); plt.savefig(f"{root}/compare.png", dpi=70)
