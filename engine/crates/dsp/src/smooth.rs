/// A linear ramp to a target over a fixed time, for discrete parameter jumps (knob commits,
/// gate on/off). Not for automation, which is applied exactly as drawn (engine.md §6.4).
///
/// Unlike a one-pole smoother (`y += (target - y) * k`), which only approaches the target
/// asymptotically, a linear ramp arrives after exactly the requested number of samples.
///
/// The state is f64 so a long ramp in a log domain does not lose precision.
#[derive(Clone, Copy, Debug)]
pub struct Ramp {
    value: f64,
    target: f64,
    /// Change per sample; 0 when at rest.
    step: f64,
}

impl Ramp {
    pub fn new(value: f64) -> Self {
        Self { value, target: value, step: 0.0 }
    }

    /// Start ramping from the current value to `target`, arriving in `samples` samples.
    /// Calling this mid-ramp restarts a full-length ramp from wherever we are.
    pub fn set_target(&mut self, target: f64, samples: f64) {
        self.target = target;
        self.step = (target - self.value) / samples.max(1.0);
    }

    /// Jump straight to the target (no ramp).
    pub fn snap(&mut self) {
        self.value = self.target;
        self.step = 0.0;
    }

    pub fn value(&self) -> f64 {
        self.value
    }

    pub fn target(&self) -> f64 {
        self.target
    }

    /// Advance by `n` samples and return the new value (clamped so it never overshoots).
    pub fn advance(&mut self, n: usize) -> f64 {
        if self.step != 0.0 {
            self.value += self.step * n as f64;
            if (self.step > 0.0 && self.value >= self.target) || (self.step < 0.0 && self.value <= self.target) {
                self.snap();
            }
        }
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrives_exactly_and_does_not_overshoot() {
        let mut r = Ramp::new(0.0);
        r.set_target(1.0, 480.0);
        assert!((r.advance(240) - 0.5).abs() < 1e-12);
        assert_eq!(r.advance(240), 1.0);
        assert_eq!(r.advance(1000), 1.0);
    }
}
