//! Pure DSP building blocks. No wasm, no I/O, no allocation in the audio paths.
//! Everything here is unit-tested natively with `cargo test -p dsp`.

pub mod adsr;
pub mod fade;
pub mod finnwave;
pub mod pan;
pub mod smooth;
pub mod svf;
pub mod synth;
pub mod util;

pub use adsr::Adsr;
pub use fade::FadeShape;
pub use finnwave::Finnwave;
pub use smooth::Ramp;
pub use svf::Svf;
pub use synth::Synth;
pub use util::flush_denormal;
