# Bore Calibration Factor Sweep Analysis

**Date:** 2026-10-14  
**Base configuration:** stiffness=0.5, damping=0.3, decay=0.7  
**Live cells in base:** 251

## Summary

Varying stiffness, damping, and decay factors around their base values produces the following effects on calibration quantities:

### Critical Findings

1. **DECAY has the largest impact** on key calibration quantities (m_hi, m_lr, ap_lo, m_la)
2. **STIFFNESS has moderate impact** on drive parameters (m_hi, m_lr)
3. **DAMPING has minimal impact** on most quantities except tuning drift
4. **Tuning (tune)** shows significant scatter in all factor sweeps, suggesting other sources of variation

### Quantitative Impact (max mean absolute change across factor range)

| Quantity | Stiffness | Damping | Decay   | Units/Interpretation |
|----------|-----------|---------|---------|----------------------|
| ap_lo    | 0.103     | 0.029   | 0.222   | aperture lower edge |
| ap_hi    | 0.063     | 0.006   | 0.015   | aperture upper edge |
| m_la     | 0.099     | 0.028   | 0.190   | ln drive at low ap |
| m_hi     | 0.720     | 0.060   | 1.066   | ln drive at high ap |
| m_lr     | 0.781     | 0.081   | 1.066   | ln rms at ref point |
| tune     | 0.212     | 1.093   | 0.366   | tuning in cents |

### Linearity Assessment

For each factor, we fit mean_diff = slope × delta and compute R²:

**STIFFNESS** (delta range: -0.5 to +0.5):
- ap_lo, m_hi, m_lr: **reasonably linear** (R² = 0.70-0.88)
- Other quantities: moderate linearity (R² = 0.31-0.61)
- Slopes: m_hi=-0.99, m_lr=-1.10, ap_lo=-0.066

**DAMPING** (delta range: -0.3 to +0.7):
- ap_lo, m_la: **highly linear** (R² = 0.92-0.95)
- m_lr: moderate linearity (R² = 0.70)
- m_hi, tune: **poor linearity** (R² = 0.44, 0.59)
- Slopes: ap_lo=+0.034, m_la=+0.034, m_lr=-0.051

**DECAY** (delta range: -0.7 to +0.3):
- ap_lo, m_la: **highly linear** (R² = 0.94-0.96)
- tune: moderate linearity (R² = 0.78)
- m_hi, m_lr: **poor linearity** (R² = 0.25-0.36), large deviations
- Slopes: ap_lo=-0.34, m_la=-0.30, tune=+0.21

### Spatial Dependence (anchor/note correlations)

Significant correlations (|r| > 0.3) observed for:

**STIFFNESS:**
- m_hi: anchor corr varies from -0.50 to +0.50 across range
- m_lr: anchor corr +0.37 to +0.50 at high stiffness
- Effect: **anchor-dependent**, especially at extremes

**DAMPING:**
- Minimal spatial dependence overall
- Effect: **roughly uniform**

**DECAY:**
- m_hi: anchor corr -0.50 to -0.27, note corr +0.21 to +0.37
- m_lr: note corr -0.39 across most of range
- ap_lo/m_la: anchor corr +0.35 to +0.40 at high decay
- Effect: **anchor and note dependent**

## Recommendations

### 1. Correction terms needed?

**YES for DECAY:**
- Large shifts (>1.0 in m_hi, m_lr)
- Non-linear behavior in drive parameters
- Strong spatial dependence
- **Action:** Add decay correction terms for m_hi, m_lr, ap_lo, m_la

**MAYBE for STIFFNESS:**
- Moderate shifts (0.7-0.8 in m_hi, m_lr at delta=0.5)
- Reasonably linear in most quantities
- Some anchor dependence
- **Action:** Consider linear correction for m_hi, m_lr if stiffness varies by >0.25 from base

**NO for DAMPING:**
- Minimal impact on most quantities (except tune drift)
- Linear where it matters (ap_lo, m_la)
- Small absolute shifts
- **Action:** No correction needed unless damping varies by >0.5 from base

### 2. Correction form

Based on linearity analysis:

**For quantities with good linearity (R² > 0.8):**
- Use **linear correction**: quantity_corrected = quantity + slope × (factor - base)
- Examples: decay on ap_lo/m_la, stiffness on m_hi/m_lr

**For quantities with poor linearity:**
- Investigate **quadratic or interaction terms**
- Examples: decay on m_hi/m_lr (R² = 0.25-0.36)

**For spatial dependence:**
- Consider **anchor-stratified corrections** for:
  - Decay effects on m_hi, m_lr
  - Stiffness effects at extremes

### 3. Priority order

1. **Decay corrections** (largest impact, non-linear, spatially varying)
2. **Stiffness corrections** if used outside ±0.25 of base
3. **Damping corrections** not needed for current range

## Data Quality Notes

- Common live cells across sweeps: 219-251 (out of 251 base)
- Some cells drop out at factor extremes (e.g., decay=0: 219 cells)
- Tuning scatter is high (up to 9 cents) across all sweeps, suggesting measurement noise or other uncontrolled factors
- Maximum individual cell deviations often 3-5× larger than mean deviations, indicating cell-to-cell variability

## Raw Data

Full analysis results: `factor_analysis.csv`  
Individual sweep CSVs: `*.csv` in this directory  
Analysis script: `analyze_sweep.py`
