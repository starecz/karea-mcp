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
type RecordKind = 'task' | 'resource' | 'project'
function recordFooter(kind: RecordKind, opts: { id?: string | null; displayId?: string | null }): string[] {
  const lines: string[] = []
  const base = (process.env.KAREA_URL || 'http://localhost:3002').replace(/\/$/, '')
  if (opts.id) lines.push(`ID: ${opts.id}`)
  if (opts.displayId) lines.push(`Short ID: ${opts.displayId}`)
  if (opts.id) {
    if (kind === 'task') lines.push(`Link: ${base}/dashboard/task/${opts.id}`)
    else if (kind === 'project') lines.push(`Link: ${base}/dashboard/${opts.id}`)
    else if (kind === 'resource') lines.push(`Link: ${base}/dashboard/resources`)
  }
  return lines
}

const server = new McpServer({
  name: 'karea',
  version: '0.1.0',
})

async function resolveProject(nameOrId?: string): Promise<string | undefined> {
  if (!nameOrId) return undefined
  return karea.resolveProjectId(nameOrId)
}

// List projects
server.tool('karea_list_projects', 'List all Karea projects with their IDs', {}, async () => {
  const projects = await karea.listProjects()
  const list = projects.map((p: any) => `${p.name} — id: ${p.id} (${p._count?.tasks || 0} tasks, categories: ${p.categories?.map((c: any) => c.name).join(', ') || 'none'})`).join('\n')
  return { content: [{ type: 'text', text: list || 'No projects found.' }] }
})

// List tasks
server.tool('karea_list_tasks', 'List tasks in a project. Defaults to open tasks (open, in_progress, blocked, review, backlog) capped at 200 to keep responses small. To see closed tasks pass status="done" and optionally closedSince (e.g. "14d", "7d", "24h"). To list everything, pass status="all".', {
  projectId: z.string().optional().describe('Project name or ID (omit for default project)'),
  status: z.string().optional().describe('Filter by status: open, in_progress, blocked, review, backlog, done, cancelled. Comma-separated allowed (e.g. "open,in_progress"). "all" returns every status.'),
  closedSince: z.string().optional().describe('Only return tasks closed since this window. Relative (e.g. "14d", "7d", "24h") or ISO date. Implies status=done unless status is set.'),
  limit: z.number().int().positive().max(1000).optional().describe('Max tasks to return (default 200, cap 1000).'),
}, async ({ projectId, status, closedSince, limit }) => {
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
server.tool('karea_create_task', 'Create a new task', {
  name: z.string().describe('Task title'),
  category: z.string().optional().describe('Category name'),
  priority: z.number().min(1).max(5).optional().describe('Priority 1-5 (1=critical)'),
  sla: z.string().optional().describe('Deadline: 2d, 5h, tomorrow, monday'),
  description: z.string().optional().describe('Task description (short, one line)'),
  markdown: z.string().optional().describe('Long-form markdown content — use for investigation findings, technical/functional docs, solution design, root cause analysis. This is the task\'s knowledge base.'),
  source: z.string().optional().describe('Where this task came from'),
  closingRequisites: z.array(z.string()).optional().describe('Requirements that must be met before closing'),
  tags: z.array(z.string()).optional().describe('Tags to add (e.g. ["bug", "needs review", "urgent"])'),
  parentId: z.string().optional().describe('Parent task ID to create this as a subtask'),
  jiraIssueKey: z.string().optional().describe('JIRA issue key to link (e.g. PROJ-123). Issue must exist in JIRA.'),
  projectId: z.string().optional().describe('Project name or ID'),
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

  const parts = [result.response || 'Task created.']
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Edit task
server.tool('karea_edit_task', 'Edit an existing task', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  name: z.string().optional().describe('New task title (rename the task)'),
  priority: z.number().min(1).max(5).optional().describe('New priority'),
  status: z.string().optional().describe('New status: open, in_progress, blocked, review, done'),
  sla: z.string().optional().describe('New deadline'),
  description: z.string().optional().describe('New description (short, one line)'),
  markdown: z.string().optional().describe('Long-form markdown content — use for investigation findings, technical/functional docs, solution design, root cause analysis. Overwrites existing markdown; read first with karea_get_markdown to append.'),
  category: z.string().optional().describe('Move to category'),
  note: z.string().optional().describe('Add a note'),
  tags: z.array(z.string()).optional().describe('Tags to add (e.g. ["bug", "needs review"])'),
  clearTags: z.boolean().optional().describe('Remove all existing tags before adding new ones'),
  closingRequisites: z.array(z.string()).optional().describe('Closing requisites to add'),
  clearClosingRequisites: z.boolean().optional().describe('Remove all existing closing requisites before adding new ones'),
  jiraIssueKey: z.string().optional().describe('JIRA issue key to link (e.g. PROJ-123). Set to "unlink" to remove.'),
  projectId: z.string().optional().describe('Project name or ID'),
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

  if (params.markdown) {
    await karea.setMarkdown(params.task, params.markdown, pid)
  }

  const taskId = result.taskId || params.task
  if (params.name) {
    await karea.updateTask(taskId, { title: params.name })
    result.response = (result.response ? result.response + ' ' : '') + `Renamed to "${params.name}".`
  }
  if (params.note) {
    const taskData = await karea.getTask(taskId)
    await karea.addNote(taskData.id, params.note)
  }
  if (params.clearClosingRequisites) {
    const taskData = await karea.getTask(taskId)
    for (const r of (taskData.closingRequisites || [])) {
      await karea.deleteRequisite(taskData.id, r.id)
    }
  }
  if (params.closingRequisites?.length) {
    const taskData = result.taskId ? await karea.getTask(result.taskId) : await karea.getTask(taskId)
    for (const desc of params.closingRequisites) {
      await karea.addRequisite(taskData.id, desc)
    }
  }
  if (params.jiraIssueKey) {
    const resolvedId = result.taskId || taskId
    const taskData = await karea.getTask(resolvedId)
    try {
      if (params.jiraIssueKey.toLowerCase() === 'unlink') {
        await karea.unlinkJira(taskData.id)
        result.response += ' JIRA link removed.'
      } else {
        await karea.linkJira(taskData.id, params.jiraIssueKey)
        result.response += ` Linked to JIRA ${params.jiraIssueKey}.`
      }
    } catch (err: any) {
      result.response += ` (JIRA link failed: ${err.message})`
    }
  }

  const parts = [result.response || 'Task updated.']
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Close task
server.tool('karea_close_task', 'Mark a task as done', {
  task: z.string().describe('Task name, visual ID, or UUID'),
  resolution: z.string().optional().describe('How it was resolved'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  let cmd = `/ct ${q(params.task)}`
  if (params.resolution) cmd += ` -r ${q(params.resolution)}`

  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(cmd, pid)
  const parts = [result.response || 'Task closed.']
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Delete task
server.tool('karea_delete_task', 'Delete a task (requires confirmation)', {
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
server.tool('karea_quick_task', 'Log something you already did', {
  description: z.string().describe('What you did'),
  source: z.string().optional().describe('Where it happened'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  let cmd = `/did ${q(params.description)}`
  if (params.source) cmd += ` -s ${q(params.source)}`

  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(cmd, pid)
  const parts = [result.response || 'Logged.']
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
}, async (params) => {
  let cmd = `/doing ${q(params.description)}`
  if (params.category) cmd += ` -cat ${q(params.category)}`
  if (params.priority) cmd += ` -prio ${params.priority}`
  if (params.sla) cmd += ` -sla ${q(params.sla)}`

  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(cmd, pid)
  const parts = [result.response || 'Task created as in-progress.']
  parts.push(...recordFooter('task', { id: result.taskId, displayId: result.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// View task details
server.tool('karea_view_task', 'View full details of a task', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
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
    } catch {
      // ignore — keep the original response
    }
  }

  const footer = recordFooter('task', { id: taskId || result.taskId, displayId: result.displayId })
  if (footer.length) response += `\n\n${footer.join('\n')}`
  return { content: [{ type: 'text', text: response }] }
})

// Create project
server.tool('karea_create_project', 'Create a new project', {
  name: z.string().describe('Project name'),
}, async ({ name }) => {
  const result = await karea.sendCommand(`/np ${q(name)}`)
  const parts = [result.response || 'Project created.']
  parts.push(...recordFooter('project', { id: result.projectId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Delete project
server.tool('karea_delete_project', 'Delete a project', {
  name: z.string().describe('Project name'),
  confirm: z.boolean().optional().describe('Set true to confirm deletion'),
}, async ({ name, confirm }) => {
  let cmd = `/dp ${q(name)}`
  if (confirm) cmd += ` -confirm`
  const result = await karea.sendCommand(cmd)
  return { content: [{ type: 'text', text: result.response || 'Done.' }] }
})

// Create category
server.tool('karea_create_category', 'Create a new category in the current project', {
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
server.tool('karea_delete_category', 'Delete a category', {
  name: z.string().describe('Category name'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async ({ name, projectId }) => {
  const pid = await resolveProject(projectId)
  const result = await karea.sendCommand(`/dc ${q(name)}`, pid)
  return { content: [{ type: 'text', text: result.response || 'Category deleted.' }] }
})

// Bulk close tasks
server.tool('karea_done', 'Mark multiple tasks as done at once', {
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
server.tool('karea_share_project', 'Share a project with another user', {
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
server.tool('karea_ask', 'Send a natural language message to Karea AI', {
  message: z.string().describe('Your message'),
  projectId: z.string().optional().describe('Project name or ID for context'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(params.message, pid)
  return { content: [{ type: 'text', text: result.response || 'No response.' }] }
})

// Recap
server.tool('karea_recap', 'Get a recap of recent activity', {
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

  if (data.done?.length) {
    sections.push('DONE:')
    data.done.forEach((t: any) => {
      let line = `  ${t.displayId ? t.displayId + ' ' : ''}${t.title}${parentSuffix(t)}`
      if (t.closingReason) line += ` [${t.closingReason}]`
      sections.push(line)
    })
  }

  if (data.quickTasks?.length) {
    sections.push('\nQUICK TASKS:')
    data.quickTasks.forEach((t: any) => sections.push(`  ${t.displayId ? t.displayId + ' ' : ''}${t.title}`))
  }

  if (data.inProgress?.length) {
    sections.push('\nIN PROGRESS:')
    data.inProgress.forEach((t: any) => sections.push(`  ${t.displayId ? t.displayId + ' ' : ''}P${t.priority} ${t.title}${parentSuffix(t)}`))
  }

  if (data.blocked?.length) {
    sections.push('\nBLOCKED:')
    data.blocked.forEach((t: any) => sections.push(`  ${t.displayId ? t.displayId + ' ' : ''}${t.title}${parentSuffix(t)}`))
  }

  if (data.upcoming?.length) {
    sections.push('\nDUE TODAY:')
    data.upcoming.forEach((t: any) => sections.push(`  ${t.title}`))
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

// Get task markdown — the task's knowledge base.
server.tool('karea_get_markdown', 'Read the markdown document attached to a task. This is the task\'s knowledge base — it contains investigation findings, technical and functional documentation, root cause analysis, solution design, implementation notes, and any other long-form content the task has accumulated. Always read this before working on a task to avoid duplicating past research.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
}, async ({ task, projectId }) => {
  const pid = await resolveProject(projectId)
  const data = await karea.getMarkdown(task, pid)
  const body = data.markdown || '(empty)'
  return { content: [{ type: 'text', text: `# ${data.title}\n\n${body}` }] }
})

// Set task markdown — overwrites the markdown field with the provided content.
server.tool('karea_set_markdown', 'Write the markdown document for a task. Overwrites any existing content. Use this to persist: investigation findings and research, technical documentation (architecture, APIs, schemas), functional documentation (requirements, acceptance criteria, user flows), root cause analysis and debugging logs, solution design — planned or implemented, risks, trade-offs, and open questions. This is the single source of truth for everything learned about this task. Always append to existing content (read first with karea_get_markdown) rather than replacing it, unless restructuring.', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  markdown: z.string().describe('The full markdown content to store on the task. Pass empty string to clear.'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
}, async ({ task, markdown, projectId }) => {
  const pid = await resolveProject(projectId)
  const data = await karea.setMarkdown(task, markdown, pid)
  return { content: [{ type: 'text', text: `Updated markdown on "${data.title}" (${(data.markdown || '').length} chars).` }] }
})

// List open questions
server.tool('karea_list_questions', 'List open questions in a project', {
  projectId: z.string().optional().describe('Project name or ID'),
  status: z.string().optional().describe('Filter by status: open, answered, cancelled, all (default: all)'),
}, async ({ projectId, status }) => {
  const pid = await resolveProject(projectId)
  const data = await karea.listQuestions(pid, status)
  if (!data.length) return { content: [{ type: 'text', text: 'No questions found.' }] }

  const lines = data.map((q: any) => {
    let line = `[${q.status}] ${q.question}\n  ID: ${q.id}`
    if (q.answer) line += `\n  Answer: ${q.answer}`
    if (q.tasks?.length) line += `\n  Linked: ${q.tasks.map((t: any) => t.task?.title || t.title).join(', ')}`
    return line
  })
  return { content: [{ type: 'text', text: lines.join('\n\n') }] }
})

// Create open question
server.tool('karea_create_question', 'Create a new open question', {
  question: z.string().describe('The question text'),
  projectId: z.string().optional().describe('Project name or ID'),
  markdown: z.string().optional().describe('Markdown body with additional context'),
  taskIds: z.array(z.string()).optional().describe('Task IDs to link (visual IDs like KA12 or UUIDs)'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  if (!pid) return { content: [{ type: 'text', text: 'Project not found.' }] }
  const result = await karea.createQuestion({ projectId: pid, question: params.question, markdown: params.markdown, taskIds: params.taskIds })
  const parts = [`Question created: "${params.question}"`]
  const base = (process.env.KAREA_URL || 'http://localhost:3002').replace(/\/$/, '')
  if (result?.id) parts.push(`ID: ${result.id}`)
  parts.push(`Link: ${base}/dashboard/questions`)
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Answer a question
server.tool('karea_answer_question', 'Answer an open question', {
  questionId: z.string().describe('Question UUID'),
  answer: z.string().describe('The answer'),
}, async ({ questionId, answer }) => {
  await karea.updateQuestion(questionId, { answer, status: 'answered' })
  return { content: [{ type: 'text', text: 'Question answered.' }] }
})

// Edit a question
server.tool('karea_edit_question', 'Edit an open question', {
  questionId: z.string().describe('Question UUID'),
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
server.tool('karea_delete_question', 'Delete an open question', {
  questionId: z.string().describe('Question UUID'),
}, async ({ questionId }) => {
  await karea.deleteQuestion(questionId)
  return { content: [{ type: 'text', text: 'Question deleted.' }] }
})

// List resources
server.tool('karea_list_resources', 'List resources (text notes & files) in a project', {
  projectId: z.string().optional().describe('Project name or ID'),
}, async ({ projectId }) => {
  const pid = await resolveProject(projectId)
  const resources = await karea.listResources(pid)
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

// Get resource content
server.tool('karea_get_resource', 'Get a text resource content by ID', {
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
  return { content: [{ type: 'text', text: `${header}\n\nBinary file - cannot display content.` }] }
})

// Create text resource
server.tool('karea_create_resource', 'Create a text resource', {
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
server.tool('karea_update_resource', 'Update a text resource', {
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
server.tool('karea_delete_resource', 'Delete a resource', {
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
// clear message if the visual ID can't be resolved — otherwise downstream
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
server.tool('karea_list_notes', 'List notes on a task', {
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

// Add note to task
server.tool('karea_add_note', 'Add a note to a task', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  content: z.string().describe('Note content'),
  projectId: z.string().optional().describe('Project name or ID'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  const note = await karea.addNote(taskData.id, params.content)
  const parts = [`Note added to "${taskData.title}".`]
  if (note?.id) parts.push(`Note ID: ${note.id}`)
  parts.push(...recordFooter('task', { id: taskData.id, displayId: result.displayId || taskData.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Edit a note on a task
server.tool('karea_edit_note', 'Edit an existing note on a task', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  noteId: z.string().describe('Note UUID (from karea_list_notes)'),
  content: z.string().describe('Updated note content'),
  projectId: z.string().optional().describe('Project name or ID (needed for visual ID lookup)'),
}, async (params) => {
  const pid = await resolveProject(params.projectId)
  const result = await karea.sendCommand(`/vt ${q(params.task)}`, pid)
  const taskId = result.taskId || params.task
  const taskData = await karea.getTask(taskId)
  await karea.updateNote(taskData.id, params.noteId, params.content)
  const parts = [`Note updated on "${taskData.title}".`]
  parts.push(`Note ID: ${params.noteId}`)
  parts.push(...recordFooter('task', { id: taskData.id, displayId: result.displayId || taskData.displayId }))
  return { content: [{ type: 'text', text: parts.join('\n') }] }
})

// Delete a note from a task
server.tool('karea_delete_note', 'Delete a note from a task', {
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
  description: z.string().optional().describe('Subtask description (short, one line)'),
  markdown: z.string().optional().describe('Long-form markdown content — investigation findings, technical/functional docs, solution design, root cause analysis.'),
  source: z.string().optional().describe('Where this subtask came from'),
  closingRequisites: z.array(z.string()).optional().describe('Requirements that must be met before closing'),
  tags: z.array(z.string()).optional().describe('Tags to add (e.g. ["bug", "needs review", "urgent"])'),
  jiraIssueKey: z.string().optional().describe('JIRA issue key to link (e.g. PROJ-123). Issue must exist in JIRA.'),
  projectId: z.string().optional().describe('Project name or ID (needed if parent is a visual ID)'),
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
  const parts = [(result.response || 'Subtask created.').replace(/^Task created/i, 'Subtask created')]
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
  const header = `Subtasks of ${parentVisualId ? parentVisualId + ' · ' : ''}"${parentData.title}" (id: ${parentData.id}) — ${subs.length} subtask${subs.length === 1 ? '' : 's'}`
  return { content: [{ type: 'text', text: `${header}:\n${lines.join('\n')}` }] }
})

// Add closing requisite to a task
server.tool('karea_add_requisite', 'Add a closing requisite to a task', {
  task: z.string().describe('Task name, visual ID (C1, T2), or UUID'),
  description: z.string().describe('What must be done before closing'),
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
server.tool('karea_toggle_requisite', 'Mark a closing requisite as complete or incomplete', {
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
server.tool('karea_delete_requisite', 'Delete a closing requisite from a task', {
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
server.tool('karea_get_jira_link', 'Get the JIRA link for a task', {
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

// Start the server
const transport = new StdioServerTransport()
server.connect(transport)
