// Moving whole projects between "on this device", the cloud, and `.mobdaw` files.
import { samplesMap, type Me } from '@mobdaw/shared'
import * as Y from 'yjs'
import { api } from './api'
import { listAudio, putAudio } from './local/audio'
import { createLocal, getLocal, removeLocal, type LocalProject } from './local/projects'
import { readLocalState, writeLocalState } from './local/session'
import { readProjectFile, type ProjectContents } from './projectFile'
import { openSession } from './project/session'
import { uploadToProject } from './samples'

export type Progress = (message: string) => void

/** Everything in a project on this device: its saved document and its audio. */
export async function collectLocal(id: string): Promise<ProjectContents> {
  const p = getLocal(id)
  if (!p) throw new Error('Project not found on this device.')
  const [state, audio] = await Promise.all([readLocalState(id), listAudio(id)])
  return { name: p.name, state, audio: audio.map((a) => ({ hash: a.hash, mime: a.mime, name: a.name, blob: a.blob })) }
}

/** Everything in a cloud project: the live document and the audio it uses (downloaded from the project's library). */
export async function collectCloud(id: string, me: Pick<Me, 'username'>, progress?: Progress): Promise<ProjectContents> {
  const detail = await api.project(id)
  const session = openSession(id, me)
  try {
    await session.synced
    const state = Y.encodeStateAsUpdate(session.doc)
    const metas = Object.values(samplesMap(session.doc).toJSON())
    const audio: ProjectContents['audio'] = []
    for (const [i, m] of metas.entries()) {
      progress?.(`${detail.name}: downloading audio ${i + 1} of ${metas.length}…`)
      try {
        const { url } = await api.sampleUrl(id, m.hash)
        const res = await fetch(url)
        if (res.ok) audio.push({ hash: m.hash, mime: m.mime, name: m.name, blob: await res.blob() })
      } catch {
        // The audio's owner deleted it: it is simply missing from the project now, as it is for everyone.
      }
    }
    return { name: detail.name, state, audio }
  } finally {
    session.destroy()
  }
}

/** Save contents as a new project on this device. */
export async function importToLocal(c: ProjectContents): Promise<LocalProject> {
  const p = createLocal(c.name)
  try {
    await writeLocalState(p.id, c.state)
    for (const a of c.audio) await putAudio({ project: p.id, hash: a.hash, blob: a.blob, mime: a.mime, name: a.name, size: a.blob.size })
  } catch (e) {
    await removeLocal(p.id)
    throw e
  }
  return p
}

export async function importProjectFile(file: File): Promise<LocalProject> {
  return importToLocal(await readProjectFile(file))
}

/**
 * Put a project from this device into the cloud: a new cloud project owned by the signed-in account, with all of its
 * audio uploaded (each file becomes one of the account's own uploads). The device copy is left in place.
 */
export async function localToCloud(id: string, me: Pick<Me, 'username'>, progress?: Progress): Promise<string> {
  const c = await collectLocal(id)
  const project = await api.createProject({ name: c.name })
  try {
    for (const [i, a] of c.audio.entries()) {
      progress?.(`Uploading audio ${i + 1} of ${c.audio.length}…`)
      await uploadToProject(project.id, a.blob, a.hash, a.mime, a.name || a.hash.slice(0, 12))
    }
    progress?.('Saving the project…')
    const session = openSession(project.id, me)
    try {
      await session.synced
      Y.applyUpdate(session.doc, c.state)
      // wait until the server has the edit before closing the connection
      while (session.provider!.unsyncedChanges > 0) await new Promise((r) => setTimeout(r, 50))
    } finally {
      session.destroy()
    }
  } catch (e) {
    await api.deleteProject(project.id).catch(() => {}) // don't leave a half-uploaded project behind
    throw e
  }
  return project.id
}

/** Copy a cloud project to this device (for working offline, or to keep after a subscription ends). */
export async function cloudToLocal(id: string, me: Pick<Me, 'username'>, progress?: Progress): Promise<LocalProject> {
  return importToLocal(await collectCloud(id, me, progress))
}
