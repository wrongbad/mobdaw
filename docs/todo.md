# To do

- **MIDI editor gesture cancel uses `undo.undo()`.** When a second pointer cancels a note drag, the editor rolls back with `undo.undo()` and clears the redo stack (`client/src/ui/noteEditor.ts`, dc763a1). If the drag hasn't recorded its own undo step by then, this undoes the user's previous edit instead. Fix: snapshot the affected notes at drag start and restore them on cancel without touching the undo stack. Add a test.
