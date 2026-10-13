// Reading the engine's level meters (docs/engine-api.md, "Meters"). Shared by the worklet and the tests.

/** The {type:'meters'} message: post-fader peaks (linear |x|) since the last read; `tracks` is flat `[handle, l, r, ...]`. */
export type MetersMessage = { master: [number, number]; tracks: number[] }

/**
 * Read and reset the engine's meters (`engine_meters_read`) into a message; `silent` when every peak is zero. The
 * buffer is master L, R, then per track the handle (u32 bits), L, R.
 */
export function readMeters(x: { memory: WebAssembly.Memory; engine_meters_read(e: number): number; engine_meters_ptr(e: number): number }, e: number): { m: MetersMessage; silent: boolean } {
  const n = x.engine_meters_read(e)
  const ptr = x.engine_meters_ptr(e) >>> 0
  const f = new Float32Array(x.memory.buffer, ptr, 2 + 3 * n)
  const u = new Uint32Array(x.memory.buffer, ptr, 2 + 3 * n)
  let any = f[0] !== 0 || f[1] !== 0
  const tracks: number[] = new Array(3 * n)
  for (let k = 0, i = 2; k < n; k++, i += 3) {
    tracks[3 * k] = u[i]
    tracks[3 * k + 1] = f[i + 1]
    tracks[3 * k + 2] = f[i + 2]
    if (f[i + 1] !== 0 || f[i + 2] !== 0) any = true
  }
  return { m: { master: [f[0], f[1]], tracks }, silent: !any }
}
