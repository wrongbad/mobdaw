import { describe, expect, it } from 'vitest'
import { ProjectFileError, readProjectFile, writeProjectFile } from '../src/projectFile'

const hash = (c: string) => c.repeat(64)
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer())

describe('project file', () => {
  it('round-trips the document state and every audio file byte for byte', async () => {
    const state = new Uint8Array([1, 2, 3, 4, 5])
    const a = new Uint8Array(1000).map((_, i) => i % 251), b = new Uint8Array([9, 8, 7])
    const file = writeProjectFile({
      name: 'My song', state,
      audio: [
        { hash: hash('a'), mime: 'audio/wav', name: 'kick.wav', blob: new Blob([a]) },
        { hash: hash('b'), mime: 'audio/flac', name: 'snare.flac', blob: new Blob([b]) },
      ],
    })
    const back = await readProjectFile(new File([file], 'x.mobdaw'))
    expect(back.name).toBe('My song')
    expect([...back.state]).toEqual([...state])
    expect(back.audio.map((x) => [x.hash, x.mime, x.name])).toEqual([[hash('a'), 'audio/wav', 'kick.wav'], [hash('b'), 'audio/flac', 'snare.flac']])
    expect([...(await bytesOf(back.audio[0].blob))]).toEqual([...a])
    expect([...(await bytesOf(back.audio[1].blob))]).toEqual([...b])
    expect(back.audio[0].blob.type).toBe('audio/wav')
  })

  it('handles a project with no audio, and unicode names', async () => {
    const back = await readProjectFile(writeProjectFile({ name: 'Ünï — 歌', state: new Uint8Array(), audio: [] }))
    expect(back).toMatchObject({ name: 'Ünï — 歌', audio: [] })
    expect(back.state.byteLength).toBe(0)
  })

  it('rejects things that are not project files, and files that were cut short', async () => {
    await expect(readProjectFile(new Blob(['hello']))).rejects.toBeInstanceOf(ProjectFileError)
    await expect(readProjectFile(new Blob([new Uint8Array(100)]))).rejects.toBeInstanceOf(ProjectFileError)
    const good = writeProjectFile({ name: 'p', state: new Uint8Array([1]), audio: [{ hash: hash('c'), mime: 'audio/wav', name: '', blob: new Blob([new Uint8Array(50)]) }] })
    await expect(readProjectFile(good.slice(0, good.size - 10))).rejects.toThrow(/valid mobdaw project file/) // audio runs past the end
  })

  it('rejects a manifest that points outside the file or names a bad hash', async () => {
    const forge = (manifest: object) => {
      const json = new TextEncoder().encode(JSON.stringify(manifest))
      const head = new Uint8Array(12)
      head.set(new TextEncoder().encode('MOBDAWP1'))
      new DataView(head.buffer).setUint32(8, json.byteLength, true)
      return new Blob([head, json, new Uint8Array(10)])
    }
    const base = { app: 'mobdaw', name: 'x', doc: { offset: 0, length: 4 } }
    await expect(readProjectFile(forge({ ...base, audio: [{ hash: 'nothex', mime: 'a/b', name: '', size: 1, offset: 4 }] }))).rejects.toBeInstanceOf(ProjectFileError)
    await expect(readProjectFile(forge({ ...base, doc: { offset: 0, length: 999 }, audio: [] }))).rejects.toBeInstanceOf(ProjectFileError)
    await expect(readProjectFile(forge({ ...base, audio: [{ hash: hash('d'), mime: 'a/b', name: '', size: 5, offset: -1 }] }))).rejects.toBeInstanceOf(ProjectFileError)
    await expect(readProjectFile(forge({ app: 'other', name: 'x', doc: { offset: 0, length: 0 }, audio: [] }))).rejects.toBeInstanceOf(ProjectFileError)
  })
})
