//! The routing graph (docs/routing.md, "Engine"): nodes, typed edges, the buffers edges carry, and
//! the schedule. Everything here runs in `rebuild_routing` (structural commands), never on the
//! audio path; the audio path only walks the results (`order`, buffer indices).
//!
//! A **node** is a chain: a track, a bus or the master. Nodes are numbered by their dense position
//! in the track map, the master last. An **edge** links a typed source port to a destination port;
//! phase 1 has audio edges only, of two shapes: bus membership (`Out` of a child to `In` of its
//! parent) and taps (a `Tap` of the writer's node to the `Side` input of a device on the reader's
//! node). Later node kinds and port types plug into the same lists; the chain stays the tight
//! per-node loop in `engine.rs`.
//!
//! **Pull model.** Every port that carries audio is a [`Bufs`] buffer that persists across blocks.
//! A reader pulls what is there when it runs: if its writer ran earlier this block that is this
//! block's audio, otherwise the writer's previous block (one block of delay). Cycles need no
//! special case; the schedule only decides where they are cut.

/// "No buffer" / "no node".
pub const NONE: u32 = u32::MAX;

/// What an edge carries. Phase 1: audio (planar stereo, one block).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortKind {
    Audio,
}

/// Which of a node's ports an edge touches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortRole {
    /// The node's output (after its fader and mute gain): what its parent sums.
    Out,
    /// The node's summing input (its children).
    In,
    /// A tap the node writes (its implicit tap or one of its send devices).
    Tap(BufKey),
    /// A side input of a device in the node's chain (a recv's tap, a compressor's key); the device's handle.
    Side(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Port {
    pub node: u32,
    pub role: PortRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Edge {
    pub kind: PortKind,
    pub from: Port,
    pub to: Port,
}

impl Edge {
    pub fn member(child: u32, parent: u32) -> Self {
        Edge { kind: PortKind::Audio, from: Port { node: child, role: PortRole::Out }, to: Port { node: parent, role: PortRole::In } }
    }

    pub fn tap(writer: u32, key: BufKey, reader: u32, device: u32) -> Self {
        Edge { kind: PortKind::Audio, from: Port { node: writer, role: PortRole::Tap(key) }, to: Port { node: reader, role: PortRole::Side(device) } }
    }
}

/// Identity of a buffer, stable across rebuilds (so a rebuild keeps the audio in flight).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum BufKey {
    /// A track's (or bus's) output, by track handle.
    Out(u32),
    /// A track's implicit tap: its chain output before the mix device, by track handle.
    Tap(u32),
    /// The master's implicit tap.
    MasterTap,
    /// An `fx send` device's tap, by device handle.
    Send(u32),
    /// Exact silence, for readers whose tap is gone. Never written, never live.
    Silence,
}

/// Planar stereo buffers (`BLOCK` left, `BLOCK` right each) with a liveness flag: `live` is false only when
/// the buffer is known to hold exact zeros, so readers can skip it and sleeping chains can stay asleep.
pub struct Bufs {
    keys: Vec<BufKey>,
    data: Vec<f32>,
    live: Vec<bool>,
    block: usize,
}

impl Bufs {
    pub fn new(block: usize) -> Self {
        Self { keys: Vec::new(), data: Vec::new(), live: Vec::new(), block }
    }

    /// Make exactly the buffers `want` exist (sorted and deduplicated here), keeping the contents of
    /// those that already did. Allocates: structural only.
    pub fn rebuild(&mut self, mut want: Vec<BufKey>) {
        want.sort_unstable();
        want.dedup();
        let w = 2 * self.block;
        let mut data = vec![0.0f32; want.len() * w];
        let mut live = vec![false; want.len()];
        for (i, k) in want.iter().enumerate() {
            if let Ok(j) = self.keys.binary_search(k) {
                data[i * w..(i + 1) * w].copy_from_slice(&self.data[j * w..(j + 1) * w]);
                live[i] = self.live[j];
            }
        }
        (self.keys, self.data, self.live) = (want, data, live);
    }

    /// The buffer index for `key`, or [`NONE`].
    pub fn index(&self, key: BufKey) -> u32 {
        self.keys.binary_search(&key).map_or(NONE, |i| i as u32)
    }

    #[inline]
    pub fn is_live(&self, i: u32) -> bool {
        self.live[i as usize]
    }

    #[inline]
    pub fn set_live(&mut self, i: u32, on: bool) {
        self.live[i as usize] = on;
    }

    /// `(left, right)` of buffer `i`, whole blocks.
    #[inline]
    pub fn get(&self, i: u32) -> (&[f32], &[f32]) {
        let w = 2 * self.block;
        self.data[i as usize * w..(i as usize + 1) * w].split_at(self.block)
    }

    #[inline]
    pub fn get_mut(&mut self, i: u32) -> (&mut [f32], &mut [f32]) {
        let w = 2 * self.block;
        self.data[i as usize * w..(i as usize + 1) * w].split_at_mut(self.block)
    }

    /// Make buffer `i` silent (and not live).
    pub fn silence(&mut self, i: u32) {
        if self.live[i as usize] {
            let (l, r) = self.get_mut(i);
            l.fill(0.0);
            r.fill(0.0);
            self.live[i as usize] = false;
        }
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// The run order of nodes `0..n` (`master` last). Topological over the edges (an edge writer ->
/// reader runs the writer first), ties broken by track order: `ranked` lists the non-master nodes in
/// that order. When only cycles remain, the first remaining node in `ranked` runs next, which cuts
/// the cycle there: whatever it reads from a node that has not run yet is that node's previous block.
/// Edges out of the master are back edges by construction (it runs last) and never constrain the order.
pub fn schedule(n: usize, master: u32, edges: &[Edge], ranked: &[u32]) -> Vec<u32> {
    let mut indeg = vec![0u32; n];
    let mut done = vec![false; n];
    // (writer, reader) pairs, deduplicated: two edges between the same nodes count once.
    let mut pairs: Vec<(u32, u32)> =
        edges.iter().map(|e| (e.from.node, e.to.node)).filter(|&(a, b)| a != b && a != master && (a as usize) < n && (b as usize) < n).collect();
    pairs.sort_unstable();
    pairs.dedup();
    for &(_, b) in &pairs {
        indeg[b as usize] += 1;
    }
    let mut order = Vec::with_capacity(n);
    while order.len() + 1 < n {
        let pick = ranked.iter().map(|&i| i as usize).find(|&i| !done[i] && indeg[i] == 0).or_else(|| ranked.iter().map(|&i| i as usize).find(|&i| !done[i]));
        let Some(k) = pick else { break };
        done[k] = true;
        order.push(k as u32);
        let from = pairs.partition_point(|&(a, _)| (a as usize) < k);
        for &(a, b) in pairs[from..].iter().take_while(|&&(a, _)| a as usize == k) {
            debug_assert_eq!(a as usize, k);
            indeg[b as usize] = indeg[b as usize].saturating_sub(1);
        }
    }
    if (master as usize) < n {
        order.push(master);
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tap(w: u32, r: u32) -> Edge {
        Edge::tap(w, BufKey::Tap(w), r, 0)
    }

    #[test]
    fn children_run_before_parents_and_the_master_last() {
        // 0 = bus, 1 and 2 are its children, 3 = master
        let e = [Edge::member(1, 0), Edge::member(2, 0), Edge::member(0, 3)];
        assert_eq!(schedule(4, 3, &e, &[0, 1, 2]), vec![1, 2, 0, 3]);
    }

    #[test]
    fn a_tap_orders_writer_before_reader_and_ties_keep_track_order() {
        // track 0 reads track 2's tap; 1 is independent
        let e = [Edge::member(0, 3), Edge::member(1, 3), Edge::member(2, 3), tap(2, 0)];
        assert_eq!(schedule(4, 3, &e, &[0, 1, 2]), vec![1, 2, 0, 3]);
        assert_eq!(schedule(4, 3, &e, &[2, 1, 0]), vec![2, 1, 0, 3], "ties follow the ranking, not the node number");
    }

    #[test]
    fn a_two_node_cycle_runs_the_lower_track_first() {
        let e = [Edge::member(0, 2), Edge::member(1, 2), tap(0, 1), tap(1, 0)];
        assert_eq!(schedule(3, 2, &e, &[0, 1]), vec![0, 1, 2]);
        assert_eq!(schedule(3, 2, &e, &[1, 0]), vec![1, 0, 2], "the cut follows the ranking");
    }

    #[test]
    fn reading_the_master_tap_never_constrains_the_order() {
        let e = [Edge::member(0, 1), tap(1, 0)];
        assert_eq!(schedule(2, 1, &e, &[0]), vec![0, 1]);
    }

    #[test]
    fn buffers_keep_their_contents_across_a_rebuild() {
        let mut b = Bufs::new(4);
        b.rebuild(vec![BufKey::Out(7), BufKey::Tap(3)]);
        let i = b.index(BufKey::Out(7));
        b.get_mut(i).0[1] = 0.5;
        b.set_live(i, true);
        b.rebuild(vec![BufKey::Out(2), BufKey::Out(7), BufKey::MasterTap]);
        let j = b.index(BufKey::Out(7));
        assert_eq!(b.get(j).0[1], 0.5);
        assert!(b.is_live(j));
        assert_eq!(b.index(BufKey::Tap(3)), NONE);
        assert!(!b.is_live(b.index(BufKey::Out(2))));
    }
}
