//! Pure DSP building blocks. No wasm, no I/O, no allocation in the audio paths.
//! Everything here is unit-tested natively with `cargo test -p dsp`.

pub mod adsr;
pub mod analog;
pub mod compressor;
pub mod delay;
pub mod fade;
pub mod finnwave;
pub mod lfo;
pub mod looper;
pub mod pan;
pub mod resampler;
pub mod reverb;
pub mod smooth;
pub mod svf;
pub mod synth;
pub mod tape;
pub mod tremolo;
pub mod util;
pub mod warble;

pub use adsr::Adsr;
pub use compressor::{CompParams, Compressor};
pub use delay::{DelayParams, TapeDelay};
pub use fade::FadeShape;
pub use finnwave::Finnwave;
pub use looper::{LoopParams, LoopVoice};
pub use resampler::Resampler;
pub use reverb::Reverb;
pub use smooth::Ramp;
pub use svf::Svf;
pub use synth::Synth;
pub use tape::TapeColor;
pub use tremolo::{TremParams, Tremolo};
pub use util::flush_denormal;
pub use warble::Warble;
