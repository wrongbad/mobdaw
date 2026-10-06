//! A map keyed by the bridge's `u32` handles, stored as a vector sorted by handle.
//!
//! Why not a `HashMap`? Three reasons, all about this being an audio engine:
//! * **Determinism.** Iteration order is the handle order, always. A `HashMap` iterates in an
//!   order that depends on its (randomly seeded) hasher, and f32 summation order changes the
//!   output bits; the engine must render bit-identically on every client (engine.md section 1).
//! * **Cache behaviour and simplicity.** Handles are handed out by a counter, so new entries
//!   mostly append at the end (no shifting), and the render loop walks a contiguous slice.
//! * **No hidden allocation.** Lookups, `get_mut` and iteration never allocate. Only
//!   `insert` may, and only structural commands insert. Capacity is reserved up front.
//!
//! Lookup is a binary search: O(log n), a handful of comparisons for at most 65536 entries.
//! Insert and remove are O(n) memmoves, which is fine for infrequent structural commands.

pub struct HandleMap<T> {
    items: Vec<(u32, T)>,
}

impl<T> HandleMap<T> {
    pub fn with_capacity(capacity: usize) -> Self {
        Self { items: Vec::with_capacity(capacity) }
    }

    fn find(&self, h: u32) -> Result<usize, usize> {
        self.items.binary_search_by_key(&h, |(k, _)| *k)
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn get(&self, h: u32) -> Option<&T> {
        self.find(h).ok().map(|i| &self.items[i].1)
    }

    pub fn get_mut(&mut self, h: u32) -> Option<&mut T> {
        match self.find(h) {
            Ok(i) => Some(&mut self.items[i].1),
            Err(_) => None,
        }
    }

    /// Insert or replace; returns the previous value if any.
    pub fn insert(&mut self, h: u32, value: T) -> Option<T> {
        match self.find(h) {
            Ok(i) => Some(std::mem::replace(&mut self.items[i].1, value)),
            Err(i) => {
                self.items.insert(i, (h, value));
                None
            }
        }
    }

    pub fn remove(&mut self, h: u32) -> Option<T> {
        self.find(h).ok().map(|i| self.items.remove(i).1)
    }

    /// `(handle, &value)` in ascending handle order.
    pub fn iter(&self) -> impl Iterator<Item = (u32, &T)> {
        self.items.iter().map(|(h, v)| (*h, v))
    }

    pub fn values(&self) -> impl Iterator<Item = &T> {
        self.items.iter().map(|(_, v)| v)
    }

    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut T> {
        self.items.iter_mut().map(|(_, v)| v)
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (u32, &mut T)> {
        self.items.iter_mut().map(|(h, v)| (*h, v))
    }
}
