/// Flush tiny values to exactly zero.
///
/// WebAssembly has no FTZ/DAZ mode (unlike x86 `MXCSR`), so a decaying feedback state would
/// walk down into the subnormal range (< 1.2e-38), where many CPUs are 10-100x slower.
/// 1e-20 is -400 dBFS: far below any audible or f32-representable signal at unit scale.
/// Use this on the state of every recursive structure (filters, delays, reverbs).
#[inline(always)]
pub fn flush_denormal(x: f32) -> f32 {
    if x.abs() < 1e-20 {
        0.0
    } else {
        x
    }
}
