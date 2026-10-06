//! Decoded PCM sources: planar f32 at the project sample rate.

pub struct Source {
    channels: usize,
    frames: usize,
    /// Planar: channel 0's `frames` samples, then channel 1's, and so on.
    data: Vec<f32>,
    ready: bool,
}

impl Source {
    pub fn new(channels: usize, frames: usize) -> Self {
        Self { channels, frames, data: vec![0.0; channels * frames], ready: false }
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn set_ready(&mut self) {
        self.ready = true;
    }

    pub fn data_mut(&mut self) -> &mut [f32] {
        &mut self.data
    }

    /// Pointer for the host to fill. Stable as long as this source lives, because the `Vec`'s
    /// heap block does not move when the map around it shifts.
    pub fn as_mut_ptr(&mut self) -> *mut f32 {
        self.data.as_mut_ptr()
    }

    /// Left channel. A mono source plays to both sides, so left == right for it.
    pub fn left(&self) -> &[f32] {
        &self.data[..self.frames]
    }

    /// Right channel: channel 1 if present, otherwise channel 0. Sources with more than two
    /// channels use their first two.
    pub fn right(&self) -> &[f32] {
        if self.channels >= 2 {
            &self.data[self.frames..2 * self.frames]
        } else {
            self.left()
        }
    }
}
