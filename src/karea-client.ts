const KAREA_URL = process.env.KAREA_URL || 'http://localhost:3002'
const KAREA_API_KEY = process.env.KAREA_API_KEY || ''

/**
 * KA395: per-call credentials.
 *
 * Over stdio there is one user for the life of the process, so environment
 * variables are fine. The hosted HTTP server serves many users concurrently
 * from one process, and a module-level API key would mean every request
 * racing to act as whoever configured the last one.
 *
 * AsyncLocalStorage carries the caller's identity down through every await
 * without changing the signature of the sixty-odd functions below. The env
 * vars stay as the fallback, so stdio behaviour is untouched.
 */
import { AsyncLocalStorage } from 'async_hooks'

export interface KareaCallContext { baseUrl: string; apiKey: string }
const callContext = new AsyncLocalStorage<KareaCallContext>()

/** Run `fn` with these credentials. Everything it awaits inherits them. */
export function withKareaContext<T>(ctx: KareaCallContext, fn: () => Promise<T>): Promise<T> {
  return callContext.run(ctx, fn)
}

async function request(path: string, options: RequestInit = {}) {
  const ctx = callContext.getStore()
  const baseUrl = ctx?.baseUrl || KAREA_URL
  const apiKey = ctx?.apiKey || KAREA_API_KEY
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...options.headers,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || body.response || `API error: ${res.status}`)
  }

  return res.json()
}

// KA364: cache the project list in-process for a short window. Every tool
// call that accepts a `projectId` used to fire GET /api/projects first to
// resolve name → id - doubling the wall-clock latency of every context /
// markdown / resource call. Same MCP process reuses the cache within the TTL.
const PROJECTS_TTL_MS = 30_000
let projectsCache: { at: number; value: any[] } | null = null

export async function listProjects(): Promise<any[]> {
  const now = Date.now()
  if (projectsCache && now - projectsCache.at < PROJECTS_TTL_MS) return projectsCache.value
  const value = await request('/api/projects') as any[]
  projectsCache = { at: now, value }
  return value
}

export function invalidateProjectsCache() { projectsCache = null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function listTasks(opts: {
  projectId?: string
  status?: string
  closedSince?: string
  limit?: number
  slim?: boolean
  // KA407: server-side narrowing to avoid pulling everything and post-filtering.
  category?: string
  priority?: string
  assignee?: string
  search?: string
} = {}) {
  const params = new URLSearchParams({ format: 'json' })
  if (opts.projectId) params.set('projectId', opts.projectId)
  if (opts.status) params.set('status', opts.status)
  if (opts.closedSince) params.set('closedSince', opts.closedSince)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.category) params.set('category', opts.category)
  if (opts.priority) params.set('priority', opts.priority)
  if (opts.assignee) params.set('assignee', opts.assignee)
  if (opts.search) params.set('search', opts.search)
  if (opts.slim !== false) params.set('slim', '1')
  return request(`/api/tasks/export?${params}`)
}

export async function resolveProjectId(nameOrId: string): Promise<string | undefined> {
  // KA364: skip the HTTP round-trip when the caller already gave us a UUID.
  if (UUID_RE.test(nameOrId)) return nameOrId
  const projects = await listProjects()
  const match = projects.find((p: any) =>
    p.id === nameOrId || p.name.toLowerCase() === nameOrId.toLowerCase()
  )
  return match?.id
}

export async function sendCommand(input: string, projectId?: string) {
  return request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ input, projectId }),
  })
}

export async function getRecap(projectId?: string, hours = 24) {
  const params = new URLSearchParams({ hours: String(hours) })
  if (projectId) params.set('projectId', projectId)
  return request(`/api/tasks/recap?${params}`)
}

export async function getTask(taskId: string) {
  return request(`/api/tasks/${taskId}`)
}

export async function updateTask(taskId: string, data: Record<string, unknown>) {
  return request(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(data) })
}

/**
 * KA540: one request that changes many tasks. See /api/tasks/bulk.
 */
export async function bulkUpdateTasks(body: Record<string, unknown>) {
  return request('/api/tasks/bulk', { method: 'PATCH', body: JSON.stringify(body) })
}

export async function createTaskDirect(data: Record<string, unknown>) {
  return request('/api/tasks', { method: 'POST', body: JSON.stringify(data) })
}

export async function getMarkdown(task: string, projectId?: string) {
  const params = new URLSearchParams({ task })
  if (projectId) params.set('projectId', projectId)
  return request(`/api/tasks/markdown?${params}`)
}

export async function setMarkdown(task: string, markdown: string, projectId?: string) {
  return request('/api/tasks/markdown', {
    method: 'PUT',
    body: JSON.stringify({ task, markdown, projectId }),
  })
}

export async function getContext(task: string, projectId?: string) {
  const params = new URLSearchParams({ task })
  if (projectId) params.set('projectId', projectId)
  return request(`/api/tasks/context?${params}`)
}

export async function setContext(task: string, context: string, projectId?: string, title?: string) {
  return request('/api/tasks/context', {
    method: 'PUT',
    body: JSON.stringify({ task, context, projectId, title }),
  })
}

export async function listQuestions(projectId?: string, status?: string) {
  const params = new URLSearchParams()
  if (projectId) params.set('projectId', projectId)
  if (status) params.set('status', status)
  return request(`/api/questions?${params}`)
}

export async function createQuestion(data: { projectId: string; question: string; markdown?: string; taskIds?: string[] }) {
  return request('/api/questions', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateQuestion(id: string, data: any) {
  return request(`/api/questions/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
}

export async function deleteQuestion(id: string) {
  return request(`/api/questions/${id}`, { method: 'DELETE' })
}

export async function listResources(opts: { projectId?: string; query?: string; folder?: string; type?: string; mime?: string; minSize?: number; maxSize?: number } = {}) {
  const params = new URLSearchParams()
  if (opts.projectId) params.set('projectId', opts.projectId)
  if (opts.query) params.set('q', opts.query)
  if (opts.folder) params.set('folder', opts.folder)
  if (opts.type) params.set('type', opts.type)
  if (opts.mime) params.set('mime', opts.mime)
  if (opts.minSize != null) params.set('minSize', String(opts.minSize))
  if (opts.maxSize != null) params.set('maxSize', String(opts.maxSize))
  const data = await request(`/api/resources?${params}`)
  return data.resources || data
}

export async function getResource(id: string) {
  return request(`/api/resources/${id}`)
}

// Download the raw bytes of a file resource as a base64 string plus its
// mime type. Uses the existing `?inline=1` handler which streams decrypted
// R2 content back through the API.
export async function downloadResourceBytes(id: string): Promise<{ base64: string; mimeType: string; sizeBytes: number }> {
  // KA395: this one bypasses request() because it wants bytes, not JSON, so
  // it has to read the per-call context itself or it would keep using the
  // process-wide key on the hosted server.
  const ctx = callContext.getStore()
  const res = await fetch(`${ctx?.baseUrl || KAREA_URL}/api/resources/${id}?inline=1`, {
    headers: { 'Authorization': `Bearer ${ctx?.apiKey || KAREA_API_KEY}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Resource download failed: ${res.status} ${body.slice(0, 200)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  return {
    base64: buf.toString('base64'),
    mimeType: res.headers.get('content-type') || 'application/octet-stream',
    sizeBytes: buf.length,
  }
}

export async function createTextResource(data: { name: string; content: string; projectId?: string | null; folder?: string | null }) {
  return request('/api/resources', {
    method: 'POST',
    body: JSON.stringify({ type: 'text', ...data }),
  })
}

export async function updateResource(id: string, data: { name?: string; content?: string; folder?: string | null; projectId?: string | null }) {
  return request(`/api/resources/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteResource(id: string) {
  return request(`/api/resources/${id}`, { method: 'DELETE' })
}

export async function linkResourceToTask(resourceId: string, taskId: string) {
  return request(`/api/resources/${resourceId}/link`, {
    method: 'POST',
    body: JSON.stringify({ taskId }),
  })
}

export async function unlinkResourceFromTask(resourceId: string, taskId: string) {
  return request(`/api/resources/${resourceId}/link?taskId=${taskId}`, {
    method: 'DELETE',
  })
}

export async function listNotes(taskId: string) {
  return request(`/api/tasks/${taskId}/notes`)
}

// KA422 reminders
export async function listReminders(opts: { taskId?: string; includeDone?: boolean } = {}) {
  const p = new URLSearchParams()
  if (opts.taskId) p.set('taskId', opts.taskId)
  if (opts.includeDone) p.set('includeDone', '1')
  const data = await request(`/api/reminders?${p}`)
  return data.items || []
}
export async function pendingReminders() {
  const data = await request('/api/reminders/pending')
  return data.items || []
}
export async function createReminder(payload: { taskId: string; title?: string | null; fireAt: string; repeat?: 'daily' | 'weekly' | 'monthly' | null; emailOptIn?: boolean }) {
  return request('/api/reminders', { method: 'POST', body: JSON.stringify(payload) })
}
export async function patchReminder(id: string, payload: Record<string, unknown>) {
  return request(`/api/reminders/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
}
export async function deleteReminder(id: string) {
  return request(`/api/reminders/${id}`, { method: 'DELETE' })
}

export async function listAISessions(taskId: string) {
  return request(`/api/tasks/${taskId}/ai-sessions`)
}

export async function linkAISession(taskId: string, data: { provider: string; sessionId: string; label?: string }) {
  return request(`/api/tasks/${taskId}/ai-sessions`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function unlinkAISession(taskId: string, sessionRowId: string) {
  return request(`/api/tasks/${taskId}/ai-sessions?sessionRowId=${sessionRowId}`, {
    method: 'DELETE',
  })
}

export async function addNote(taskId: string, content: string, source = 'mcp') {
  return request(`/api/tasks/${taskId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ content, source }),
  })
}

export async function updateNote(taskId: string, noteId: string, content: string) {
  return request(`/api/tasks/${taskId}/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ content }) })
}

export async function deleteNote(taskId: string, noteId: string) {
  return request(`/api/tasks/${taskId}/notes/${noteId}`, { method: 'DELETE' })
}

export async function listSubtasks(taskId: string) {
  return request(`/api/tasks/${taskId}/subtasks`)
}

export async function createSubtask(taskId: string, data: { title: string; priority?: number }) {
  return request(`/api/tasks/${taskId}/subtasks`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function addRequisite(taskId: string, description: string) {
  return request(`/api/tasks/${taskId}/requisites`, {
    method: 'POST',
    body: JSON.stringify({ description }),
  })
}

export async function toggleRequisite(taskId: string, requisiteId: string, completed: boolean) {
  return request(`/api/tasks/${taskId}/requisites`, {
    method: 'PATCH',
    body: JSON.stringify({ requisiteId, completed }),
  })
}

export async function deleteRequisite(taskId: string, requisiteId: string) {
  return request(`/api/tasks/${taskId}/requisites?requisiteId=${requisiteId}`, { method: 'DELETE' })
}

export async function uploadResource(name: string, data: string, mimeType?: string, folder?: string, taskId?: string) {
  return request('/api/resources/upload-base64', {
    method: 'POST',
    body: JSON.stringify({ name, data, mimeType, folder, taskId }),
  })
}

export async function getJiraLink(taskId: string) {
  return request(`/api/tasks/${taskId}/jira-link`)
}

export async function linkJira(taskId: string, issueKey: string) {
  return request(`/api/tasks/${taskId}/jira-link`, {
    method: 'POST',
    body: JSON.stringify({ issueKey }),
  })
}

export async function unlinkJira(taskId: string) {
  return request(`/api/tasks/${taskId}/jira-link`, { method: 'DELETE' })
}

// Task-to-task links. GET returns both directions: `outgoing` (this task is the
// source) and `incoming` (this task is the target), each with the link's own id
// which is what DELETE needs.
export async function getTaskLinks(taskId: string) {
  return request(`/api/tasks/${taskId}/links`)
}

export async function linkTask(taskId: string, targetTaskId: string, linkType = 'related') {
  return request(`/api/tasks/${taskId}/links`, {
    method: 'POST',
    body: JSON.stringify({ targetTaskId, linkType }),
  })
}

export async function unlinkTask(taskId: string, linkId: string) {
  return request(`/api/tasks/${taskId}/links?linkId=${encodeURIComponent(linkId)}`, { method: 'DELETE' })
}

// ─── Meetings (KA465) ──────────────────────────────────────────────────────
// Meetings belong to a USER, not a project: a person's calendar spans projects.
// `projectId` is an optional association, so none of these take a project the
// way task calls do.

export async function listMeetings(filters: {
  from?: string
  to?: string
  projectId?: string
  scope?: 'upcoming' | 'past'
} = {}) {
  const params = new URLSearchParams()
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.projectId) params.set('projectId', filters.projectId)
  if (filters.scope) params.set('scope', filters.scope)
  const qs = params.toString()
  return request(`/api/meetings${qs ? `?${qs}` : ''}`)
}

export async function getMeeting(meetingId: string) {
  return request(`/api/meetings/${meetingId}`)
}

export async function createMeeting(data: Record<string, unknown>) {
  return request('/api/meetings', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateMeeting(meetingId: string, data: Record<string, unknown>) {
  return request(`/api/meetings/${meetingId}`, { method: 'PATCH', body: JSON.stringify(data) })
}

export async function deleteMeeting(meetingId: string) {
  return request(`/api/meetings/${meetingId}`, { method: 'DELETE' })
}

export async function getMeetingTasks(meetingId: string) {
  return request(`/api/meetings/${meetingId}/tasks`)
}

export async function linkTaskToMeeting(meetingId: string, taskId: string) {
  return request(`/api/meetings/${meetingId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ taskId }),
  })
}

export async function unlinkTaskFromMeeting(meetingId: string, taskId: string) {
  return request(`/api/meetings/${meetingId}/tasks?taskId=${encodeURIComponent(taskId)}`, { method: 'DELETE' })
}

export async function linkQuestionToMeeting(meetingId: string, questionId: string) {
  return request(`/api/meetings/${meetingId}/questions`, {
    method: 'POST',
    body: JSON.stringify({ questionId }),
  })
}

export async function unlinkQuestionFromMeeting(meetingId: string, questionId: string) {
  return request(`/api/meetings/${meetingId}/questions?questionId=${encodeURIComponent(questionId)}`, { method: 'DELETE' })
}

// The meeting side of a task: /api/tasks/[id] does NOT include meetings, so
// karea_view_task has to ask for them separately.
export async function getTaskMeetings(taskId: string) {
  return request(`/api/tasks/${taskId}/meetings`)
}

// KA510: sticky notes. The scratch layer - no status, no deadline, nothing to
// close. Kept on the same client so an agent can jot something down without a
// second transport.
export async function listStickyNotes(projectId?: string) {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return request(`/api/sticky-notes${qs}`)
}

export async function createStickyNote(body: {
  title?: string; content: string; color?: string; projectId?: string | null; pinned?: boolean
}) {
  return request('/api/sticky-notes', { method: 'POST', body: JSON.stringify(body) })
}

export async function editStickyNote(id: string, body: Record<string, unknown>) {
  return request(`/api/sticky-notes/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export async function deleteStickyNote(id: string) {
  return request(`/api/sticky-notes/${id}`, { method: 'DELETE' })
}

/**
 * KA561: the user's timezone, so times are reported as they read them.
 *
 * Every datetime the MCP surface printed went through `toLocaleString()` with
 * no zone, which resolves to the SERVER's - UTC in the container. A task due
 * at 15:30 Madrid was reported to the agent as 13:30, and the agent then told
 * the user 13:30 with complete confidence. A two hour error is worse than no
 * time at all, because nothing about it looks wrong.
 *
 * Cached per API key for the life of the process: it is one small request, it
 * almost never changes, and the alternative is paying for it on every tool
 * call that happens to print a date.
 */
const tzCache = new Map<string, string>()

export async function getUserTimezone(): Promise<string> {
  const ctx = callContext.getStore()
  const key = `${ctx?.baseUrl || KAREA_URL}|${ctx?.apiKey || KAREA_API_KEY}`
  const cached = tzCache.get(key)
  if (cached) return cached
  try {
    const settings = await request('/api/settings') as { timezone?: unknown } | null
    const raw = settings?.timezone
    const tz = typeof raw === 'string' && raw ? raw : 'UTC'
    tzCache.set(key, tz)
    return tz
  } catch {
    // A missing timezone must not break the tool that wanted to print a date.
    return 'UTC'
  }
}
