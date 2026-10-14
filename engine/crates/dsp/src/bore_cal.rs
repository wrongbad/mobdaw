//! Calibration of the bore synth: maps the user-facing knobs onto raw valve settings.
//!
//! Raw `drive` and `aperture` only sound in a narrow region that moves with the note, the
//! character, the junction position and the bore. The offline sweep (`bin/bore_calibrate.rs`,
//! docs/bore/) measured that region and fitted it with closed-form curves; the coefficients are
//! the generated table at the bottom of this file. Nothing here is a lookup table over notes.
//!
//! # What is fitted
//! For an anchor `a` (character 0, 0.25, 0.5, 0.75, 1) and the feature vector
//! `x = features(note, fold, open, stiffness, damping, decay)`, each quantity is `w[a][q] . x`.
//! Between anchors the quantities interpolate linearly in character. The quantities:
//!
//! | q | meaning |
//! |---|---|
//! | `AP_LO`, `AP_HI` | the raw aperture range that speaks |
//! | `LO`, `HI` | `ln(drive)` at the lower / upper edge of the sounding band, at aperture [`AP_REF`] |
//! | `LO_SLOPE`, `HI_SLOPE` | how those edges move with `ln(aperture)` (the band is diagonal) |
//! | `R0`, `R_A`, `R_D` | the loop output level: `ln(rms) = R0 + R_A ln(ap/AP_REF) + R_D ln(drive)` |
//! | `TUNE` | the loop tuning correction in cents (measured pitch error of the uncorrected loop) |
//!
//! The four slopes (`LO_SLOPE`, `HI_SLOPE`, `R_A`, `R_D`) are per-anchor constants: the sweep
//! showed they do not move with the other inputs by more than their own measurement noise.
//!
//! The output gain divides out the predicted loop level and multiplies in [`TARGET_RMS`],
//! leaving only [`BREATH_LEVEL`] of the level's rise with breath.
//!
//! The knobs walk the band: `aperture` interpolates `AP_LO..AP_HI`; `breath` interpolates the
//! two `ln(drive)` edges (pulled in by [`EDGE_MARGIN`] so the extremes are not on the threshold
//! or the squeal).

/// Number of character anchors: reed, reed/jet, jet, jet/bow, bow.
pub const N_ANCHORS: usize = 5;
/// Length of the feature vector.
pub const N_FEAT: usize = 10;
/// Number of fitted quantities.
pub const N_Q: usize = 10;

pub const AP_LO: usize = 0;
pub const AP_HI: usize = 1;
pub const LO: usize = 2;
pub const LO_SLOPE: usize = 3;
pub const HI: usize = 4;
pub const HI_SLOPE: usize = 5;
pub const R0: usize = 6;
pub const R_A: usize = 7;
pub const TUNE: usize = 9;
pub const R_D: usize = 8;

/// Aperture at which `LO` and `HI` are expressed.
pub const AP_REF: f32 = 0.6;
/// Output level the calibrated gain aims for (steady RMS of the DC-blocked loop signal).
pub const TARGET_RMS: f32 = 0.1;
/// How much of the loop level's rise with `drive` the gain leaves in: the output level goes as
/// `drive^BREATH_LEVEL` along the breath knob (0 would flatten it completely).
pub const BREATH_LEVEL: f32 = 0.4;
/// Fraction of the band (in `ln drive`) cut from each end of the breath knob's travel.
pub const EDGE_MARGIN: f32 = 0.1;

/// Loop gain per round trip for the `decay` knob.
#[inline]
pub fn reflection(decay: f32) -> f32 {
    0.88 + 0.1195 * decay.clamp(0.0, 1.0)
}

/// The decay feature: `ln` of the loop loss `1 - reflection`, centred. The sounding region moves
/// with the loss on a log scale (the loss spans a factor of 240 over the knob).
#[inline]
pub fn loss_feature(decay: f32) -> f32 {
    (1.0 - reflection(decay)).ln() + 3.3
}

/// The folded junction position: the distance of the position knob from the nearer end, 0..0.5.
#[inline]
pub fn fold(position: f32) -> f32 {
    let p = position.clamp(0.0, 1.0);
    p.min(1.0 - p)
}

/// The physical junction position for a bore. An open bore is symmetric in `p <-> 1-p`, so it
/// takes the folded position. A closed bore only speaks with the junction on the closed side
/// (`p >= 0.5`), so it takes the mirror image.
#[inline]
pub fn junction_position(position: f32, open: bool) -> f32 {
    let d = fold(position);
    if open {
        d
    } else {
        1.0 - d
    }
}

/// The feature vector the fits use. Curve features (`note^2`, linear frequency, `fold^2`) are
/// only given weight where the sweep's residuals showed structure.
#[inline]
pub fn features(note: f32, fold: f32, open: bool, stiffness: f32, damping: f32, decay: f32) -> [f32; N_FEAT] {
    let n = (note - 60.0) / 12.0;
    [1.0, n, fold, if open { 1.0 } else { 0.0 }, stiffness - 0.5, damping - 0.3, loss_feature(decay), n * n, (n).exp2() - 1.0, fold * fold]
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Cal {
    pub ap_lo: f32,
    pub ap_hi: f32,
    pub ln_lo: f32,
    pub lo_slope: f32,
    pub ln_hi: f32,
    pub hi_slope: f32,
    pub r0: f32,
    pub r_a: f32,
    pub r_d: f32,
    pub tune_cents: f32,
}

impl Cal {
    /// Raw `(aperture, drive, gain)` for the knobs `aperture`, `breath` in 0..1.
    #[inline]
    pub fn raw(&self, aperture: f32, breath: f32) -> (f32, f32, f32) {
        let a = self.ap_lo + aperture.clamp(0.0, 1.0) * (self.ap_hi - self.ap_lo).max(0.0);
        let la = (a / AP_REF).ln();
        let lo = self.ln_lo + self.lo_slope * la;
        let hi = (self.ln_hi + self.hi_slope * la).max(lo + 0.2);
        let (lo2, hi2) = (lo + EDGE_MARGIN * (hi - lo), hi - EDGE_MARGIN * (hi - lo));
        let ld = lo2 + breath.clamp(0.0, 1.0) * (hi2 - lo2);
        let ld_c = 0.5 * (lo2 + hi2);
        // predicted level is tf * drive; aim at TARGET at the band's centre
        let ln_gain = TARGET_RMS.ln() - (self.r0 + self.r_a * la + self.r_d * ld) + BREATH_LEVEL * (ld - ld_c);
        (a, ld.exp(), ln_gain.exp())
    }
}

#[inline]
fn dot(w: &[f32; N_FEAT], x: &[f32; N_FEAT]) -> f32 {
    w.iter().zip(x.iter()).map(|(a, b)| a * b).sum()
}

/// The fitted quantities for a note and settings (character is interpolated between anchors).
pub fn eval(note: f32, character: f32, fold: f32, open: bool, stiffness: f32, damping: f32, decay: f32) -> Cal {
    let x = features(note, fold, open, stiffness, damping, decay);
    let c = character.clamp(0.0, 1.0) * (N_ANCHORS - 1) as f32;
    let i = (c.floor() as usize).min(N_ANCHORS - 2);
    let t = c - i as f32;
    let q = |q: usize| dot(&COEF[i][q], &x) * (1.0 - t) + dot(&COEF[i + 1][q], &x) * t;
    Cal { ap_lo: q(AP_LO), ap_hi: q(AP_HI), ln_lo: q(LO), lo_slope: q(LO_SLOPE), ln_hi: q(HI), hi_slope: q(HI_SLOPE), r0: q(R0), r_a: q(R_A), r_d: q(R_D), tune_cents: q(TUNE) }
}

/// The working note range `(lowest, highest)` MIDI pitch (inclusive) at a character, folded
/// position and bore. Notes outside it are rejected (no voice).
pub fn note_range(character: f32, fold: f32, open: bool) -> (f32, f32) {
    let x = [1.0, fold, if open { 1.0 } else { 0.0 }];
    let c = character.clamp(0.0, 1.0) * (N_ANCHORS - 1) as f32;
    let i = (c.floor() as usize).min(N_ANCHORS - 2);
    let t = c - i as f32;
    let f = |k: usize| {
        let a: f32 = (0..3).map(|j| RANGE[i][k][j] * x[j]).sum();
        let b: f32 = (0..3).map(|j| RANGE[i + 1][k][j] * x[j]).sum();
        a * (1.0 - t) + b * t
    };
    (f(0), f(1))
}

// BEGIN GENERATED (bore_calibrate fit)
pub const COEF: [[[f32; N_FEAT]; N_Q]; N_ANCHORS] = [[[0.0; N_FEAT]; N_Q]; N_ANCHORS];
pub const RANGE: [[[f32; 3]; 2]; N_ANCHORS] = [[[0.0; 3]; 2]; N_ANCHORS];
// END GENERATED
