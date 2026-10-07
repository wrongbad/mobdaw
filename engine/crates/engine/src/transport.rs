//! A transport: a play/stop flag and a sample position. The engine has one for the timeline and
//! one per *preview* (see `engine.rs`), so everything that needs "its own playhead" shares this.

#[derive(Clone, Copy, Debug, Default)]
pub struct Transport {
    pub playing: bool,
    pub position: i64,
}

impl Transport {
    pub fn play(&mut self, from: i64) {
        self.position = from;
        self.playing = true;
    }

    pub fn stop(&mut self) {
        self.playing = false;
    }

    pub fn seek(&mut self, pos: i64) {
        self.position = pos;
    }

    /// Move on by `n` samples if playing.
    pub fn advance(&mut self, n: usize) {
        if self.playing {
            self.position += n as i64;
        }
    }
}
