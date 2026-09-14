#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import * as karea from './karea-client'

function q(value: string): string {
  if (value.includes('"')) value = value.replace(/"/g, "'")
  if (/\s|^-/.test(value)) return `"${value}"`
  return value
}

// Build a consistent footer that surfaces UUID, short id (visual id), and a
// clickable Karea URL for any record an MCP tool just touched. Every
// mutation / lookup that returns a single record should pass through this so
// the LLM (and a human reading the chat) can always click straight back to
// the affected object.
type RecordKind = 'task' | 'resource' | 'project' | 'meeting'
// KA375: Link output should always land on the public-facing app, not on
// whichever internal API host the MCP happens to be talking to (dev, staging,
// proxy). `KAREA_PUBLIC_URL` lets callers override; otherwise we default to
// karea.app so a shared task link works for anyone who receives it. Only if
// neither is set do we fall back to KAREA_URL - that keeps local-dev
// (KAREA_URL=http://localhost:3002) usable without extra config.
function publicBase(): string {
  const explicit = process.env.KAREA_PUBLIC_URL
  if (explicit) return explicit.replace(/\/$/, '')
  const apiUrl = process.env.KAREA_URL || ''
  // Any URL that is NOT localhost / .kpilotlabs.com goes through as-is,
  // since the caller pointed at a real public deployment. Local dev + our
  // internal proxy hosts get rewritten to karea.app for shareable links.
  if (/^(https?:\/\/)?(localhost|127\.0\.0\.1|.*\.kpilotlabs\.com)(:|\/|$)/i.test(apiUrl)) {
    return 'https://karea.app'
  }
  return (apiUrl || 'https://karea.app').replace(/\/$/, '')
}
function recordFooter(kind: RecordKind, opts: { id?: string | null; displayId?: string | null }): string[] {
  const lines: string[] = []
  const base = publicBase()
  if (opts.id) lines.push(`ID: ${opts.id}`)
  if (opts.displayId) lines.push(`Short ID: ${opts.displayId}`)
  if (opts.id) {
    if (kind === 'task') lines.push(`Link: ${base}/dashboard/task/${opts.id}`)
    else if (kind === 'project') lines.push(`Link: ${base}/dashboard/${opts.id}`)
    else if (kind === 'resource') lines.push(`Link: ${base}/dashboard/resources`)
    // KA465: the meetings page opens a meeting from an ?open= deep link.
    else if (kind === 'meeting') lines.push(`Link: ${base}/dashboard/meetings?open=${opts.id}`)
  }
  return lines
}

const server = new McpServer({
  name: 'karea',
  version: '0.1.0',
})

// KA422: append pending reminders to EVERY tool response so an AI agent that
// hits any karea MCP call is always told about a live reminder. Best-effort;
// failures never break the primary response. Cached ~10s per-process to keep
// tight tool-storms cheap.
let _remCache: { at: number; text: string } | null = null
async function pendingReminderNudge(): Promise<string> {
  const now = Date.now()
  if (_remCache && now - _remCache.at < 10_000) return _remCache.text
  let text = ''
  try {
    const items = await karea.pendingReminders()
    if (items.length > 0) {
      const lines: string[] = ['', '⏰ Pending reminders:']
      for (const r of items.slice(0, 5)) {
        const t = r.task
        const display = t?.project?.prefix && typeof t?.seq === 'number' ? `${t.project.prefix}${t.seq}` : `#${(t?.id || '').slice(0, 6)}`
        const when = new Date(r.fireAt).toLocaleString()
        const title = r.title || t?.title || 'Reminder'
        lines.push(`  · [${r.id}] ${display} - ${title} (fires ${when})${r.repeat ? ` [repeat: ${r.repeat}]` : ''}`)
      }
      if (items.length > 5) lines.push(`  … and ${items.length - 5} more.`)
      lines.push('Snooze / dismiss / mark-done via karea_snooze_reminder / karea_dismiss_reminder / karea_mark_reminder_done. Full list via karea_check_reminders.')
      text = lines.join('\n')
    }
  } catch {}
  _remCache = { at: now, text }
  return text
}

// Wrap server.tool so every registered handler auto-appends the reminder
// nudge to its text response. Preserves the original signature exactly.
const _origTool = server.tool.bind(server)
;(server as any).tool = (name: string, ...rest: any[]) => {
  const handler = rest[rest.length - 1]
  if (typeof handler !== 'function') return (_origTool as any)(name, ...rest)
  const wrapped = async (...args: any[]) => {
    let result: any
    let thrown: any = null
    try {
      result = await handler(...args)
    } catch (err) {
      thrown = err
    }
    // Skip nudge for the reminder tools themselves.
    if (/reminder/i.test(name)) {
      if (thrown) throw thrown
      return result
    }
    const nudge = await pendingReminderNudge().catch(() => '')
    if (thrown) {
      // Wrap the thrown error as its own text block + nudge so the caller
      // still sees the reminder rather than a bare JSON-RPC error.
      const msg = thrown instanceof Error ? thrown.message : String(thrown)
      const content: any[] = [{ type: 'text', text: `Error: ${msg}` }]
      if (nudge) content.push({ type: 'text', text: nudge })
      return { content, isError: true }
    }
    if (!nudge) return result
    const content = Array.isArray(result?.content) ? [...result.content] : []
    content.push({ type: 'text', text: nudge })
    return { ...result, content }
  }
  const newRest = [...rest]
  newRest[newRest.length - 1] = wrapped
  return (_origTool as any)(name, ...newRest)
}

async function resolveProject(nameOrId?: string): Promise<string | undefined> {
  if (!nameOrId) return undefined
  return karea.resolveProjectId(nameOrId)
}

// KA367: shared session-link params. Any task-referencing tool that accepts
// these will atomically link the AI session to the target task after the
// primary operation succeeds. Best-effort - link failures never block or
// alter the primary tool's response.
const AI_PROVIDERS = ['claude-code', 'opencode', 'codex', 'cursor', 'aider', 'other'] as const
const sessionLinkFields = {
  aiSessionId: z.string().optional().describe('Optional: your current AI CLI session ID. When paired with toolType, atomically links this session to the affected task (equivalent to calling karea_link_session, but saves the round-trip). For Claude Code use the id from `claude --resume`.'),
  toolType: z.enum(AI_PROVIDERS).optional().describe('Optional: your AI provider ("claude-code" / "opencode" / "codex" / "cursor" / "aider" / "other"). Required when aiSessionId is supplied.'),
  sessionLabel: z.string().optional().describe('Optional short label for the linked session (e.g. "Feature draft").'),
}

async function maybeLinkSession(
  taskRef: string | undefined,
  params: { aiSessionId?: string; toolType?: string; sessionLabel?: string },
): Promise<string | null> {
  if (!params.aiSessionId || !params.toolType || !taskRef) return null
  try {
    // Resolve visual ID / title to a real UUID before hitting the sessions API.
    let taskId = taskRef
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
      const t = await karea.getTask(taskRef)
      taskId = t.id
    }
    await karea.linkAISession(taskId, {
      provider: params.toolType,
      sessionId: params.aiSessionId,
      label: params.sessionLabel,
    })
    return ` Linked ${params.toolType} session ${params.aiSessionId}.`
  } catch {
    // Silent - session linking is a convenience, not a hard requirement.
    return null
  }
}

// List projects
server.tool('karea_list_projects', 'List all Karea projects with their IDs', {}, async () => {
  const projects = await karea.listProjects()
  const list = projects.map((p: any) => `${p.name} - id: ${p.id} (${p._count?.tasks || 0} tasks, categories: ${p.categories?.map((c: any) => c.name).join(', ') || 'none'})`).join('\n')
  return { content: [{ type: 'text', text: list || 'No projects found.' }] }
})

// List tasks
server.tool('karea_list_tasks', 'List tasks in a project. Defaults to open tasks (open, in_progress, blocked, review, backlog) capped at 200 to keep responses small. To see closed tasks pass status="done" and optionally closedSince (e.g. "14d", "7d", "24h"). To list everything, pass status="all". Optional filters (category, priority, assignee, search) narrow the result server-side - prefer them over post-filtering.', {
  projectId: z.string().optional().describe('Project name or ID (omit for default project)'),
  status: z.string().optional().describe('Filter by status: open, in_progress, blocked, review, backlog, done, cancelled. Comma-separated allowed (e.g. "open,in_progress"). "all" returns every status.'),
  closedSince: z.string().optional().describe('Only return tasks closed since this window. Relative (e.g. "14d", "7d", "24h") or ISO date. Implies status=done unless status is set.'),
  limit: z.number().int().positive().max(1000).optional().describe('Max tasks to return (default 200, cap 1000).'),
  category: z.string().optional().describe('Category name or UUID. Comma-separated allowed (e.g. "Bugs,Improvements").'),
  priority: z.string().optional().describe('Priority 1–5. Comma-separated allowed (e.g. "1,2").'),
  assignee: z.string().optional().describe('Assignee - name, email, or user UUID.'),
  search: z.string().optional().describe('Case-insensitive substring match on the task title.'),
}, async ({ projectId, status, closedSince, limit, category, priority, assignee, search }) => {
  const pid = await resolveProject(projectId)

  let resolvedStatus = status
  if (closedSince && !status) resolvedStatus = 'done'
  if (resolvedStatus === 'all') resolvedStatus = undefined
  else if (!resolvedStatus) resolvedStatus = 'open,in_progress,blocked,review,backlog'

  const resolvedLimit = limit ?? 200

  const data = await karea.listTasks({
    projectId: pid,
    status: resolvedStatus,
    closedSince,
    limit: resolvedLimit,
    category,
    priority,
    assignee,
    search,
  })
  const tasks = data.tasks || []

  if (tasks.length === 0) return { content: [{ type: 'text', text: 'No tasks found.' }] }

  const lines = tasks.map((t: any) => {
    const did = t.displayId || (t.project?.prefix && t.seq != null ? `${t.project.prefix}${t.seq}` : null)
    const parts = [did || `P${t.priority}`, `[${t.status}]`, t.title]
    if (did) parts.splice(1, 0, `P${t.priority}`)
    if (t.parentId) {
      const parentRef = t.parentVisualId || t.parentTitle || t.parentId
      parts.push(`(subtask of ${parentRef})`)
    }
    if (t.category) parts.push(`(${t.category})`)
    if (t.deadline) parts.push(`due: ${new Date(t.deadline).toLocaleDateString('en-GB')}`)
    if (t.closedAt) parts.push(`closed: ${new Date(t.closedAt).toLocaleDateString('en-GB')}`)
    return parts.join(' ')
  })

  const header = `Found ${tasks.length} task${tasks.length === 1 ? '' : 's'}${resolvedLimit && tasks.length >= resolvedLimit ? ` (limit ${resolvedLimit} reached; pass a higher limit to see more)` : ''}.`
  return { content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }] }
})

// Create task
server.tool('karea_create_task', 'Create a new task in a project and return it with its visual ID (e.g. KA42), status, priority and category. Defaults when omitted: status open, priority 3, the first category of the project. Use karea_quick_task to log something already finished, or karea_doing for work in progress.', {
  name: z.string().describe('Task title'),
  category: z.string().optional().describe('Category name'),
  priority: z.number().min(1).max(5).optional().describe('Priority 1-5 (1=critical)'),
  sla: z.string().optional().describe('Deadline: 2d, 5h, tomorrow, monday'),
  description: z.string().optional().describe('Task description. Rendered as Markdown - use `**bold**`, lists, `code`, links, etc. Keep it short (a few sentences); use `markdown` for long-form docs.'),
  markdown: z.string().optional().describe('Long-form markdown content - use for investigation findings, technical/functional docs, solution design, root cause analysis. This is the task\'s knowledge base.'),
  source: z.string().optional().describe('Where this task came from'),
  closingRequisites: z.array(z.string()).optional().describe('Requirements that must be met before closing. Keep each one short and concrete - 1 short sentence, ideally under ~120 chars (e.g. "Tests pass in CI", "PR approved"). Do NOT write paragraphs.'),
  tags: z.array(z.string()).optional().describe('Tags to attach. STRICT: only pass tags that already exist in this project (verify with karea_view_task or the project list). Do NOT invent new tags unless the user explicitly asked for one - a typo or a paraphrase spawns duplicate tags. When unsure, omit and ask the user.'),
  parentId: z.string().optional().describe('Parent task ID to create this as a subtask'),
  jiraIssueKey: z.string().optional().describe('JIRA issue key to link (e.g. PROJ-123). Issue must exist in JIRA.'),
  projectId: z.string().optional().describe('Project name or ID'),
  ...sessionLinkFields,
}, async (params) => {
  const pid = await resolveProject(params.projectId)

  let cmd = `/nt -n ${q(params.name)}`
  if (params.category) cmd += ` -cat ${q(params.category)}`
  if (params.priority) cmd += ` -prio ${params.priority}`
  if (params.sla) cmd += ` -sla ${q(params.sla)}`
  if (params.description) cmd += ` -d ${q(params.description)}`
  if (params.source) cmd += ` -s ${q(params.source)}`
  if (params.closingRequisites?.length) {
    for (const cr of params.closingRequisites) cmd += ` -cr ${q(cr)}`
  }
  if (params.tags?.length) cmd += ` -tags ${params.tags.map(t => q(t)).join(' ')}`

  const result = await karea.sendCommand(cmd, pid)

  if (result.taskId) {
    if (params.parentId) {
      await karea.updateTask(result.taskId, { parentId: params.parentId })
    }
    if (params.markdown) {
      await karea.setMarkdown(result.taskId, params.markdown, pid)
    }
    if (params.jiraIssueKey) {
      try {
        await karea.linkJira(result.taskId, params.jiraIssueKey)
      } catch (err: any) {
        result.response += ` (JIRA link failed: ${err.message})`
      }
    }
  }

  // KA367: atomic session link when caller supplies aiSessionId+toolType.
  const linkNote = await maybeLinkSession(result.taskId, params)

  const parts = [(result.response || 'Task created.') + (linkNote || '')]
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Edit task
server.tool('karea_edit_task', 'Update fields of an existing task (title, status, priority, deadline, category, assignee, description, tags, or add a note) located by visual ID, name or UUID. Only the fields you pass change; the rest are left untouched. Returns the updated task.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  name: z.string().optional().describe('New task title (rename the task)'),
  priority: z.number().min(1).max(5).optional().describe('New priority'),
  status: z.string().optional().describe('New status: open, in_progress, blocked, review, done'),
  sla: z.string().optional().describe('New deadline'),
  description: z.string().optional().describe('New description. Rendered as Markdown - use `**bold**`, lists, `code`, links, etc. Keep it short (a few sentences); use `markdown` for long-form docs.'),
  markdown: z.string().optional().describe('Long-form markdown content - use for investigation findings, technical/functional docs, solution design, root cause analysis. Overwrites existing markdown; read first with karea_get_markdown to append.'),
  category: z.string().optional().describe('Move to category'),
  note: z.string().optional().describe('Add a human-readable note (the user reads these). Markdown is supported (lists, **bold**, `code`, links) - use it when it makes the note more readable; plain text is also fine. For private AI cross-session working memory use karea_set_context instead.'),
  tags: z.array(z.string()).optional().describe('Tags to attach. STRICT: only pass tags that already exist in this project (check karea_view_task first). Do NOT invent new tags unless the user explicitly asked for one - the API upserts by name and typos create duplicates. When unsure, omit and ask.'),
  clearTags: z.boolean().optional().describe('Remove all existing tags before adding new ones'),
  closingRequisites: z.array(z.string()).optional().describe('Closing requisites to add. Keep each short and concrete - 1 short sentence, ideally under ~120 chars. Do NOT write paragraphs.'),
  clearClosingRequisites: z.boolean().optional().describe('Remove all existing closing requisites before adding new ones'),
  jiraIssueKey: z.string().optional().describe('JIRA issue key to link (e.g. PROJ-123). Set to "unlink" to remove.'),
  linkTasks: z.array(z.string()).optional().describe('Other tasks to LINK to this one - names, visual IDs (KA123) or UUIDs. This creates a real task-to-task relationship that shows on both tasks, which is what you want when the user says "related to KA123". Do NOT settle for writing "relates to X" in the description instead. Link type is set by linkType (default "related").'),
  linkType: z.enum(['related', 'blocks', 'blocked_by']).optional().describe('Relationship for linkTasks: "related" (default), "blocks" (this task blocks them), or "blocked_by" (this task is blocked by them).'),
  unlinkTasks: z.array(z.string()).optional().describe('Tasks to UNLINK from this one - names, visual IDs or UUIDs. Removes the link whichever direction it was created in.'),
  projectId: z.string().optional().describe('Project name or ID'),
  ...sessionLinkFields,
}, async (params) => {
  let cmd = `/et ${q(params.task)}`
  if (params.priority) cmd += ` -prio ${params.priority}`
  if (params.status) cmd += ` -status ${params.status}`
  if (params.sla) cmd += ` -sla ${q(params.sla)}`
  if (params.description) cmd += ` -d ${q(params.description)}`
  if (params.category) cmd += ` -cat ${q(params.category)}`
  if (params.clearTags) cmd += ` -cleartags`
  if (params.tags?.length) cmd += ` -tags ${params.tags.map(t => q(t)).join(' ')}`

  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(cmd, pid)

  // The /et command above only knows about parent-level fields. Everything
  // below (markdown, rename, notes, requisites, JIRA) is applied through
  // separate API calls AFTER that response was composed - track those ops so
  // the final message reflects them instead of echoing a stale "no changes"
  // and tricking callers into retrying (KA343).
  const childOps: string[] = []

  if (params.markdown) {
    await karea.setMarkdown(params.task, params.markdown, pid)
    childOps.push('markdown set')
  }

  const taskId = result.taskId || params.task
  if (params.name) {
    await karea.updateTask(taskId, { title: params.name })
    childOps.push(`renamed to "${params.name}"`)
  }
  if (params.note) {
    const taskData = await karea.getTask(taskId)
    await karea.addNote(taskData.id, params.note)
    childOps.push('added 1 note')
  }
  if (params.clearClosingRequisites) {
    const taskData = await karea.getTask(taskId)
    const cleared = (taskData.closingRequisites || []).length
    for (const r of (taskData.closingRequisites || [])) {
      await karea.deleteRequisite(taskData.id, r.id)
    }
    if (cleared > 0) childOps.push(`cleared ${cleared} closing requisite(s)`)
  }
  if (params.closingRequisites?.length) {
    const taskData = result.taskId ? await karea.getTask(result.taskId) : await karea.getTask(taskId)
    for (const desc of params.closingRequisites) {
      await karea.addRequisite(taskData.id, desc)
    }
    childOps.push(`added ${params.closingRequisites.length} closing requisite(s)`)
  }
  if (params.jiraIssueKey) {
    const resolvedId = result.taskId || taskId
    const taskData = await karea.getTask(resolvedId)
    try {
      if (params.jiraIssueKey.toLowerCase() === 'unlink') {
        await karea.unlinkJira(taskData.id)
        childOps.push('JIRA link removed')
      } else {
        await karea.linkJira(taskData.id, params.jiraIssueKey)
        childOps.push(`linked to JIRA ${params.jiraIssueKey}`)
      }
    } catch (err: any) {
      childOps.push(`JIRA link failed: ${err.message}`)
    }
  }

  // Task-to-task links. Each target is resolved the same way `task` itself is,
  // so callers can pass visual IDs. Failures are reported per target rather
  // than aborting the whole edit - a typo in one id shouldn't lose the rest.
  if (params.linkTasks?.length) {
    const sourceId = await resolveTaskId(params.task, pid)
    const linkType = params.linkType || 'related'
    for (const target of params.linkTasks) {
      try {
        const targetId = await resolveTaskId(target, pid)
        await karea.linkTask(sourceId, targetId, linkType)
        childOps.push(`linked ${linkType} to ${target}`)
      } catch (err: any) {
        // "Tasks are already linked" is the common one and is not a failure
        // worth alarming the caller about.
        childOps.push(`link to ${target} failed: ${err.message}`)
      }
    }
  }
  if (params.unlinkTasks?.length) {
    const sourceId = await resolveTaskId(params.task, pid)
    let links: any[] = []
    try {
      links = await karea.getTaskLinks(sourceId)
    } catch (err: any) {
      childOps.push(`could not read existing links: ${err.message}`)
    }
    for (const target of params.unlinkTasks) {
      try {
        const targetId = await resolveTaskId(target, pid)
        // getTaskLinks reports the OTHER task as `taskId` in both directions,
        // so one comparison covers incoming and outgoing alike.
        const hit = links.find((l: any) => l.taskId === targetId)
        if (!hit) { childOps.push(`no link to ${target} to remove`); continue }
        await karea.unlinkTask(sourceId, hit.id)
        childOps.push(`unlinked ${target}`)
      } catch (err: any) {
        childOps.push(`unlink of ${target} failed: ${err.message}`)
      }
    }
  }

  let response = result.response || 'Task updated.'
  if (childOps.length > 0) {
    const opsText = childOps.join(', ')
    // The /et reply legitimately says "(no changes)" when only child-level
    // params were passed - replace it with what actually happened.
    if (response.includes('(no changes)')) {
      response = response.replace('(no changes)', `(${opsText})`)
    } else if (/updated \(([^)]*)\)/.test(response)) {
      response = response.replace(/updated \(([^)]*)\)/, (_m, existing) => `updated (${existing}, ${opsText})`)
    } else {
      response += ` Also: ${opsText}.`
    }
    // The embedded task card was rendered BEFORE the child writes - patch its
    // note/requisite counts from a post-write fetch so callers don't see
    // requisiteCount:0 for rows that were just persisted.
    const cardMatch = response.match(/@@KAREA_VIEW@@(\{.*\})/)
    if (cardMatch) {
      try {
        const fresh = await karea.getTask(taskId)
        const card = JSON.parse(cardMatch[1])
        if (card?.data) {
          if (Array.isArray(fresh.notes)) card.data.noteCount = fresh.notes.length
          if (Array.isArray(fresh.closingRequisites)) card.data.requisiteCount = fresh.closingRequisites.length
          if (params.name) card.data.title = params.name
          response = response.replace(cardMatch[0], `@@KAREA_VIEW@@${JSON.stringify(card)}`)
        }
      } catch { /* card patch is best-effort */ }
    }
  }

  // KA367
  const linkNote = await maybeLinkSession(result.taskId || params.task, params)

  const parts = [response + (linkNote || '')]
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Close task
server.tool('karea_close_task', 'Mark a task as done: sets status to done and stamps the close time. Reports any unmet closing requisites first unless confirm is set. To close several tasks at once use karea_done.', {
  task: z.string().describe('Task name, visual ID, or UUID'),
  resolution: z.string().optional().describe('How it was resolved'),
  projectId: z.string().optional().describe('Project name or ID'),
  ...sessionLinkFields,
}, async (params) => {
  let cmd = `/ct ${q(params.task)}`
  if (params.resolution) cmd += ` -r ${q(params.resolution)}`

  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(cmd, pid)
  const linkNote = await maybeLinkSession(result.taskId || params.task, params)
  const parts = [(result.response || 'Task closed.') + (linkNote || '')]
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Delete task
server.tool('karea_delete_task', 'Permanently delete a task and its history. Irreversible; requires confirm=true. To merely close a task instead, use karea_close_task.', {
  task: z.string().describe('Task name, visual ID, or UUID'),
  confirm: z.boolean().optional().describe('Set true to confirm deletion'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  let cmd = `/dt ${q(params.task)}`
  if (params.confirm) cmd += ` -confirm`

  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(cmd, pid)
  const parts = [result.response || 'Done.']
  parts.push(...recordFooter('task', { id: result.taskId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Quick task (did)
server.tool('karea_quick_task', 'Log something you already finished as a done task (it shows up in Recap) and return it. Status is always done; relative-time params set when it happened. For in-progress work use karea_doing instead.', {
  description: z.string().describe('What you did'),
  source: z.string().optional().describe('Where it happened'),
  projectId: z.string().optional().describe('Project name or ID'),
  ...sessionLinkFields,
}, async (params) => {
  let cmd = `/did ${q(params.description)}`
  if (params.source) cmd += ` -s ${q(params.source)}`

  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(cmd, pid)
  const linkNote = await maybeLinkSession(result.taskId, params)
  const parts = [(result.response || 'Logged.') + (linkNote || '')]
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Quick in-progress task (doing)
server.tool('karea_doing', 'Create a task you are working on right now (status: in_progress)', {
  description: z.string().describe('What you are doing'),
  category: z.string().optional().describe('Category name'),
  priority: z.number().min(1).max(5).optional().describe('Priority 1-5 (1=critical)'),
  sla: z.string().optional().describe('Deadline: 2d, 5h, tomorrow, monday'),
  projectId: z.string().optional().describe('Project name or ID'),
  ...sessionLinkFields,
}, async (params) => {
  let cmd = `/doing ${q(params.description)}`
  if (params.category) cmd += ` -cat ${q(params.category)}`
  if (params.priority) cmd += ` -prio ${params.priority}`
  if (params.sla) cmd += ` -sla ${q(params.sla)}`

  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(cmd, pid)
  const linkNote = await maybeLinkSession(result.taskId, params)
  const parts = [(result.response || 'Task created as in-progress.') + (linkNote || '')]
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// View task details
server.tool('karea_view_task', 'Return one task with all its details (status, priority, deadline, category, description, notes, requisites, links), located by visual ID, name or UUID. Pass includeContext=true to also inline the task\'s AI Context in the response - avoids a follow-up karea_get_context round-trip. Read-only.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
  includeContext: z.boolean().optional().describe('If true, inline the task\'s AI Context (cross-session working memory) in this response. Default false; when false, the response instead hints that Context exists and can be fetched with karea_get_context.'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  let response = result.response || 'Task not found.'

  const taskId = result.taskId
  if (taskId) {
    try {
      const taskData = await karea.getTask(taskId)
      const links = (taskData as any).resourceLinks || []
      if (links.length > 0) {
        const lines = links.map((l: any) => {
          const r = l.resource || {}
          const size = r.sizeBytes != null
            ? r.sizeBytes < 1024 ? `${r.sizeBytes}B` : r.sizeBytes < 1048576 ? `${Math.round(r.sizeBytes / 1024)}KB` : `${(r.sizeBytes / 1048576).toFixed(1)}MB`
            : ''
          const folder = r.folder ? ` [${r.folder}]` : ''
          const mime = r.mimeType ? ` ${r.mimeType}` : ''
          return `  - ${r.type === 'text' ? 'Text' : 'File'} | ${r.name}${size ? ' | ' + size : ''}${mime}${folder} (id: ${r.id})`
        })
        response += `\n\nLinked Resources (${links.length}):\n${lines.join('\n')}`
      }
      // KA465: meetings this task was discussed at. /api/tasks/[id] does NOT
      // include them - they only exist on /api/tasks/[id]/meetings - which is
      // why they were invisible to MCP until now.
      try {
        const md = await karea.getTaskMeetings(taskId)
        const meetings = md.meetings || []
        if (meetings.length > 0) {
          const lines = meetings.map((m: any) => {
            const when = m.startAt ? new Date(m.startAt).toISOString().replace('T', ' ').slice(0, 16) : '?'
            return `  - ${when} ${m.title}${m.location ? ` @ ${m.location}` : ''} (id: ${m.id})`
          })
          response += `\n\nLinked Meetings (${meetings.length}):\n${lines.join('\n')}`
        }
      } catch {
        // ignore - meetings are supplementary
      }
      // Task-to-task links, both directions. Shown like the resource block so
      // a caller can see a relationship exists without a second round-trip.
      try {
        const taskLinks = await karea.getTaskLinks(taskId)
        if (Array.isArray(taskLinks) && taskLinks.length > 0) {
          const lines = taskLinks.map((l: any) => {
            const rel = l.linkType === 'blocks'
              ? (l.direction === 'outgoing' ? 'blocks' : 'blocked by')
              : l.linkType === 'blocked_by'
                ? (l.direction === 'outgoing' ? 'blocked by' : 'blocks')
                : 'related to'
            return `  - ${rel} ${l.displayId || l.taskId} ${l.title} [${l.status}]`
          })
          response += `\n\nLinked Tasks (${taskLinks.length}):\n${lines.join('\n')}`
        }
      } catch {
        // ignore - links are supplementary
      }
      if ((taskData as any).aiContext) {
        if (params.includeContext) {
          // Inline the context so the caller doesn't need a second round-trip.
          try {
            const ctx = await karea.getContext(params.task, pid)
            const body = (ctx && ctx.context) ? ctx.context : (taskData as any).aiContext
            response += `\n\nAI Context:\n${body}`
          } catch {
            // Fall back to the aiContext value we already have.
            response += `\n\nAI Context:\n${(taskData as any).aiContext}`
          }
        } else {
          response += `\n\nThis task has AI Context (your cross-session working memory). Fetch it with karea_get_context, or re-call karea_view_task with includeContext=true.`
        }
      }
    } catch {
      // ignore - keep the original response
    }
  }

  const footer = recordFooter('task', { id: taskId || result.taskId, displayId: result.displayId })
  if (footer.length) response += `\n\n${footer.join('\n')}`
  return { content: [{ type: 'text', text: response }] }
})

// KA406: view many tasks in one call. Bounded concurrency, per-task error
// isolation so a single not-found doesn't kill the whole batch.
server.tool('karea_view_tasks', 'Return details for MANY tasks in one response. Pass an array of task identifiers (visualIds, names, or UUIDs) and get one consolidated response with a block per task, separated by dividers. Use this instead of calling karea_view_task N times when you want to inspect a batch. Max 50 per call. Read-only.', {
  tasks: z.array(z.string()).min(1).max(50).describe('Array of task identifiers (visualId like C1/T2, name, or UUID). 1–50 items.'),
  projectId: z.string().optional().describe('Project name or ID (needed when visual IDs are used and share a single project).'),
  includeContext: z.boolean().optional().describe('If true, inline each task\'s AI Context in its block. Default false.'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)

  const fetchOne = async (id: string): Promise<string> => {
    try {
      const result = await karea.sendCommand(`/vt ${q(id)}`, pid)
      let block = result.response || `[NOT FOUND: ${id}]`
      const taskId = result.taskId
      if (taskId) {
        try {
          const taskData = await karea.getTask(taskId)
          const links = (taskData as any).resourceLinks || []
          if (links.length > 0) {
            const lines = links.map((l: any) => {
              const r = l.resource || {}
              const size = r.sizeBytes != null
                ? r.sizeBytes < 1024 ? `${r.sizeBytes}B` : r.sizeBytes < 1048576 ? `${Math.round(r.sizeBytes / 1024)}KB` : `${(r.sizeBytes / 1048576).toFixed(1)}MB`
                : ''
              const folder = r.folder ? ` [${r.folder}]` : ''
              const mime = r.mimeType ? ` ${r.mimeType}` : ''
              return `  - ${r.type === 'text' ? 'Text' : 'File'} | ${r.name}${size ? ' | ' + size : ''}${mime}${folder} (id: ${r.id})`
            })
            block += `\n\nLinked Resources (${links.length}):\n${lines.join('\n')}`
          }
          if ((taskData as any).aiContext) {
            if (params.includeContext) {
              try {
                const ctx = await karea.getContext(id, pid)
                const body = (ctx && ctx.context) ? ctx.context : (taskData as any).aiContext
                block += `\n\nAI Context:\n${body}`
              } catch {
                block += `\n\nAI Context:\n${(taskData as any).aiContext}`
              }
            } else {
              block += `\n\n(AI Context available - re-call with includeContext=true to inline.)`
            }
          }
        } catch { /* keep the original block */ }
      }
      return `### ${id}\n${block}`
    } catch (err: any) {
      return `### ${id}\n[NOT FOUND: ${id}${err?.message ? ' - ' + err.message : ''}]`
    }
  }

  // Bounded concurrency: 5 at a time so we don't hammer the API on large batches.
  const CONCURRENCY = 5
  const results: string[] = new Array(params.tasks.length)
  for (let i = 0; i < params.tasks.length; i += CONCURRENCY) {
    const slice = params.tasks.slice(i, i + CONCURRENCY)
    const settled = await Promise.all(slice.map(fetchOne))
    for (let j = 0; j < settled.length; j++) results[i + j] = settled[j]
  }

  const sep = '\n\n' + '─'.repeat(60) + '\n\n'
  const header = `Viewed ${params.tasks.length} task${params.tasks.length === 1 ? '' : 's'}:\n\n`
  return { content: [{ type: 'text', text: header + results.join(sep) }] }
})

// Create project
server.tool('karea_create_project', 'Create a new Karea project owned by you and seed it with the default categories (Coding, Testing, Documenting, Reviewing). Returns the new project id. To add a category to an existing project, use karea_create_category instead.', {
  name: z.string().describe('Project name'),
}, async ({ name }) => {
  const result = await karea.sendCommand(`/np ${q(name)}`)
  const parts = [result.response || 'Project created.']
  parts.push(...recordFooter('project', { id: result.projectId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Delete project
server.tool('karea_delete_project', 'Permanently delete a project and everything inside it (tasks, categories, notes, history). Irreversible; requires confirm=true.', {
  name: z.string().describe('Project name'),
  confirm: z.boolean().optional().describe('Set true to confirm deletion'),
}, async ({ name, confirm }) => {
  let cmd = `/dp ${q(name)}`
  if (confirm) cmd += ` -confirm`
  const result = await karea.sendCommand(cmd)
  return { content: [{ type: 'text', text: result.response || 'Done.' }] }
})

// Create category
server.tool('karea_create_category', 'Create a new category (a task bucket) inside an existing project and return it. To create a whole project, use karea_create_project.', {
  name: z.string().describe('Category name'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async ({ name, projectId }) => {
  const pid = await resolveProject(projectId)
  const result = await karea.sendCommand(`/nc ${q(name)}`, pid)
  const parts = [result.response || 'Category created.']
  if (result.categoryId) parts.push(`Category ID: ${result.categoryId}`)
  if (pid) parts.push(...recordFooter('project', { id: pid }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Delete category
server.tool('karea_delete_category', 'Permanently delete a category AND every task inside it, including history. Irreversible; requires confirm=true. To delete a single task instead, use karea_delete_task.', {
  name: z.string().describe('Category name'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async ({ name, projectId }) => {
  const pid = await resolveProject(projectId)
  const result = await karea.sendCommand(`/dc ${q(name)}`, pid)
  return { content: [{ type: 'text', text: result.response || 'Category deleted.' }] }
})

// Bulk close tasks
server.tool('karea_done', 'Mark several tasks as done in one call, each given by visual ID or name; returns a per-task result. For a single task with closing-requisite checks, use karea_close_task.', {
  tasks: z.array(z.string()).describe('Task names or visual IDs to close'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async ({ tasks, projectId }) => {
  const pid = await resolveProject(projectId)
  const taskList = tasks.map(t => q(t)).join(' ')
  const result = await karea.sendCommand(`/done ${taskList}`, pid)
  const parts = [result.response || 'Tasks closed.']
  parts.push(...recordFooter('task', { id: result.taskId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Share project
server.tool('karea_share_project', 'Give another user access to a project by email at a chosen role (owner, editor, commenter or viewer). Records the share so that user can see and, per role, edit the project.', {
  project: z.string().describe('Project name'),
  email: z.string().describe('User email to share with'),
  role: z.enum(['owner', 'editor', 'viewer']).optional().describe('Role to assign (default: editor)'),
}, async ({ project, email, role }) => {
  let cmd = `/share ${q(project)} ${email}`
  if (role) cmd += ` ${role}`
  const result = await karea.sendCommand(cmd)
  return { content: [{ type: 'text', text: result.response || 'Project shared.' }] }
})

// Ask AI
server.tool('karea_ask', 'Send a natural-language request to the Karea AI assistant, which may read or modify your tasks to carry it out, and return its reply. Consumes your monthly AI usage allowance.', {
  message: z.string().describe('Your message'),
  projectId: z.string().optional().describe('Project name or ID for context'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(params.message, pid)
  return { content: [{ type: 'text', text: result.response || 'No response.' }] }
})

// Recap
server.tool('karea_recap', 'Return a summary of recent activity (tasks created, closed and updated) over a recent time window. Read-only; handy for standups and reviews.', {
  hours: z.number().optional().describe('Hours to look back (default 24)'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const data = await karea.getRecap(pid, params.hours || 24)

  const sections: string[] = []

  const parentSuffix = (t: any) => {
    if (!t.parentId && !t.parentTitle && !t.parentDisplayId) return ''
    const ref = t.parentDisplayId || t.parentVisualId || t.parentTitle || t.parentId
    return ` (subtask of ${ref})`
  }

  const updates = data.updates || {}
  const updateSuffix = (id: string) => {
    const u = updates[id]
    if (!u) return ''
    const bits: string[] = []
    if (u.change) {
      // KA417 follow-up: say what CHANGED, not just the resulting value. A
      // bare "[Context]" told the reader a task moved but not how.
      const c = u.change
      const VERB: Record<string, string> = {
        note: 'added', context: 'updated', markdown: 'updated', tags: 'updated',
        assignee: 'changed', priority: 'changed', schedule: 'moved',
        details: 'edited', other: 'recorded',
      }
      if (c.kind === 'status') {
        bits.push(c.from ? `[Status: ${c.from} -> ${c.value ?? c.to}]` : `[Status -> ${c.value ?? c.to}]`)
      } else if (c.kind === 'deadline') {
        bits.push(c.value ?? c.to ? `[Deadline -> ${c.value ?? c.to}]` : '[Deadline cleared]')
      } else {
        bits.push(`[${c.label} ${VERB[c.kind] || 'updated'}]`)
      }
    }
    if (u.lastNote) bits.push(`note: "${u.lastNote.preview}"`)
    return bits.length ? '  ' + bits.join(' ') : ''
  }

  if (data.done?.length) {
    sections.push('DONE:')
    data.done.forEach((t: any) => {
      let line = `  ${t.displayId ? t.displayId + ' ' : ''}${t.title}${parentSuffix(t)}`
      if (t.closingReason) line += ` [${t.closingReason}]`
      sections.push(line + updateSuffix(t.id))
    })
  }

  if (data.quickTasks?.length) {
    sections.push('\nQUICK TASKS:')
    data.quickTasks.forEach((t: any) => sections.push(`  ${t.displayId ? t.displayId + ' ' : ''}${t.title}${updateSuffix(t.id)}`))
  }

  if (data.inProgress?.length) {
    sections.push('\nIN PROGRESS:')
    data.inProgress.forEach((t: any) => sections.push(`  ${t.displayId ? t.displayId + ' ' : ''}P${t.priority} ${t.title}${parentSuffix(t)}${updateSuffix(t.id)}`))
  }

  if ((data as any).review?.length) {
    sections.push('\nIN REVIEW:')
    ;(data as any).review.forEach((t: any) => sections.push(`  ${t.displayId ? t.displayId + ' ' : ''}P${t.priority} ${t.title}${parentSuffix(t)}${updateSuffix(t.id)}`))
  }

  if (data.blocked?.length) {
    sections.push('\nBLOCKED:')
    data.blocked.forEach((t: any) => sections.push(`  ${t.displayId ? t.displayId + ' ' : ''}${t.title}${parentSuffix(t)}${updateSuffix(t.id)}`))
  }

  if (data.upcoming?.length) {
    sections.push('\nDUE TODAY:')
    data.upcoming.forEach((t: any) => sections.push(`  ${t.title}${updateSuffix(t.id)}`))
  }

  if (data.updated?.length) {
    sections.push('\nUPDATED (only change in window):')
    data.updated.forEach((t: any) => sections.push(`  ${t.displayId ? t.displayId + ' ' : ''}${t.title}${parentSuffix(t)}${updateSuffix(t.id)}`))
  }

  if (data.openQuestions?.length) {
    sections.push('\nOPEN QUESTIONS:')
    data.openQuestions.forEach((q: any) => {
      let line = `  ${q.question}`
      if (q.linkedTasks?.length) line += ` [linked: ${q.linkedTasks.join(', ')}]`
      sections.push(line)
    })
  }

  return { content: [{ type: 'text', text: sections.join('\n') || 'No recent activity.' }] }
})

// Get task markdown - the task's knowledge base.
server.tool('karea_get_markdown', 'Read the markdown document attached to a task. This is the task\'s knowledge base - it contains investigation findings, technical and functional documentation, root cause analysis, solution design, implementation notes, and any other long-form content the task has accumulated. Always read this before working on a task to avoid duplicating past research.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
}, async ({ task, projectId }) => {
  const pid = await resolveProject(projectId)
  const data = await karea.getMarkdown(task, pid)
  const body = data.markdown || '(empty)'
  return { content: [{ type: 'text', text: `# ${data.title}\n\n${body}` }] }
})

// Set task markdown - overwrites the markdown field with the provided content.
server.tool('karea_set_markdown', 'Write the markdown document for a task. Overwrites any existing content. Use this to persist: investigation findings and research, technical documentation (architecture, APIs, schemas), functional documentation (requirements, acceptance criteria, user flows), root cause analysis and debugging logs, solution design - planned or implemented, risks, trade-offs, and open questions. This is the single source of truth for everything learned about this task. Always append to existing content (read first with karea_get_markdown) rather than replacing it, unless restructuring.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  markdown: z.string().describe('The full markdown content to store on the task. Pass empty string to clear.'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
  ...sessionLinkFields,
}, async (params) => {
  const { task, markdown, projectId } = params
  const pid = await resolveProject(projectId)
  const data = await karea.setMarkdown(task, markdown, pid)
  const linkNote = await maybeLinkSession(data.id || task, params)
  return { content: [{ type: 'text', text: `Updated markdown on "${data.title}" (${(data.markdown || '').length} chars).${linkNote || ''}` }] }
})

// Read task Context - the AI-facing cross-session scratchpad.
server.tool('karea_get_context', 'Read the task\'s Context - titled entries of AI working memory that hold the FULL HISTORY of a task (not just its current state): what was tried, decided, discovered, and abandoned along the way. ALWAYS read this first when picking a task up so you inherit the journey instead of re-deriving it. Each entry shows who/when/how (user or mcp) it was created and last edited. When you learn something new, ADD to the relevant entry with karea_set_context - do not overwrite the history. Distinct from notes (human-readable updates) and the markdown doc (long-form documentation).', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
}, async ({ task, projectId }) => {
  const pid = await resolveProject(projectId)
  const data = await karea.getContext(task, pid)
  const entries = Array.isArray(data.entries) ? data.entries : []
  if (entries.length === 0) {
    return { content: [{ type: 'text', text: `# Context: ${data.title}\n\n${data.context || '(empty - write your plan/findings here with karea_set_context)'}` }] }
  }
  const parts = entries.map((e: any) =>
    `## ${e.title}  [${e.lastEditedMode || e.createdMode}, updated ${e.updatedAt ? new Date(e.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '?'}${e.lastEditedBy ? ` by ${e.lastEditedBy}` : ''}]\n\n${e.content}`)
  return { content: [{ type: 'text', text: `# Context: ${data.title} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})\n\n${parts.join('\n\n---\n\n')}` }] }
})

// Write task Context - upserts a titled entry of the AI scratchpad.
server.tool('karea_set_context', 'Write a titled entry of the task\'s Context - the AI-facing cross-session working memory. Context tracks the FULL HISTORY of a task, not just its current state: what was tried, what worked, what failed, what was decided and why. Update incrementally so the journey is preserved (never overwrite the whole entry with "current status" - read first with karea_get_context, append/refine, then write back). Context is your DEFAULT save target: after every plan, finding, decision, or gotcha, persist it here proactively under titles like "Plan", "Findings", "Decisions", "Gotchas", "Attempted". Upserts by title: same title overwrites THAT entry only; other entries are untouched. Pass empty context to delete the entry. Use karea_add_note only for human-facing updates and karea_set_markdown for long-form docs - but keep Context up to date either way.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  context: z.string().describe('The full content for this entry. Pass empty string to delete the entry.'),
  title: z.string().optional().describe('Entry title (e.g. "Plan", "Findings", "Decisions"). Defaults to "General".'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
  ...sessionLinkFields,
}, async (params) => {
  const { task, context, title, projectId } = params
  const pid = await resolveProject(projectId)
  const data = await karea.setContext(task, context, pid, title)
  const linkNote = await maybeLinkSession(data.id || task, params)
  if (data.deleted) {
    return { content: [{ type: 'text', text: `Deleted Context entry "${data.entryTitle}" on "${data.title}".${linkNote || ''}` }] }
  }
  const e = data.entry
  return { content: [{ type: 'text', text: `Updated Context entry "${e?.title || title || 'General'}" on "${data.title}" (${(e?.content || '').length} chars).${linkNote || ''}` }] }
})

// List open questions
server.tool('karea_list_questions', 'List open questions (unresolved decisions or blockers) in a project, newest first. Defaults to status open; pass status to include answered, cancelled or all. Read-only.', {
  projectId: z.string().optional().describe('Project name or ID'),
  status: z.string().optional().describe('Filter by status: open, answered, cancelled, all (default: all)'),
}, async ({ projectId, status }) => {
  const pid = await resolveProject(projectId)
  const data = await karea.listQuestions(pid, status)
  if (!data.length) return { content: [{ type: 'text', text: 'No questions found.' }] }

  const lines = data.map((q: any) => {
    const prefix = q.project?.prefix
    const shortId = q.seq != null ? (prefix ? `${prefix}Q${q.seq}` : `Q${q.seq}`) : null
    let line = `[${q.status}] ${q.question}`
    if (shortId) line += `\n  Short ID: ${shortId}`
    line += `\n  ID: ${q.id}`
    if (q.answer) line += `\n  Answer: ${q.answer}`
    if (q.tasks?.length) line += `\n  Linked: ${q.tasks.map((t: any) => t.task?.title || t.title).join(', ')}`
    return line
  })
  return { content: [{ type: 'text', text: lines.join('\n\n') }] }
})

// Create open question
server.tool('karea_create_question', 'Create an open question (a decision or blocker to resolve) in a project, optionally linked to tasks, and return it with its short ID (e.g. KAQ3).', {
  question: z.string().describe('The question text'),
  projectId: z.string().optional().describe('Project name or ID'),
  markdown: z.string().optional().describe('Markdown body with additional context'),
  taskIds: z.array(z.string()).optional().describe('Task IDs to link (visual IDs like KA12 or UUIDs)'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  if (!pid) return { content: [{ type: 'text', text: 'Project not found.' }] }
  const result = await karea.createQuestion({ projectId: pid, question: params.question, markdown: params.markdown, taskIds: params.taskIds })
  const parts = [`Question created: "${params.question}"`]
  const base = publicBase()
  const qPrefix = result?.project?.prefix
  if (result?.seq != null) parts.push(`Short ID: ${qPrefix ? `${qPrefix}Q${result.seq}` : `Q${result.seq}`}`)
  if (result?.id) parts.push(`ID: ${result.id}`)
  parts.push(`Link: ${base}/dashboard/questions`)
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Answer a question
server.tool('karea_answer_question', 'Answer an open question, located by short ID or text match: sets its answer and flips its status to answered. Returns the updated question.', {
  questionId: z.string().describe('Question UUID or short ID (e.g. KAQ3)'),
  answer: z.string().describe('The answer'),
}, async ({ questionId, answer }) => {
  await karea.updateQuestion(questionId, { answer, status: 'answered' })
  return { content: [{ type: 'text', text: 'Question answered.' }] }
})

// Edit a question
server.tool('karea_edit_question', 'Edit an open question: change its text, status (open, answered or cancelled), answer, or linked tasks. Only the fields you pass change. Returns the updated question.', {
  questionId: z.string().describe('Question UUID or short ID (e.g. KAQ3)'),
  question: z.string().optional().describe('Update the question text'),
  answer: z.string().optional().describe('Set or update the answer'),
  status: z.string().optional().describe('Change status: open, answered, cancelled'),
  markdown: z.string().optional().describe('Update markdown body'),
  taskIdsAdd: z.array(z.string()).optional().describe('Task IDs to link'),
  taskIdsRemove: z.array(z.string()).optional().describe('Task IDs to unlink'),
}, async (params) => {
  const { questionId, ...data } = params
  await karea.updateQuestion(questionId, data)
  return { content: [{ type: 'text', text: 'Question updated.' }] }
})

// Delete a question
server.tool('karea_delete_question', 'Permanently delete an open question. Irreversible. To keep it but mark it resolved, set its status to cancelled via karea_edit_question instead.', {
  questionId: z.string().describe('Question UUID or short ID (e.g. KAQ3)'),
}, async ({ questionId }) => {
  await karea.deleteQuestion(questionId)
  return { content: [{ type: 'text', text: 'Question deleted.' }] }
})

// List resources
server.tool('karea_list_resources', 'List resources (text notes & files). With a projectId it returns every resource belonging to that project - whether assigned to it directly, linked to one of its tasks, or filed under a folder named after the project (e.g. knowledge-base docs). Omit projectId to list all your resources, including unfiled ones. All filters combine freely (name query, folder, type, mime, size range).', {
  projectId: z.string().optional().describe('Project name or ID. Omit to list ALL your resources (including unfiled / knowledge-base items not tied to any task).'),
  query: z.string().optional().describe('Fuzzy match against resource name.'),
  folder: z.string().optional().describe('Exact folder path (case-insensitive) - e.g. "docs/api".'),
  type: z.string().optional().describe('"text" for markdown/plain-text resources, "file" for uploaded files.'),
  mime: z.string().optional().describe('Substring match against MIME type - e.g. "pdf", "image/png", "video".'),
  minSize: z.number().int().optional().describe('Minimum size in bytes.'),
  maxSize: z.number().int().optional().describe('Maximum size in bytes.'),
}, async ({ projectId, query, folder, type, mime, minSize, maxSize }) => {
  const pid = await resolveProject(projectId)
  const resources = await karea.listResources({ projectId: pid, query, folder, type, mime, minSize, maxSize })
  if (!resources.length) return { content: [{ type: 'text', text: 'No resources found.' }] }

  const lines = resources.map((r: any) => {
    const size = r.sizeBytes < 1024 ? `${r.sizeBytes}B` : r.sizeBytes < 1048576 ? `${Math.round(r.sizeBytes / 1024)}KB` : `${(r.sizeBytes / 1048576).toFixed(1)}MB`
    const folder = r.folder ? ` [${r.folder}]` : ''
    const project = r.project?.name ? ` (${r.project.name})` : ''
    const mime = r.mimeType ? ` ${r.mimeType}` : ''
    const created = r.createdAt ? ` created: ${new Date(r.createdAt).toLocaleDateString('en-GB')}` : ''
    const linked = r.taskLinks?.length ? `\n  Linked tasks: ${r.taskLinks.map((l: any) => l.task?.title || l.taskId).join(', ')}` : ''
    return `${r.type === 'text' ? 'Text' : 'File'} | ${r.name} | ${size}${mime}${folder}${project}${created}\n  ID: ${r.id}${linked}`
  })
  return { content: [{ type: 'text', text: lines.join('\n\n') }] }
})

// Get resource content - text OR binary. Text resources return their content
// inline. Binary/file resources return an MCP `image` block for images, or a
// base64 payload for other file types (PDFs, docs, etc.), so the agent can
// actually read attached files. Size-capped to protect the tool response.
const MAX_BINARY_INLINE_BYTES = 8 * 1024 * 1024 // 8 MB
server.tool('karea_get_resource', 'Return a resource with its full content and metadata, by ID. Works for BOTH text and binary/file resources: text is returned inline; images are returned as an MCP image content block so the agent can view them; other file types (PDF, docs, etc.) are returned as base64 bytes with their MIME type. Files above 8 MB return metadata + a note telling the agent to fetch the download URL directly (too large to inline). Read-only.', {
  resourceId: z.string().describe('Resource UUID'),
}, async ({ resourceId }) => {
  const resource = await karea.getResource(resourceId)
  const meta: string[] = []
  meta.push(`ID: ${resource.id}`)
  meta.push(`Type: ${resource.type}`)
  if (resource.mimeType) meta.push(`MIME: ${resource.mimeType}`)
  meta.push(`Size: ${resource.sizeBytes} bytes`)
  if (resource.folder) meta.push(`Folder: ${resource.folder}`)
  if (resource.project?.name) meta.push(`Project: ${resource.project.name}`)
  if (resource.createdAt) meta.push(`Created: ${new Date(resource.createdAt).toLocaleString('en-GB')}`)
  if (resource.taskLinks?.length) {
    meta.push(`Linked tasks: ${resource.taskLinks.map((l: any) => {
      const t = l.task
      return t ? `${t.title} [${t.status}] (${t.id})` : l.taskId
    }).join(', ')}`)
  }
  const header = `# ${resource.name}\n\n${meta.join('\n')}`
  if (resource.type === 'text') {
    return { content: [{ type: 'text', text: `${header}\n\n---\n\n${resource.textContent || '(empty)'}` }] }
  }
  // Binary/file resource - try to inline the bytes.
  const sizeBytes = Number(resource.sizeBytes) || 0
  if (sizeBytes > MAX_BINARY_INLINE_BYTES) {
    return { content: [{ type: 'text', text: `${header}\n\nFile is ${sizeBytes} bytes - above the ${MAX_BINARY_INLINE_BYTES}-byte inline cap. Fetch directly: GET /api/resources/${resource.id}?inline=1 with your Karea API key (Bearer).` }] }
  }
  try {
    const { base64, mimeType, sizeBytes: actual } = await karea.downloadResourceBytes(resource.id)
    const isImage = /^image\//i.test(mimeType) || /^image\//i.test(resource.mimeType || '')
    if (isImage) {
      return {
        content: [
          { type: 'text', text: `${header}\n\n(image inlined below, ${actual} bytes)` },
          { type: 'image', data: base64, mimeType },
        ],
      }
    }
    // Non-image binary: return base64 so the agent can decode it locally.
    return {
      content: [
        { type: 'text', text: `${header}\n\n---\n\nBinary content, ${actual} bytes, base64 (mimeType=${mimeType}):\n\n${base64}` },
      ],
    }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `${header}\n\nBinary file - failed to download bytes: ${err?.message || err}` }] }
  }
})

// Create text resource
server.tool('karea_create_resource', 'Create a text resource (a note or document) in a project or folder and return it with its ID. To attach an existing resource to a task, use karea_link_resource_to_task.', {
  name: z.string().describe('Resource name'),
  content: z.string().describe('Text content'),
  projectId: z.string().optional().describe('Project name or ID'),
  folder: z.string().optional().describe('Folder path'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const resource = await karea.createTextResource({ name: params.name, content: params.content, projectId: pid, folder: params.folder })
  const parts = [`Resource "${resource.name}" created.`]
  parts.push(...recordFooter('resource', { id: resource.id }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Update text resource
server.tool('karea_update_resource', 'Overwrite a text resource content and/or metadata, by ID, and return the updated resource. Replaces the existing content rather than appending.', {
  resourceId: z.string().describe('Resource UUID'),
  name: z.string().optional().describe('New name'),
  content: z.string().optional().describe('New text content'),
  folder: z.string().optional().describe('Move to folder'),
}, async (params) => {
  const data: any = {}
  if (params.name) data.name = params.name
  if (params.content) data.content = params.content
  if (params.folder !== undefined) data.folder = params.folder
  const resource = await karea.updateResource(params.resourceId, data)
  const parts = [`Resource "${resource.name}" updated.`]
  parts.push(...recordFooter('resource', { id: resource.id }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Delete resource
server.tool('karea_delete_resource', 'Permanently delete a resource (text or file) by ID. Irreversible. To only detach it from a task, use karea_unlink_resource_from_task.', {
  resourceId: z.string().describe('Resource UUID'),
}, async ({ resourceId }) => {
  await karea.deleteResource(resourceId)
  return { content: [{ type: 'text', text: 'Resource deleted.' }] }
})

// Upload a file resource (base64-encoded)
server.tool('karea_upload_resource', 'Upload a binary file as a resource (base64-encoded)', {
  name: z.string().describe('File name with extension (e.g. report.pdf)'),
  data: z.string().describe('Base64-encoded file content'),
  mimeType: z.string().optional().describe('MIME type (e.g. application/pdf). Auto-detected if omitted.'),
  folder: z.string().optional().describe('Folder path to organize the resource'),
  taskId: z.string().optional().describe('Task UUID to link the resource to'),
}, async (params) => {
  try {
    const resource = await karea.uploadResource(params.name, params.data, params.mimeType, params.folder, params.taskId)
    const parts = [`Uploaded "${resource.name}" (${resource.sizeBytes} bytes, type: ${resource.type}).`]
    parts.push(...recordFooter('resource', { id: resource.id }))
    return { content: [{ type: 'text', text: parts.join('\n') }] }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Upload failed: ${err.message}` }] }
  }
})

// Resolve a task identifier (UUID, visual ID, or name) to a UUID. Throws a
// clear message if the visual ID can't be resolved - otherwise downstream
// callers would forward the raw string as a taskId and the server's Zod
// `.uuid()` check would bubble up as a generic 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
async function resolveTaskId(task: string, projectId?: string): Promise<string> {
  if (UUID_RE.test(task)) return task
  let result: any
  try {
    result = await karea.sendCommand(`/vt ${q(task)}`, projectId)
  } catch (err: any) {
    throw new Error(`Task not found: ${task} (${err.message})`)
  }
  const resolved = result?.taskId
  if (!resolved || !UUID_RE.test(resolved)) {
    throw new Error(`Task not found: ${task}`)
  }
  return resolved
}

// Link an existing resource to a task
server.tool('karea_link_resource_to_task', 'Link an existing resource (text or file) to a task. The resource and task must belong to the same user/project scope. Use this to attach release notes, design docs, references, etc. to one or more tasks. To link a resource to multiple tasks, call this once per task.', {
  resourceId: z.string().describe('Resource UUID'),
  task: z.string().describe('Task name, visual ID (KA123, KPL77), or UUID'),
  projectId: z.string().optional().describe('Project name or ID (helps resolve visual IDs)'),
}, async ({ resourceId, task, projectId }) => {
  const pid = await resolveProject(projectId)
  const taskId = await resolveTaskId(task, pid)
  try {
    await karea.linkResourceToTask(resourceId, taskId)
    return { content: [{ type: 'text', text: `Linked resource ${resourceId} to task ${taskId}.` }] }
  } catch (err: any) {
    if (/already linked/i.test(err.message)) {
      return { content: [{ type: 'text', text: `Resource ${resourceId} already linked to task ${taskId}.` }] }
    }
    throw err
  }
})

// Unlink a resource from a task
server.tool('karea_unlink_resource_from_task', 'Remove the link between a resource and a task. Does not delete either side.', {
  resourceId: z.string().describe('Resource UUID'),
  task: z.string().describe('Task name, visual ID (KA123, KPL77), or UUID'),
  projectId: z.string().optional().describe('Project name or ID (helps resolve visual IDs)'),
}, async ({ resourceId, task, projectId }) => {
  const pid = await resolveProject(projectId)
  const taskId = await resolveTaskId(task, pid)
  await karea.unlinkResourceFromTask(resourceId, taskId)
  return { content: [{ type: 'text', text: `Unlinked resource ${resourceId} from task ${taskId}.` }] }
})

// List notes on a task
server.tool('karea_list_notes', 'List the notes (human-readable updates) on a task, newest first. Read-only.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async ({ task, projectId }) => {
  const pid = await resolveProject(projectId)
  const result = await karea.sendCommand(`/vt ${q(task)}`, pid)
  const taskId = result.taskId || task
  const taskData = await karea.getTask(taskId)
  const notes = taskData.notes || []
  if (!notes.length) return { content: [{ type: 'text', text: 'No notes on this task.' }] }

  const lines = notes.map((n: any) => {
    const by = n.createdBy?.name || n.guestName || 'Unknown'
    const date = new Date(n.createdAt).toLocaleString()
    return `[${date}] ${by}: ${n.content}\n  Note ID: ${n.id}`
  })
  return { content: [{ type: 'text', text: lines.join('\n\n') }] }
})

// Link an AI coding session to a task so the user can see history and copy
// a resume command. Providers: claude-code, opencode, codex, cursor, aider,
// other (KA291).
server.tool('karea_link_session', 'Link your current AI coding session (Claude Code, OpenCode, Codex, Cursor, Aider) to a Karea task so the user can see the session history for that task and copy a command to resume the session later. Call this once per task you\'re working on. For Claude Code, pass sessionId as the CLI session id; for OpenCode use its session id; etc.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  provider: z.enum(['claude-code', 'opencode', 'codex', 'cursor', 'aider', 'other']).describe('AI provider that owns the session'),
  sessionId: z.string().describe('Provider session ID (used to resume). Claude Code: the id from `claude --resume`. OpenCode: the id from `opencode --session`. Codex: `codex resume`.'),
  label: z.string().optional().describe('Short human label for the session (e.g. "Feature draft", "Bug repro")'),
  projectId: z.string().optional().describe('Project name or ID (helps resolve visual IDs)'),
}, async ({ task, provider, sessionId, label, projectId }) => {
  const pid = await resolveProject(projectId)
  const taskId = await resolveTaskId(task, pid)
  const session = await karea.linkAISession(taskId, { provider, sessionId, label })
  return { content: [{ type: 'text', text: `Linked ${provider} session ${sessionId} to task ${taskId}.\nRow ID: ${session.id}` }] }
})

// List AI sessions linked to a task
server.tool('karea_list_sessions', 'List AI coding sessions linked to a task (provider, sessionId, label, last active, resume command). Read-only.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  projectId: z.string().optional().describe('Project name or ID (helps resolve visual IDs)'),
}, async ({ task, projectId }) => {
  const pid = await resolveProject(projectId)
  const taskId = await resolveTaskId(task, pid)
  const rows = await karea.listAISessions(taskId)
  if (!rows.length) return { content: [{ type: 'text', text: 'No AI sessions linked to this task.' }] }
  const lines = rows.map((r: any) => {
    const active = new Date(r.lastActiveAt || r.createdAt).toLocaleString()
    return `[${r.provider}] ${r.label || r.sessionId}\n  Session ID: ${r.sessionId}\n  Last active: ${active}\n  Row ID: ${r.id}`
  })
  return { content: [{ type: 'text', text: lines.join('\n\n') }] }
})

// Unlink an AI session
server.tool('karea_unlink_session', 'Remove a previously-linked AI session from a task. Use the row ID from karea_list_sessions or karea_link_session.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  sessionRowId: z.string().describe('Row ID of the linked session (from karea_list_sessions)'),
  projectId: z.string().optional().describe('Project name or ID (helps resolve visual IDs)'),
}, async ({ task, sessionRowId, projectId }) => {
  const pid = await resolveProject(projectId)
  const taskId = await resolveTaskId(task, pid)
  await karea.unlinkAISession(taskId, sessionRowId)
  return { content: [{ type: 'text', text: `Unlinked session ${sessionRowId} from task ${taskId}.` }] }
})

// Add note to task
server.tool('karea_add_note', 'Add a note to a task. Notes are human-readable updates/observations (the user reads them). For private AI working memory that persists across sessions, use karea_set_context instead.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  content: z.string().describe('Note content. Markdown is supported (lists, **bold**, `code`, links) - use it when it improves readability; plain text is also fine.'),
  projectId: z.string().optional().describe('Project name or ID'),
  ...sessionLinkFields,
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  const note = await karea.addNote(taskData.id, params.content)
  const linkNote = await maybeLinkSession(taskData.id, params)
  const parts = [`Note added to "${taskData.title}".${linkNote || ''}`]
  if (note?.id) parts.push(`Note ID: ${note.id}`)
  parts.push(...recordFooter('task', { id: taskData.id, displayId: result.displayId || taskData.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Edit a note on a task
server.tool('karea_edit_note', 'Change the text of an existing note on a task, by note ID, and return the updated note.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  noteId: z.string().describe('Note UUID (from karea_list_notes)'),
  content: z.string().describe('Updated note content. Markdown is supported (lists, **bold**, `code`, links); plain text is also fine.'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
  ...sessionLinkFields,
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  await karea.updateNote(taskData.id, params.noteId, params.content)
  const linkNote = await maybeLinkSession(taskData.id, params)
  const parts = [`Note updated on "${taskData.title}".${linkNote || ''}`]
  parts.push(`Note ID: ${params.noteId}`)
  parts.push(...recordFooter('task', { id: taskData.id, displayId: result.displayId || taskData.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Delete a note from a task
server.tool('karea_delete_note', 'Permanently delete a note from a task, by note ID. Irreversible.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  noteId: z.string().describe('Note UUID (from karea_list_notes)'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  await karea.deleteNote(taskData.id, params.noteId)
  const parts = [`Note deleted from "${taskData.title}".`]
  parts.push(...recordFooter('task', { id: taskData.id, displayId: result.displayId || taskData.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Create a subtask under a parent task. Mirrors karea_create_task params,
// but takes a `parent` (visual ID, name, or UUID) and wires the new task as
// its child. Falls back to /api/tasks/[id]/subtasks for the minimal case
// (title + priority only) so behavior matches the legacy direct endpoint.
server.tool('karea_create_subtask', 'Create a subtask under a parent task. Accepts the parent by visual ID (e.g. KPL77), name, or UUID. Supports the same params as karea_create_task.', {
  parent: z.string().describe('Parent task name, visual ID (KPL77, C1), or UUID'),
  title: z.string().describe('Subtask title'),
  category: z.string().optional().describe('Category name (defaults to the parent\'s category if omitted)'),
  priority: z.number().min(1).max(5).optional().describe('Priority 1-5 (1=critical)'),
  sla: z.string().optional().describe('Deadline: 2d, 5h, tomorrow, monday'),
  description: z.string().optional().describe('Subtask description. Rendered as Markdown - use `**bold**`, lists, `code`, links, etc. Keep it short.'),
  markdown: z.string().optional().describe('Long-form markdown content - investigation findings, technical/functional docs, solution design, root cause analysis.'),
  source: z.string().optional().describe('Where this subtask came from'),
  closingRequisites: z.array(z.string()).optional().describe('Requirements that must be met before closing. Keep each one short and concrete - 1 short sentence, ideally under ~120 chars (e.g. "Tests pass in CI", "PR approved"). Do NOT write paragraphs.'),
  tags: z.array(z.string()).optional().describe('Tags to attach. STRICT: only pass tags that already exist in this project (verify with karea_view_task or the project list). Do NOT invent new tags unless the user explicitly asked for one - a typo or a paraphrase spawns duplicate tags. When unsure, omit and ask the user.'),
  jiraIssueKey: z.string().optional().describe('JIRA issue key to link (e.g. PROJ-123). Issue must exist in JIRA.'),
  projectId: z.string().optional().describe('Project name or ID (needed if parent is a visual ID)'),
  ...sessionLinkFields,
}, async (params) => {
  const pid = await resolveProject(params.projectId)

  // Resolve parent (accept visualId / name / UUID)
  const lookup = await karea.sendCommand(`/vt ${q(params.parent)}`, pid)
  const parentUuid = lookup.taskId
  if (!parentUuid) {
    return { content: [{ type: 'text', text: `Parent task not found: ${params.parent}` }] }
  }
  const parentData = await karea.getTask(parentUuid)
  const parentCategoryName = parentData.category?.name as string | undefined

  // Build /nt command identical to karea_create_task so the same flag set works.
  let cmd = `/nt -n ${q(params.title)}`
  const cat = params.category || parentCategoryName
  if (cat) cmd += ` -cat ${q(cat)}`
  if (params.priority) cmd += ` -prio ${params.priority}`
  if (params.sla) cmd += ` -sla ${q(params.sla)}`
  if (params.description) cmd += ` -d ${q(params.description)}`
  if (params.source) cmd += ` -s ${q(params.source)}`
  if (params.closingRequisites?.length) {
    for (const cr of params.closingRequisites) cmd += ` -cr ${q(cr)}`
  }
  if (params.tags?.length) cmd += ` -tags ${params.tags.map(t => q(t)).join(' ')}`

  const result = await karea.sendCommand(cmd, pid)

  if (result.taskId) {
    await karea.updateTask(result.taskId, { parentId: parentData.id })
    if (params.markdown) {
      await karea.setMarkdown(result.taskId, params.markdown, pid)
    }
    if (params.jiraIssueKey) {
      try {
        await karea.linkJira(result.taskId, params.jiraIssueKey)
      } catch (err: any) {
        result.response = (result.response || 'Subtask created.') + ` (JIRA link failed: ${err.message})`
      }
    }
  }

  const parentVisualId = parentData.project?.prefix && parentData.seq != null
    ? `${parentData.project.prefix}${parentData.seq}`
    : null
  // KA367
  const linkNote = await maybeLinkSession(result.taskId, params)
  const parts = [(result.response || 'Subtask created.').replace(/^Task created/i, 'Subtask created') + (linkNote || '')]
  parts.push(`Parent: ${parentVisualId ? parentVisualId + ' · ' : ''}"${parentData.title}" (id: ${parentData.id})`)
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// List subtasks of a parent task
server.tool('karea_list_subtasks', 'List subtasks of a parent task. Accepts the parent by visual ID, name, or UUID.', {
  parent: z.string().describe('Parent task name, visual ID (KPL77, C1), or UUID'),
  projectId: z.string().optional().describe('Project name or ID (needed if parent is a visual ID)'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.parent)}`, pid)
  const taskId = result.taskId
  if (!taskId) {
    return { content: [{ type: 'text', text: `Parent task not found: ${params.parent}` }] }
  }
  const parentData = await karea.getTask(taskId)
  const subs = await karea.listSubtasks(parentData.id)
  if (!Array.isArray(subs) || subs.length === 0) {
    return { content: [{ type: 'text', text: `No subtasks under "${parentData.title}".` }] }
  }
  const prefix = parentData.project?.prefix
  const parentVisualId = prefix && parentData.seq != null ? `${prefix}${parentData.seq}` : null
  const lines = subs.map((s: any) => {
    const display = prefix && s.seq != null ? `${prefix}${s.seq} ` : ''
    return `  ${display}[${s.status}] P${s.priority} ${s.title} (id: ${s.id})`
  })
  const header = `Subtasks of ${parentVisualId ? parentVisualId + ' · ' : ''}"${parentData.title}" (id: ${parentData.id}) - ${subs.length} subtask${subs.length === 1 ? '' : 's'}`
  return { content: [{ type: 'text', text: `${header}:\n${lines.join('\n')}` }] }
})

// Add closing requisite to a task
server.tool('karea_add_requisite', 'Add a closing requisite (a checklist item that must be completed before the task may be closed) to a task, and return it.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  description: z.string().describe('What must be done before closing. Keep it short and concrete - 1 short sentence, ideally under ~120 chars (e.g. "Deploy verified on staging"). Do NOT write a paragraph.'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  const req = await karea.addRequisite(taskData.id, params.description)
  const parts = [`Requisite added to "${taskData.title}": ${params.description}`]
  parts.push(`Requisite ID: ${req.id}`)
  parts.push(...recordFooter('task', { id: taskData.id, displayId: result.displayId || taskData.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Toggle closing requisite completion
server.tool('karea_toggle_requisite', 'Mark a closing requisite complete or incomplete, by ID. This affects whether karea_close_task warns about unmet requisites.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  requisiteId: z.string().describe('Requisite UUID (from karea_view_task)'),
  completed: z.boolean().describe('true to complete, false to uncomplete'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  await karea.toggleRequisite(taskData.id, params.requisiteId, params.completed)
  const parts = [`Requisite ${params.completed ? 'completed' : 'uncompleted'} on "${taskData.title}".`]
  parts.push(`Requisite ID: ${params.requisiteId}`)
  parts.push(...recordFooter('task', { id: taskData.id, displayId: result.displayId || taskData.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Delete closing requisite
server.tool('karea_delete_requisite', 'Permanently delete a closing requisite from a task, by ID. Irreversible.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  requisiteId: z.string().describe('Requisite UUID (from karea_view_task)'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  await karea.deleteRequisite(taskData.id, params.requisiteId)
  const parts = [`Requisite deleted from "${taskData.title}".`]
  parts.push(...recordFooter('task', { id: taskData.id, displayId: result.displayId || taskData.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Get JIRA link for a task
server.tool('karea_get_jira_link', 'Return the linked JIRA issue (key and URL) for a task, if one exists. Read-only.', {
  task: z.string().describe('Task name, visual ID, or UUID'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  const link = await karea.getJiraLink(taskData.id)
  if (!link) return { content: [{ type: 'text', text: `No JIRA link on "${taskData.title}".` }] }
  return { content: [{ type: 'text', text: `JIRA link: ${link.jiraIssueKey} - ${link.jiraSummary || 'No summary'} [${link.jiraStatus || 'Unknown'}] (project: ${link.jiraProjectKey})` }] }
})

// Link a task to a JIRA issue
server.tool('karea_link_jira', 'Link a Karea task to a JIRA issue by issue key (e.g. PROJ-123)', {
  task: z.string().describe('Task name, visual ID, or UUID'),
  issueKey: z.string().describe('JIRA issue key (e.g. PROJ-123)'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  try {
    const link = await karea.linkJira(taskData.id, params.issueKey)
    return { content: [{ type: 'text', text: `Linked "${taskData.title}" to JIRA ${link.jiraIssueKey} - ${link.jiraSummary || params.issueKey}` }] }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Failed to link: ${err.message}` }] }
  }
})

// Unlink a task from JIRA
server.tool('karea_unlink_jira', 'Remove the JIRA link from a Karea task', {
  task: z.string().describe('Task name, visual ID, or UUID'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  await karea.unlinkJira(taskData.id)
  return { content: [{ type: 'text', text: `Removed JIRA link from "${taskData.title}".` }] }
})

// ─────────────────────────────────────────────────────────────────────────
// KA422 - Reminders
// Full CRUD + a "check" tool that agents can call anytime, plus snooze /
// dismiss / mark-done actions. Every other karea MCP tool also auto-appends
// a "Pending reminders" footer (see wrapper above) so a live reminder is
// surfaced on the very next tool call.
// ─────────────────────────────────────────────────────────────────────────

function formatReminderLine(r: any): string {
  const t = r.task || {}
  const display = t.project?.prefix && typeof t.seq === 'number' ? `${t.project.prefix}${t.seq}` : `#${(t.id || '').slice(0, 6)}`
  const when = new Date(r.fireAt).toLocaleString()
  const title = r.title || t.title || 'Reminder'
  const bits = [`[${r.id}] ${display} - ${title} · fires ${when} · status ${r.status}`]
  if (r.repeat) bits.push(`repeat ${r.repeat}`)
  if (r.emailOptIn) bits.push('email on')
  return bits.join(' · ')
}

server.tool('karea_check_reminders', 'Return the caller\'s upcoming and past-due reminders. Use this when the user asks "what reminders do I have?" or before doing focused work so you know what will interrupt them. Also useful to look up a reminder id for karea_snooze_reminder / karea_dismiss_reminder / karea_mark_reminder_done. Read-only.', {
  taskId: z.string().optional().describe('Only list reminders on this task (visual ID, name, or UUID).'),
  includeDone: z.boolean().optional().describe('Include dismissed / done / cancelled reminders too. Default false.'),
}, async ({ taskId, includeDone }) => {
  let tid: string | undefined = undefined
  if (taskId) {
    const t = await karea.getTask(taskId)
    tid = t.id
  }
  const items = await karea.listReminders({ taskId: tid, includeDone: !!includeDone })
  if (items.length === 0) return { content: [{ type: 'text', text: 'No reminders.' }] }
  const lines = ['Reminders:', ...items.map((r: any) => `  · ${formatReminderLine(r)}`)]
  return { content: [{ type: 'text', text: lines.join('\n') }] }
})

server.tool('karea_create_reminder', 'Schedule a reminder on a task. The reminder fires with a full-screen in-app modal at fireAt (always on); optionally also emails the user. Title falls back to the task title when omitted.', {
  task: z.string().describe('Task ref (visual ID, name, or UUID).'),
  fireAt: z.string().describe('When the reminder fires - ISO 8601 datetime (e.g. "2026-07-28T09:00:00Z") or a friendly form like "2d", "5h", "tomorrow 9am".'),
  title: z.string().optional().describe('Optional title shown on the fire modal. Falls back to the task title.'),
  emailOptIn: z.boolean().optional().describe('Also email the user when it fires. Default false (in-app only).'),
}, async (params) => {
  const t = await karea.getTask(params.task)
  // Accept ISO OR delegate to the app's SLA parser via a shortcut task-edit trick:
  // easier: parse relative forms locally with a light heuristic; ISO passes through.
  let fireIso = params.fireAt
  if (!/^\d{4}-\d{2}-\d{2}/.test(fireIso)) {
    // Ask the app to normalise via /sla parsing: fall back to a small heuristic.
    const now = Date.now()
    const m = fireIso.match(/^(\d+)\s*(m|min|h|hr|hour|d|day|w|week)s?$/i)
    if (m) {
      const n = parseInt(m[1], 10)
      const unit = m[2].toLowerCase()
      const ms = unit.startsWith('m') && unit !== 'mo' ? n * 60_000
        : unit.startsWith('h') ? n * 3600_000
        : unit.startsWith('d') ? n * 86_400_000
        : n * 7 * 86_400_000
      fireIso = new Date(now + ms).toISOString()
    } else if (/^tomorrow(\s+\d{1,2}(:\d{2})?\s*(am|pm)?)?$/i.test(fireIso)) {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); fireIso = d.toISOString()
    } else {
      return { content: [{ type: 'text', text: `Could not parse fireAt "${params.fireAt}". Pass an ISO datetime or a form like "2h", "3d", "tomorrow 9am".` }] }
    }
  }
  const rem = await karea.createReminder({
    taskId: t.id,
    title: params.title || null,
    fireAt: fireIso,
    emailOptIn: params.emailOptIn,
  })
  return { content: [{ type: 'text', text: `Reminder set on "${t.title}".\n  ${formatReminderLine({ ...rem, task: t })}` }] }
})

server.tool('karea_snooze_reminder', 'Snooze a firing reminder by N minutes. The modal closes; the reminder re-fires after the snooze window.', {
  reminderId: z.string().describe('Reminder id (from karea_check_reminders or the pending-reminder nudge attached to any tool response).'),
  minutes: z.number().int().min(1).max(60 * 24 * 7).describe('How many minutes to snooze.'),
}, async ({ reminderId, minutes }) => {
  const rem = await karea.patchReminder(reminderId, { action: 'snooze', snoozeMinutes: minutes })
  return { content: [{ type: 'text', text: `Snoozed reminder ${reminderId} for ${minutes} min → next fire ${new Date(rem.fireAt).toLocaleString()}.` }] }
})

server.tool('karea_dismiss_reminder', 'Dismiss a reminder - cancels it so it will not fire again.', {
  reminderId: z.string().describe('Reminder id.'),
}, async ({ reminderId }) => {
  await karea.patchReminder(reminderId, { action: 'dismiss' })
  return { content: [{ type: 'text', text: `Reminder ${reminderId} dismissed.` }] }
})

server.tool('karea_mark_reminder_done', 'Fulfill a reminder: closes both the reminder AND the underlying task (status = done).', {
  reminderId: z.string().describe('Reminder id.'),
}, async ({ reminderId }) => {
  const rem = await karea.patchReminder(reminderId, { action: 'done' })
  if (rem?.taskId) {
    try { await karea.sendCommand(`/ct ${rem.taskId}`) } catch {}
  }
  return { content: [{ type: 'text', text: `Reminder ${reminderId} marked done + task closed.` }] }
})

// ─── Meetings (KA465) ──────────────────────────────────────────────────────
// The meetings feature (KA433) shipped to production with no MCP surface at
// all. These wrap /api/meetings and its link endpoints.
//
// Meetings belong to a USER, not a project - a person's calendar spans
// projects - so `projectId` is an optional association, never a lookup scope.

// Shared renderer so list and view agree on how a meeting reads.
function meetingLine(m: any): string {
  const when = m.startAt ? new Date(m.startAt).toISOString().replace('T', ' ').slice(0, 16) : '?'
  const proj = m.project?.name ? ` [${m.project.name}]` : ''
  const where = m.location ? ` @ ${m.location}` : ''
  return `${when} - ${m.title}${proj}${where} (id: ${m.id})`
}

server.tool('karea_list_meetings', 'List meetings. Defaults to ALL meetings; narrow with scope="upcoming" (ends in the future) or scope="past", a from/to date window, or a project. Meetings belong to the user, not to a project - projectId only filters those explicitly filed under it. Read-only.', {
  scope: z.enum(['upcoming', 'past']).optional().describe('"upcoming" = ends in the future, "past" = already ended. Omit for all.'),
  from: z.string().optional().describe('Only meetings starting at/after this ISO datetime (e.g. "2026-09-14T00:00:00Z").'),
  to: z.string().optional().describe('Only meetings starting at/before this ISO datetime.'),
  projectId: z.string().optional().describe('Project name or ID to filter by.'),
}, async (params) => {
  const pid = params.projectId ? await resolveProject(params.projectId) : undefined
  const data = await karea.listMeetings({ scope: params.scope, from: params.from, to: params.to, projectId: pid })
  const meetings = data.meetings || []
  if (meetings.length === 0) return { content: [{ type: 'text', text: 'No meetings found.' }] }
  const lines = meetings.map((m: any) => {
    const qs = (m.questions || []).length
    const extra = qs > 0 ? ` - ${qs} open question(s)` : ''
    return `- ${meetingLine(m)}${extra}`
  })
  return { content: [{ type: 'text', text: `Meetings (${meetings.length}):\n${lines.join('\n')}` }] }
})

server.tool('karea_view_meeting', 'Return one meeting in full: time, location, project, attendees, prep notes, transcript, linked tasks and linked open questions. Read-only.', {
  meetingId: z.string().describe('Meeting UUID (from karea_list_meetings).'),
}, async ({ meetingId }) => {
  const data = await karea.getMeeting(meetingId)
  const m = data.meeting || data
  const parts = [meetingLine(m)]
  if (m.endAt) parts.push(`Ends: ${new Date(m.endAt).toISOString().replace('T', ' ').slice(0, 16)}`)
  if (m.description) parts.push(`\nDescription:\n${m.description}`)
  const attendees = Array.isArray(m.attendees) ? m.attendees : []
  if (attendees.length) {
    parts.push(`\nAttendees (${attendees.length}):\n` + attendees.map((a: any) =>
      `  - ${a.name || a.email || 'unknown'}${a.email && a.name ? ` <${a.email}>` : ''}${a.optional ? ' (optional)' : ''}`).join('\n'))
  }
  const questions = (m.questions || []).map((q: any) => q.question || q).filter(Boolean)
  if (questions.length) {
    parts.push(`\nOpen Questions (${questions.length}):\n` + questions.map((q: any) =>
      `  - [${q.status}] ${q.question} (id: ${q.id})`).join('\n'))
  }
  // Linked tasks live on their own endpoint, not on the meeting record.
  try {
    const t = await karea.getMeetingTasks(meetingId)
    const tasks = t.tasks || []
    if (tasks.length) {
      parts.push(`\nLinked Tasks (${tasks.length}):\n` + tasks.map((x: any) => {
        const did = x.project?.prefix && x.seq != null ? `${x.project.prefix}${x.seq}` : x.id
        return `  - ${did} ${x.title} [${x.status}]`
      }).join('\n'))
    }
  } catch { /* supplementary */ }
  if (m.notes) parts.push(`\nPrep notes:\n${m.notes}`)
  if (m.transcript) parts.push(`\nTranscript:\n${m.transcript}`)
  parts.push(...recordFooter('meeting', { id: m.id }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

server.tool('karea_create_meeting', 'Create a meeting. startAt and endAt are REQUIRED ISO datetimes and the meeting must end after it starts. Filing it under a project is optional - meetings belong to the user.', {
  title: z.string().describe('Meeting title.'),
  startAt: z.string().describe('ISO datetime the meeting starts, e.g. "2026-09-15T10:00:00Z".'),
  endAt: z.string().describe('ISO datetime the meeting ends. Must be after startAt.'),
  description: z.string().optional().describe('What the meeting is about.'),
  location: z.string().optional().describe('Room, address, or call link.'),
  projectId: z.string().optional().describe('Project name or ID to file this meeting under (optional).'),
  notes: z.string().optional().describe('Prep notes (markdown): agenda, talking points, things to raise.'),
  attendees: z.array(z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    optional: z.boolean().optional(),
  })).optional().describe('Attendee list.'),
}, async (params) => {
  const pid = params.projectId ? await resolveProject(params.projectId) : undefined
  const data = await karea.createMeeting({
    title: params.title,
    startAt: params.startAt,
    endAt: params.endAt,
    description: params.description,
    location: params.location,
    projectId: pid ?? null,
    notes: params.notes,
    attendees: params.attendees,
  })
  const m = data.meeting || data
  const parts = [`Meeting "${m.title}" created.`, meetingLine(m), ...recordFooter('meeting', { id: m.id })]
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

server.tool('karea_edit_meeting', 'Update a meeting. Only the fields you pass change. Note the API validates the RESULTING window, so moving only endAt cannot push it before an untouched startAt.', {
  meetingId: z.string().describe('Meeting UUID.'),
  title: z.string().optional().describe('New title.'),
  startAt: z.string().optional().describe('New ISO start datetime.'),
  endAt: z.string().optional().describe('New ISO end datetime.'),
  description: z.string().optional().describe('New description.'),
  location: z.string().optional().describe('New location.'),
  projectId: z.string().optional().describe('Move the meeting under this project (name or ID).'),
  notes: z.string().optional().describe('Replace the prep notes (markdown).'),
  transcript: z.string().optional().describe('Paste the meeting transcript.'),
}, async (params) => {
  const pid = params.projectId ? await resolveProject(params.projectId) : undefined
  const payload: Record<string, unknown> = {}
  if (params.title !== undefined) payload.title = params.title
  if (params.startAt !== undefined) payload.startAt = params.startAt
  if (params.endAt !== undefined) payload.endAt = params.endAt
  if (params.description !== undefined) payload.description = params.description
  if (params.location !== undefined) payload.location = params.location
  if (pid !== undefined) payload.projectId = pid
  if (params.notes !== undefined) payload.notes = params.notes
  if (params.transcript !== undefined) payload.transcript = params.transcript
  if (Object.keys(payload).length === 0) {
    return { content: [{ type: 'text', text: 'Nothing to update - pass at least one field.' }] }
  }
  const data = await karea.updateMeeting(params.meetingId, payload)
  const m = data.meeting || data
  const changed = Object.keys(payload).join(', ')
  return { content: [{ type: 'text', text: [`Meeting updated (${changed}).`, meetingLine(m), ...recordFooter('meeting', { id: m.id })].join('\n') }] }
})

server.tool('karea_delete_meeting', 'Delete a meeting permanently. Linked tasks and open questions are NOT deleted - they outlive the meeting, only the links go. Requires confirm=true.', {
  meetingId: z.string().describe('Meeting UUID.'),
  confirm: z.boolean().describe('Must be true. Guard against deleting a meeting by accident.'),
}, async ({ meetingId, confirm }) => {
  if (!confirm) return { content: [{ type: 'text', text: 'Not deleted: pass confirm=true to delete this meeting.' }] }
  await karea.deleteMeeting(meetingId)
  return { content: [{ type: 'text', text: `Meeting ${meetingId} deleted. Linked tasks and questions were kept.` }] }
})

server.tool('karea_link_task_to_meeting', 'Link an EXISTING task to a meeting (discussed at / arising from it). Accepts a task name, visual ID (KA123) or UUID. Unlinking later keeps the task.', {
  meetingId: z.string().describe('Meeting UUID.'),
  task: z.string().describe('Task name, visual ID (KA123), or UUID.'),
  projectId: z.string().optional().describe('Project name or ID - helps resolve a visual ID.'),
}, async ({ meetingId, task, projectId }) => {
  const pid = await resolveProject(projectId)
  const taskId = await resolveTaskId(task, pid)
  await karea.linkTaskToMeeting(meetingId, taskId)
  return { content: [{ type: 'text', text: `Linked task ${task} to meeting ${meetingId}.` }] }
})

server.tool('karea_unlink_task_from_meeting', 'Remove the link between a task and a meeting. The task itself is untouched.', {
  meetingId: z.string().describe('Meeting UUID.'),
  task: z.string().describe('Task name, visual ID, or UUID.'),
  projectId: z.string().optional().describe('Project name or ID - helps resolve a visual ID.'),
}, async ({ meetingId, task, projectId }) => {
  const pid = await resolveProject(projectId)
  const taskId = await resolveTaskId(task, pid)
  await karea.unlinkTaskFromMeeting(meetingId, taskId)
  return { content: [{ type: 'text', text: `Unlinked task ${task} from meeting ${meetingId} (the task was kept).` }] }
})

server.tool('karea_link_question_to_meeting', 'Link an EXISTING open question to a meeting, so it is raised there. Use karea_list_questions to find the id. The question outlives the meeting.', {
  meetingId: z.string().describe('Meeting UUID.'),
  questionId: z.string().describe('Open question UUID (from karea_list_questions).'),
}, async ({ meetingId, questionId }) => {
  await karea.linkQuestionToMeeting(meetingId, questionId)
  return { content: [{ type: 'text', text: `Linked question ${questionId} to meeting ${meetingId}.` }] }
})

server.tool('karea_unlink_question_from_meeting', 'Remove the link between an open question and a meeting. The question itself is kept.', {
  meetingId: z.string().describe('Meeting UUID.'),
  questionId: z.string().describe('Open question UUID.'),
}, async ({ meetingId, questionId }) => {
  await karea.unlinkQuestionFromMeeting(meetingId, questionId)
  return { content: [{ type: 'text', text: `Unlinked question ${questionId} from meeting ${meetingId} (the question was kept).` }] }
})

// Start the server
const transport = new StdioServerTransport()
server.connect(transport)
