# Routing: buses, taps and side inputs (phase 1)

The data model is meant to grow into full modular patching; the UI discloses it in layers. Phase 1 builds the first layers:
**buses** (track groups with their own fx chain), **taps** (named signal points that `fx send` writes and `fx recv` reads),
and **side inputs** (the compressor's sidechain key). No graph editor, no modulation, no latency compensation yet.

## Model

- **Chains are the fast path.** Every track, bus and the master is a chain: an ordered list of devices, as today. A full graph is
  just chains of length one plus edges, so the model stays modular-complete while the common case stays a list.
- **Bus = a track with `kind: 'bus'`.** It has no clips, loopers or pads. Its chain's input is the sum of its children's outputs.
- **`parent?: string` on every track** (bus or not): the id of the bus it sums into. Absent means the master. The master is the root
  bus; it stays the implicit scope `MASTER_TRACK` (`'master'`), not a row in the tracks map.
- **Effective parent** (`effectiveParent`, shared): a `parent` counts only if it names an existing bus and following parents
  reaches the master without revisiting a track. Anything else resolves to the master. A parent cycle (two peers each dragging one
  bus into the other: both writes legal, the merge is a loop) is broken deterministically: the track in the cycle with the smallest
  id is detached to the master, then the rest resolve. Client, bridge, agent view and engine all use the effective parent, so the UI
  and the audio never disagree.
- **Order**: `order` sorts siblings (children of one parent). The UI shows the tree: a bus's children directly under it.
- **Taps**: a named point in the signal another chain can read.
  - Every track and bus has an **implicit tap**, id = the track's id: its chain's output *before* the mix device (post-fx,
    pre-fader, pre-mute). So turning the kick down or muting it does not change how it ducks the bass (a muted "ghost kick" still
    pumps).
  - The master has an implicit tap too (id `'master'`).
  - **`fx send`** (device kind 12): passes audio through unchanged and writes the signal at its position into a tap whose id is
    the send device's id and whose label is the device's `name`. Param: `gain` (dB, -60..+12, default 0) applied to the tap only.
  - **`fx recv`** (device kind 13): adds a tap's audio into the chain at its position. Param: `gain` (dB, -60..+12, default 0).
    A track or bus whose chain holds only a recv is a return; there is no separate return type.
- **`input?: string` on a device**: the tap it reads. `fx recv`'s main input; the compressor's sidechain key (absent = the
  compressor keys off its own input, as today). A tap that no longer exists reads silence, and the card says the tap is missing.
- **Taps are referenced by id and shown by label.** Renaming a send or a track never breaks a reference.
- **Cycles are legal.** A tap read before its writer has run this block yields the writer's previous block (one block of delay).
  Scheduling is deterministic (below), so every peer, the live engine and offline export produce the same audio.

Schema version 5 (old clients refuse to write a doc with a bus in it). No data migration: absent `parent` means the master and
absent `input` means none.

## Engine

- **Nodes** are chains: tracks, buses and the master. **Edges** are typed port-to-port links; phase 1 has audio edges only: child
  to parent (bus membership) and tap to consumer (recv, compressor key). Later node kinds (modules) and port types (control) plug
  into the same node and edge lists; chains stay a tight loop.
- **Pull model.** Each node keeps its output buffer and each tap its buffer, across blocks. A bus sums its children's output
  buffers when it runs; a consumer reads a tap's buffer when it runs. If the writer has not run yet this block, that is last block's
  audio: the one-block delay of a cycle needs no special case.
- **Schedule** (rebuilt in `rebuild_routing`, never on the audio path): topological order over the edges, ties broken by track
  order; when only cycles remain, the remaining node first in track order runs next. The master runs last.
- **Side inputs.** A device's process call can take an optional second stereo input; phase 1 only the compressor uses it (its
  detector reads the key, its gain applies to its own input).
- **Mute and solo.** A muted bus silences its subtree. Solo: the audible set is the soloed nodes, their ancestors, every descendant
  of a soloed bus, and every node downstream of an audible node through a tap that mixes audio, i.e. a `recv` reading it (so a soloed vocal's reverb return stays audible; a compressor key only listens, so soloing the kick does not unmute the keyed bass),
  plus the ancestors of those. The click track stays solo-safe.
- **No allocation on the audio thread**: tap and output buffers are preallocated (the `no_alloc` test stays green).
- **Meters**: buses meter like tracks.

## UI

- **A bus is a box around its tracks**: a thin frame in the bus's colour on the top and left, its tracks inside (in `order`; `treeRows`
  in `client/src/project/buses.ts`, from `trackTree`, is the list every place in the timeline uses), and the bus's own row at the bottom:
  a header (name, fold button, fader and pan, mute, solo, fx / auto / presets tabs) tinted with its colour, a body that is only a note
  ("3 tracks"; click it to fold), and its drawers below that. Buses nest (box in a box): the DOM nests too (a bus lane's `.kids`). Each
  frame takes a gutter's width off the left of the headers inside it, so every lane's time axis still starts at the same x; while the
  list scrolls sideways the headers' left shadows (`--bands`) paint the frames. Folding is local view state (`createCollapsed`, like the
  drawers): a folded bus is only its row; its lanes stay mounted, hidden.
- **Moving tracks**: drag a track header (`ui/trackDrag.ts`; a finger long-presses first, as with device cards). The lane follows the
  pointer and a line shows where it lands: the top edge of a lane is in front of it (for an open bus, the frame above its first track), the
  space under a bus's last track and the top of its own row are into the bus (last), the rest of that row is behind the bus, the rest of
  a track is behind it, below everything is the end of the master. Dragging a bus moves its
  subtree. Dropping into a folded bus opens it. The header menu (click, right-click, tap) has "move to bus ▸" (master, then every bus
  except the track itself and the buses inside it; the current one is ticked) and "new bus from this track" (a bus at the track's place,
  holding it). "+ bus" is in the add-track menu. All of it works by tap; drag is the shortcut.
- **The master is the root bus**: a box around every track, like a bus, with its own row (`TrackHead` / `mountLaneDrawers` with
  `MASTER_TRACK`) at the bottom, closing the track list. No fold button, mute, solo, drag or menu; its body note counts every track.
- **Cards**: `fx send` shows its editable label; `fx recv` shows a tap picker; the compressor has a "side chain" tap picker, shaped like a knob
  (the drop-down over its caption), at the top of its "input" section. The tap
  picker lists "none", then tracks and buses (their implicit taps), then sends by label, then the master.

## Later (not phase 1)

Patch view inside a module card, modulation (control ports: LFO / envelope follower to any knob), more side-input devices (ring
mod carrier, vocoder, gate), delay compensation once a device adds latency, a mixer view over the same model.
