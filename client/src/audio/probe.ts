// What an audio file is (container, encoding, sample rate, channels) and a small waveform of it, measured in the browser.
// WAV is read straight from its PCM in chunks (no decode, any size); other formats get their header sniffed, and their
// waveform comes from a normal decode when the file is small enough for that.
import type { AudioInfo } from '@mobdaw/shared'

/** Columns in a stored waveform. One byte each: the bar height (0..255) on the dB-ish scale `shape` gives. */
export const PEAK_BUCKETS = 192
/** Amplitude at (or below) which the drawn wave has zero height. */
export const FLOOR_DB = -48
/** Above this a compressed file is not decoded just to draw it (decoding holds the whole thing as floats). */
export const DECODE_MAX_BYTES = 200 * 1024 * 1024

/** Amplitude 0..1 -> height 0..1; linear in dB so quiet material stays visible. */
export const shape = (a: number) => (a <= 0 ? 0 : Math.max(0, 1 - (20 * Math.log10(a)) / FLOOR_DB))

const tag = (v: DataView, o: number, n = 4) => {
  let s = ''
  for (let i = 0; i < n && o + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(o + i))
  return s
}

export type Analysis = { info: AudioInfo; peaks: Uint8Array }

type Header = Omit<AudioInfo, 'duration'> & { duration: number | null }

// --- WAV
type WavFormat = { tag: number; channels: number; rate: number; bits: number; blockAlign: number }
type Wav = { fmt: WavFormat; dataStart: number; dataLen: number }

function parseWav(v: DataView, fileSize: number): Wav | null {
  const magic = tag(v, 0)
  if ((magic !== 'RIFF' && magic !== 'RF64') || tag(v, 8) !== 'WAVE') return null
  let fmt: WavFormat | null = null
  for (let p = 12; p + 8 <= v.byteLength; ) {
    const id = tag(v, p)
    const size = v.getUint32(p + 4, true)
    const body = p + 8
    if (id === 'fmt ' && body + 16 <= v.byteLength) {
      let t = v.getUint16(body, true)
      const bits = v.getUint16(body + 14, true)
      if (t === 0xfffe && size >= 26 && body + 26 <= v.byteLength) t = v.getUint16(body + 24, true) // extensible: the sub-format
      fmt = { tag: t, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), blockAlign: v.getUint16(body + 12, true), bits }
    } else if (id === 'data') {
      if (!fmt || !fmt.blockAlign || !fmt.channels) return null
      // A streamed file may say 0 or 0xFFFFFFFF: take everything to the end.
      const avail = fileSize - body
      const len = size === 0 || size === 0xffffffff || size > avail ? avail : size
      return { fmt, dataStart: body, dataLen: len }
    }
    p = body + size + (size & 1)
  }
  return null
}

function wavEncoding(f: WavFormat) {
  if (f.tag === 1) return `${f.bits}-bit PCM`
  if (f.tag === 3) return `${f.bits}-bit float`
  return `format 0x${f.tag.toString(16)}`
}

/** A reader for one sample of this format, as -1..1; null when the layout is one we don't read. */
function sampleReader(f: WavFormat): ((v: DataView, o: number) => number) | null {
  const bytes = f.blockAlign / f.channels
  if (f.tag === 1) {
    if (bytes === 1) return (v, o) => (v.getUint8(o) - 128) / 128
    if (bytes === 2) return (v, o) => v.getInt16(o, true) / 32768
    if (bytes === 3) return (v, o) => ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608)
    if (bytes === 4) return (v, o) => v.getInt32(o, true) / 2147483648
  } else if (f.tag === 3) {
    if (bytes === 4) return (v, o) => v.getFloat32(o, true)
    if (bytes === 8) return (v, o) => v.getFloat64(o, true)
  }
  return null
}

async function wavPeaks(blob: Blob, w: Wav, read: (v: DataView, o: number) => number): Promise<Uint8Array> {
  const { fmt, dataStart } = w
  const frames = Math.floor(w.dataLen / fmt.blockAlign)
  if (frames <= 0) return new Uint8Array(0)
  const per = Math.max(1, Math.ceil(frames / PEAK_BUCKETS))
  const maxes = new Float32Array(Math.ceil(frames / per))
  const bytes = fmt.blockAlign / fmt.channels
  const chunk = Math.max(1, Math.floor((8 * 1024 * 1024) / fmt.blockAlign))
  for (let f0 = 0; f0 < frames; f0 += chunk) {
    const n = Math.min(chunk, frames - f0)
    const v = new DataView(await blob.slice(dataStart + f0 * fmt.blockAlign, dataStart + (f0 + n) * fmt.blockAlign).arrayBuffer())
    for (let i = 0; i < n; i++) {
      const b = Math.floor((f0 + i) / per)
      let m = maxes[b]
      for (let c = 0; c < fmt.channels; c++) {
        const a = Math.abs(read(v, i * fmt.blockAlign + c * bytes))
        if (a > m) m = a
      }
      maxes[b] = m
    }
  }
  return Uint8Array.from(maxes, (a) => Math.round(shape(Math.min(1, a)) * 255))
}

// --- headers of the other formats
function parseFlac(v: DataView): Header | null {
  if (tag(v, 0) !== 'fLaC' || v.byteLength < 42) return null
  const o = 8 // after the signature and the STREAMINFO block header
  const rate = (v.getUint8(o + 10) << 12) | (v.getUint8(o + 11) << 4) | (v.getUint8(o + 12) >> 4)
  const channels = ((v.getUint8(o + 12) >> 1) & 7) + 1
  const bits = (((v.getUint8(o + 12) & 1) << 4) | (v.getUint8(o + 13) >> 4)) + 1
  const total = (v.getUint8(o + 13) & 15) * 2 ** 32 + v.getUint32(o + 14)
  return { format: 'FLAC', encoding: `${bits}-bit lossless`, sampleRate: rate, channels, duration: rate && total ? total / rate : null }
}

const MP3_RATES = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]] // by version bits, then index
function parseMp3(v: DataView): Header | null {
  let p = 0
  if (tag(v, 0, 3) === 'ID3' && v.byteLength > 10)
    p = 10 + ((v.getUint8(6) << 21) | (v.getUint8(7) << 14) | (v.getUint8(8) << 7) | v.getUint8(9))
  for (; p + 4 <= v.byteLength; p++) {
    if (v.getUint8(p) !== 0xff || (v.getUint8(p + 1) & 0xe0) !== 0xe0) continue
    const version = (v.getUint8(p + 1) >> 3) & 3
    const layer = (v.getUint8(p + 1) >> 1) & 3
    const idx = (v.getUint8(p + 2) >> 2) & 3
    if (version === 1 || layer === 0 || idx === 3) continue
    const channels = ((v.getUint8(p + 3) >> 6) & 3) === 3 ? 1 : 2
    return { format: 'MP3', encoding: `MPEG layer ${4 - layer}, lossy`, sampleRate: MP3_RATES[version][idx], channels, duration: null }
  }
  return null
}

function parseOgg(v: DataView): Header | null {
  if (tag(v, 0) !== 'OggS' || v.byteLength < 28) return null
  const p = 27 + v.getUint8(26)
  if (tag(v, p + 1, 6) === 'vorbis' && p + 16 <= v.byteLength)
    return { format: 'Ogg Vorbis', encoding: 'Vorbis, lossy', channels: v.getUint8(p + 11), sampleRate: v.getUint32(p + 12, true), duration: null }
  if (tag(v, p, 8) === 'OpusHead' && p + 16 <= v.byteLength)
    return { format: 'Opus', encoding: 'Opus, lossy', channels: v.getUint8(p + 9), sampleRate: v.getUint32(p + 12, true), duration: null }
  return null
}

function parseIsoBmff(v: DataView): Header | null {
  if (tag(v, 4) !== 'ftyp') return null
  return { format: 'M4A', encoding: 'AAC, lossy', sampleRate: null, channels: 0, duration: null }
}

function parseAiff(v: DataView): Header | null {
  if (tag(v, 0) !== 'FORM' || (tag(v, 8) !== 'AIFF' && tag(v, 8) !== 'AIFC')) return null
  return { format: 'AIFF', encoding: 'PCM', sampleRate: null, channels: 0, duration: null }
}

const sniff = (v: DataView): Header | null => parseFlac(v) ?? parseMp3(v) ?? parseOgg(v) ?? parseIsoBmff(v) ?? parseAiff(v)

// --- decode fallback
function decodedPeaks(buf: AudioBuffer): Uint8Array {
  const per = Math.max(1, Math.ceil(buf.length / PEAK_BUCKETS))
  const maxes = new Float32Array(Math.ceil(buf.length / per))
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i])
      const b = Math.floor(i / per)
      if (a > maxes[b]) maxes[b] = a
    }
  }
  return Uint8Array.from(maxes, (a) => Math.round(shape(Math.min(1, a)) * 255))
}

/** Measure an audio file. Never rejects for an unreadable file: it comes back as `format: 'unknown'` with no waveform. */
export async function analyzeAudio(blob: Blob): Promise<Analysis> {
  const head = new DataView(await blob.slice(0, 1024 * 1024).arrayBuffer())
  const wav = parseWav(head, blob.size)
  const read = wav && sampleReader(wav.fmt)
  if (wav && read) {
    const { fmt } = wav
    const frames = Math.floor(wav.dataLen / fmt.blockAlign)
    return {
      info: { format: 'WAV', encoding: wavEncoding(fmt), sampleRate: fmt.rate, channels: fmt.channels, duration: fmt.rate ? frames / fmt.rate : null },
      peaks: await wavPeaks(blob, wav, read),
    }
  }
  const header: Header = wav
    ? { format: 'WAV', encoding: wavEncoding(wav.fmt), sampleRate: wav.fmt.rate, channels: wav.fmt.channels, duration: null }
    : sniff(head) ?? { format: 'unknown', encoding: '', sampleRate: null, channels: 0, duration: null }
  let peaks: Uint8Array = new Uint8Array(0)
  if (blob.size <= DECODE_MAX_BYTES && typeof OfflineAudioContext !== 'undefined') {
    try {
      const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer())
      peaks = decodedPeaks(buf)
      header.channels ||= buf.numberOfChannels
      header.duration ??= buf.duration
      if (header.format === 'unknown') header.format = 'audio'
    } catch {}
  }
  return { info: header, peaks }
}

export const peaksToBase64 = (p: Uint8Array) => btoa(String.fromCharCode(...p))
export const peaksFromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
