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
    /// Pitch vibrato (0..1), see [`crate::bore::Raw::pitch_vibrato`]. Not part of the calibration.
    pub pitch_vibrato: f32,
    /// Even harmonics up high, see [`crate::bore::Raw::bell`]. Outside the loop; not part of the calibration.
    pub bell: f32,
    /// Noise paths, see [`crate::bore::Raw`]. Not part of the calibration.
    pub valve_noise: f32,
    pub air: f32,
    pub wander: f32,
}

impl Default for Knobs {
    fn default() -> Self {
        Self { character: 0.0, stiffness: 0.5, aperture: 0.5, position: 0.3, open: true, damping: 0.3, decay: 0.7, breath: 0.5, noise: 0.0, vibrato_depth: 0.0, pitch_vibrato: 0.0, bell: 0.0, valve_noise: 0.0, air: 0.0, wander: 0.0 }
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
            pitch_vibrato: k.pitch_vibrato,
            bell: k.bell,
            valve_noise: k.valve_noise,
            air: k.air,
            wander: k.wander,
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
        [0.45269, 0.00348, -0.02367, 0.02935, 0.02301, 0.00438, 0.06696, 0.00000, 0.00000, 0.00000],
        [1.19431, -0.00001, 0.00351, -0.00129, 0.06287, 0.00705, -0.00052, 0.00000, 0.00000, 0.00000],
        [-0.25726, -0.00148, 0.01311, -0.01674, -1.50212, -0.02341, -0.00862, 0.00000, 0.00000, 0.00000],
        [0.81784, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.73522, -0.00038, -0.24169, -0.09965, -1.51024, -0.05658, -0.15270, 0.00000, 0.00000, 0.00000],
        [1.15944, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.23221, 0.03188, -0.38634, 0.32722, 0.35679, 0.01415, 0.11209, 0.00000, 0.00000, 0.00000],
        [-0.12699, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [1.17833, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.16996, -0.03731, -0.06188, 0.14928, 0.05932, 0.05570, -0.02915, 0.00000, 0.00000, 0.00000],
    ],
    [
        [0.23760, 0.01038, 0.56869, 0.08613, -0.21928, 0.00679, 0.08711, 0.00000, 0.00000, 0.00000],
        [1.19385, 0.00023, 0.00388, -0.00127, 0.04529, 0.00832, -0.00054, 0.00000, 0.00000, 0.00000],
        [-0.36901, 0.02305, 0.21784, 0.02721, -1.92951, -0.03124, 0.01812, 0.00000, 0.00000, 0.00000],
        [0.99774, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.65139, 0.01994, -0.14131, -0.03425, -1.33771, -0.05367, -0.13301, 0.00000, 0.00000, 0.00000],
        [1.02046, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.32569, 0.05957, -0.17669, 0.18018, 0.25162, 0.00002, 0.23496, 0.00000, 0.00000, 0.00000],
        [0.03310, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [1.12017, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.26909, -0.35070, -0.06862, 0.13339, -0.08049, -0.12321, -0.02540, 0.00000, 0.63402, 0.00000],
    ],
    [
        [0.51162, 0.04836, -0.09622, 0.04428, -0.02053, -0.01236, 0.06125, 0.00000, 0.00000, 0.00000],
        [1.19738, 0.00013, 0.00845, -0.00284, -0.00052, 0.00051, -0.00024, 0.00000, 0.00000, 0.00000],
        [-1.00420, 0.00866, -0.11067, -0.05287, -0.80884, -0.03290, -0.01049, 0.00000, 0.00000, 0.00000],
        [0.10042, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.11489, 0.04414, -0.35146, -0.23515, -0.87456, -0.08090, -0.28019, 0.00000, 0.00000, 0.00000],
        [0.80453, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.04684, 0.02625, -0.52871, 0.34435, 0.09646, 0.01106, 0.11978, 0.00000, 0.00000, 0.00000],
        [-0.07019, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [1.14224, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.13327, -0.04809, -0.22312, 0.01075, 0.00319, 0.17574, -0.04155, 0.00000, 0.00000, 0.00000],
    ],
    [
        [0.21524, 0.01873, 0.19613, 0.05303, -0.16128, -0.01891, 0.04784, 0.00000, 0.00000, 0.00000],
        [1.19848, -0.00003, 0.00538, -0.00269, 0.00086, -0.00093, 0.00024, 0.00000, 0.00000, 0.00000],
        [-1.22136, -0.00539, -0.02068, 0.03430, -1.05621, -0.02363, 0.01383, 0.00000, 0.00000, 0.00000],
        [0.39459, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.09319, -0.03005, -0.30075, -0.05088, -0.78434, -0.02948, -0.33591, 0.00000, 0.00000, 0.00000],
        [0.69740, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.46206, 0.13374, -0.16363, -0.00069, -0.17835, -0.08060, 0.16113, 0.00000, 0.00000, 0.00000],
        [0.23691, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.91421, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.07538, 0.04808, -0.03154, 0.02272, 0.00716, 0.01872, -0.00605, 0.00000, 0.00000, 0.00000],
    ],
    [
        [0.15711, 0.00019, -0.02146, 0.00793, -0.01355, 0.00144, 0.00166, 0.00000, 0.00000, 0.00000],
        [1.19915, -0.00010, 0.00285, -0.00096, 0.00042, 0.00108, 0.00014, 0.00000, 0.00000, 0.00000],
        [-2.27704, -0.00380, 0.02118, -0.02287, -0.37883, -0.03173, 0.01029, 0.00000, 0.00000, 0.00000],
        [0.79783, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [-0.05339, 0.03566, 0.05107, -0.31840, -0.53891, -0.06082, -0.24771, 0.00000, 0.00000, 0.00000],
        [0.70570, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.05366, 0.01617, -0.46936, 0.48110, 0.36693, -0.02522, -0.00119, 0.00000, 0.00000, 0.00000],
        [-0.45067, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [1.58920, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000, 0.00000],
        [0.32477, 0.13723, -0.20652, -0.04161, 0.01409, -0.03430, -0.00130, 0.00000, 0.00000, 0.00000],
    ],
];
/// `RANGE[anchor][0 low / 1 high][1, fold, open]`: the working note range.
#[rustfmt::skip]
pub const RANGE: [[[f32; 3]; 2]; N_ANCHORS] = [
    [[22.5000, 0.0000, 9.0000], [97.5000, 0.0000, 0.0000]],
    [[23.7116, -4.2889, 10.5000], [97.5000, 0.0000, 0.0000]],
    [[22.5000, 0.0000, 9.0000], [97.5000, 0.0000, 0.0000]],
    [[22.5000, 0.0000, 9.0000], [97.5000, 0.0000, 0.0000]],
    [[22.5000, 0.0000, 9.0000], [97.5000, 0.0000, 0.0000]],
];
// END GENERATED
