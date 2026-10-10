/** Local projects live on this device only; their ids can never collide with a cloud project id. */
export const LOCAL_PREFIX = 'local-'
export const isLocalId = (id: string) => id.startsWith(LOCAL_PREFIX)
export const newLocalId = () => LOCAL_PREFIX + crypto.randomUUID().replace(/-/g, '').slice(0, 16)
/** The IndexedDB database holding a local project's Yjs document. */
export const docDb = (id: string) => `mobdaw-doc:${id}`
