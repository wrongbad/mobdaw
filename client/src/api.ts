import type {
  AddMemberRequest, CreateInviteRequest, CreateInviteResponse, CreateProjectRequest, InviteInfo,
  LibrarySample, LoginRequest, LoginResponse, Me, ProjectDetail, ProjectSummary, RegisterRequest, UploadInfo, UploadUrlRequest,
  UploadUrlResponse, UrlResponse, UserInfo,
} from '@mobdaw/shared'

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

const TOKEN_KEY = 'mobdaw_token'
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(import.meta.env.BASE_URL + 'api' + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) localStorage.removeItem(TOKEN_KEY)
    throw new ApiError(res.status, data.error ?? 'error')
  }
  return data as T
}

const get = <T>(p: string) => req<T>('GET', p)
const post = <T>(p: string, b: unknown = {}) => req<T>('POST', p, b)
const del = <T>(p: string) => req<T>('DELETE', p)

export const api = {
  me: () => get<Me>('/me'),
  async login(b: LoginRequest) {
    const r = await post<LoginResponse>('/auth/login', b)
    localStorage.setItem(TOKEN_KEY, r.token)
    return r.me
  },
  async register(b: RegisterRequest) {
    const r = await post<LoginResponse>('/auth/register', b)
    localStorage.setItem(TOKEN_KEY, r.token)
    return r.me
  },
  async logout() {
    localStorage.removeItem(TOKEN_KEY)
    await post('/auth/logout').catch(() => {})
  },
  users: () => get<UserInfo[]>('/users'),
  invites: () => get<InviteInfo[]>('/invites'),
  createInvite: (b: CreateInviteRequest) => post<CreateInviteResponse>('/invites', b),
  projects: () => get<ProjectSummary[]>('/projects'),
  project: (id: string) => get<ProjectDetail>(`/projects/${id}`),
  createProject: (b: CreateProjectRequest) => post<ProjectSummary>('/projects', b),
  renameProject: (id: string, name: string) => req<ProjectDetail>('PATCH', `/projects/${id}`, { name }),
  deleteProject: (id: string) => del(`/projects/${id}`),
  copyProject: (id: string) => post<ProjectDetail>(`/projects/${id}/copy`),
  leaveProject: (id: string) => post(`/projects/${id}/leave`),
  addMember: (id: string, b: AddMemberRequest) => post<ProjectDetail>(`/projects/${id}/members`, b),
  removeMember: (id: string, username: string) => del<ProjectDetail>(`/projects/${id}/members/${encodeURIComponent(username)}`),
  library: (id: string) => get<LibrarySample[]>(`/projects/${id}/samples`),
  uploadUrl: (id: string, b: UploadUrlRequest) => post<UploadUrlResponse>(`/projects/${id}/samples/upload-url`, b),
  completeSample: (id: string, hash: string) => post(`/projects/${id}/samples/${hash}/complete`),
  sampleUrl: (id: string, hash: string) => get<UrlResponse>(`/projects/${id}/samples/${hash}/url`),
  uploads: () => get<UploadInfo[]>('/uploads'),
  deleteUpload: (hash: string) => del(`/uploads/${hash}`),
  uploadFileUrl: (hash: string) => get<UrlResponse>(`/uploads/${hash}/url`),
  async deleteAccount(password: string) {
    await post('/me/delete', { password })
    localStorage.removeItem(TOKEN_KEY)
  },
}
