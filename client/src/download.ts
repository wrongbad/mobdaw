/** Hand a blob to the browser as a file download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** A filename that every OS accepts. */
export const safeName = (s: string, fallback = 'untitled') => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || fallback
