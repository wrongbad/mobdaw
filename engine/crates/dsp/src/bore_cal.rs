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

/// The user-facing knobs of a bore voice (all 0..1 except `open`).
#[derive(Clone, Copy, Debug)]
pub struct Knobs {
    pub character: f32,
    pub stiffness: f32,
    pub aperture: f32,
    pub position: f32,
    pub open: bool,
    pub damping: f32,
    pub decay: f32,
    pub breath: f32,
    pub noise: f32,
    pub vibrato_depth: f32,
}

impl Default for Knobs {
    fn default() -> Self {
        Self { character: 0.0, stiffness: 0.5, aperture: 0.5, position: 0.3, open: true, damping: 0.3, decay: 0.7, breath: 0.5, noise: 0.0, vibrato_depth: 0.0 }
    }
}

/// Everything the DSP core needs for a note, resolved from the knobs.
#[derive(Clone, Copy, Debug)]
pub struct Resolved {
    pub raw: crate::bore::Raw,
    /// Output gain that levels the loop signal.
    pub gain: f32,
    pub tune_cents: f32,
    /// Physical junction position for [`crate::bore::NoteSetup`].
    pub position: f32,
}

/// Map knobs onto raw settings for a MIDI note.
pub fn resolve(note: f32, k: &Knobs) -> Resolved {
    let f = fold(k.position);
    let cal = eval(note, k.character, f, k.open, k.stiffness, k.damping, k.decay);
    let (aperture, drive, gain) = cal.raw(k.aperture, k.breath);
    Resolved {
        raw: crate::bore::Raw {
            character: k.character,
            stiffness: k.stiffness,
            aperture,
            drive,
            damping: k.damping,
            reflection: reflection(k.decay),
            noise: k.noise,
            vibrato_depth: k.vibrato_depth,
        },
        gain,
        tune_cents: cal.tune_cents,
        position: junction_position(k.position, k.open),
    }
}

// BEGIN GENERATED (bore_calibrate fit)
// Generator: `bore_calibrate sweep` + `fit --emit` (docs/bore/). Grid: 5 anchors x 2 bores x 4 folds x notes 24..96 step 3, 8x26 aperture/drive cells each,
// stiffness/damping/decay cycled over 3 levels per cell. Fit error per quantity and anchor: docs/bore/fit.md.
/// `COEF[anchor][quantity][feature]`; see the module docs.
#[rustfmt::skip]
pub const COEF: [[[f32; N_FEAT]; N_Q]; N_ANCHORS] = [
    [
        [0.48340, 0.01560, -0.18052, 0.05875, -0.03078, -0.00276, 0.05443, 0.00000, 0.00000, 0.00000],
        [1.18579, 0.00102, 0.04677, -0.01677, -0.00785, -0.03237, -0.00190, 0.00000, 0.00000, 0.00000],
        [-0.19848, -0.02564, -0.06018, 0.04916, -1.50559, 0.05376, -0.01685, 0.00000, 0.00000, 0.00000],
        [0.72434, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.78533, -0.13017, -0.01575, -0.05384, -1.17775, -0.11381, -0.22183, 0.00000, 0.00000, 0.00000],
        [1.04633, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.34069, 0.29718, -0.20080, -0.05200, 0.20811, 0.06387, 0.37547, 0.00000, 0.00000, 0.00000],
        [-0.00222, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [1.12452, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.08430, 0.22575, 0.25738, 0.64640, -1.18393, -0.38208, 0.03966, 0.00000, 0.00000, 0.00000],
    ],
    [
        [0.39083, 0.00911, 0.20808, 0.06852, -0.31785, 0.04527, 0.07518, 0.00000, 0.00000, 0.00000],
        [1.19305, 0.00349, -0.03801, -0.00139, 0.01885, -0.00959, -0.00392, 0.00000, 0.00000, 0.00000],
        [-0.26682, 0.02404, -0.24343, 0.19538, -2.07609, -0.15047, -0.03960, 0.00000, 0.00000, 0.00000],
        [0.82324, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.74989, -0.05082, -0.33450, 0.08779, -1.50771, -0.38620, -0.25103, 0.00000, 0.00000, 0.00000],
        [0.87577, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.80682, 0.31337, 1.40644, -0.47696, 0.21833, 0.21356, 0.38554, 0.00000, 0.00000, 0.00000],
        [0.24737, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.94522, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.18373, 0.26559, 0.52526, 0.27408, 0.46879, -0.41645, 0.05968, 0.00000, 0.00000, 0.00000],
    ],
    [
        [0.51034, 0.03025, -0.10556, 0.02177, -0.21578, 0.03108, 0.05996, 0.00000, 0.00000, 0.00000],
        [1.19281, -0.00069, 0.02204, -0.00573, 0.00081, -0.00099, -0.00095, 0.00000, 0.00000, 0.00000],
        [-0.96091, 0.00647, -0.22835, 0.05053, -0.99885, -0.16338, -0.02514, 0.00000, 0.00000, 0.00000],
        [0.13262, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.17250, -0.13249, -0.04568, -0.25572, -0.72870, -0.35858, -0.34248, 0.00000, 0.00000, 0.00000],
        [0.72434, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.36199, 0.23963, -0.21444, -0.06351, 0.42095, 0.48781, 0.38149, 0.00000, 0.00000, 0.00000],
        [0.20227, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.89016, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.65709, 0.50608, 0.14605, 0.54920, 1.15619, -2.31251, 0.07415, 0.00000, 0.00000, 0.00000],
    ],
    [
        [0.38793, 0.01040, -0.08888, 0.06360, -0.04018, 0.01042, 0.05569, 0.00000, 0.00000, 0.00000],
        [1.18471, 0.00157, 0.03933, -0.00408, 0.01839, 0.01037, -0.00007, 0.00000, 0.00000, 0.00000],
        [-1.24091, -0.12769, 0.08989, 0.24604, -0.95688, -0.12089, -0.14922, 0.00000, 0.00000, 0.00000],
        [0.40967, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.01590, -0.18079, -0.19050, 0.17720, -0.74664, -0.21252, -0.30607, 0.00000, 0.00000, 0.00000],
        [0.63230, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.32063, 0.44197, 0.02492, -0.61340, -0.00035, 0.17983, 0.36948, 0.00000, 0.00000, 0.00000],
        [0.12033, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [1.03990, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.21890, 0.32088, -0.13847, 0.50607, -0.48850, -0.31194, -0.03121, 0.00000, 0.00000, 0.00000],
    ],
    [
        [0.16806, 0.00032, -0.05153, 0.01792, -0.03846, 0.02837, 0.00272, 0.00000, 0.00000, 0.00000],
        [1.19934, -0.00006, 0.01910, -0.01107, 0.01509, -0.01713, 0.00176, 0.00000, 0.00000, 0.00000],
        [-2.36434, -0.17522, -0.32401, 0.53641, -0.11483, 0.43693, -0.10222, 0.00000, 0.00000, 0.00000],
        [0.77971, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.30742, -0.08460, 0.35377, -0.00063, -0.21221, 0.17723, -0.23108, 0.00000, 0.00000, 0.00000],
        [0.65410, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.12723, 0.38229, -0.02864, -0.57267, -0.53957, -1.07474, 0.16719, 0.00000, 0.00000, 0.00000],
        [-0.33474, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [1.44909, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.21276, 0.32444, 0.28930, 0.42505, 0.10773, -0.23250, -0.01549, 0.00000, 0.00000, 0.00000],
    ],
];
/// `RANGE[anchor][0 low / 1 high][1, fold, open]`: the working note range.
#[rustfmt::skip]
pub const RANGE: [[[f32; 3]; 2]; N_ANCHORS] = [
    [[22.5000, 0.0000, 0.0000], [97.5000, 0.0000, 0.0000]],
    [[21.5753, 3.2731, 0.7500], [90.4368, 22.3476, -6.0000]],
    [[22.5000, 0.0000, 0.0000], [97.5000, 0.0000, 0.0000]],
    [[22.5000, 0.0000, 0.0000], [97.5000, 0.0000, 0.0000]],
    [[22.5000, 0.0000, 0.0000], [97.5000, 0.0000, 0.0000]],
];
// END GENERATED
