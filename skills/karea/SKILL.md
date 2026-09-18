---
name: karea
description: Use this skill for ALL Karea task-manager work, and load it BEFORE calling any `karea` / `mcp__karea__*` MCP tool. Triggers whenever the user wants to create, edit, close, view, or look up Karea tasks, projects, categories, notes, questions, or resources; set/read a task's AI Context or long-form markdown; get a recap; link an AI session to a task; or any request that sounds like task tracking ("add a task", "what's on my plate", "mark X done", "add a note", "ask a question", "pick up <task>", or references a task by its ID like KA123 / HA42 / C1 / T2). If you are about to use a `karea` / `mcp__karea__*` MCP tool and this skill is not loaded, load it first and follow its discipline (read Context before working, link the session automatically, keep Context current, notes vs context vs markdown). Prefer this skill over generic note-taking.
---

# Karea

Karea is a keyboard-first task manager at [karea.app](https://karea.app). This skill lets the user drive Karea from inside Claude Code through the `karea` MCP server.

## When to use this skill

- The user asks to create, edit, close, delete, or view a task / project / category.
- The user asks "what do I have to do", "show my tasks", "what's blocked".
- The user wants a recap of recent activity.
- The user wants to read or write the markdown document attached to a task (common during debugging -- dump findings, root cause, fix).
- The user references a task by its per-project ID (e.g. `HA123`) or its category-visual ID (e.g. `C1`, `T2`).
- The user wants to add, edit, or read notes on a task.
- The user wants to ask or answer open questions.
- The user wants to manage resources (files, text snippets, links).

## Tools available via the `karea` MCP

The user's API key is configured in their MCP config (`KAREA_API_KEY`).

<!-- SYNC:TOOL_CATALOGUE -->
The server advertises **12 tools** (one per noun, plus `karea_help`), covering
**64 actions**. Every tool takes `{ action, params }`:

```json
{ "action": "karea_create_task", "params": { "name": "Fix the navbar", "priority": 1 } }
```

- `karea_projects` - Projects and their categories: list, create, delete, share, and manage the categories inside a project.
  - `karea_list_projects`, `karea_create_project`, `karea_delete_project`, `karea_share_project`, `karea_create_category`, `karea_delete_category`
- `karea_tasks` - Tasks: find them, read them, create them, change them, close them. The main entry point - start here.
  - `karea_list_tasks`, `karea_view_task`, `karea_view_tasks`, `karea_create_task`, `karea_edit_task`, `karea_close_task`, `karea_delete_task`, `karea_quick_task`, `karea_doing`, `karea_done`
- `karea_subtasks` - Subtasks and closing requisites - the checklist a task has to satisfy before it can be closed.
  - `karea_create_subtask`, `karea_list_subtasks`, `karea_add_requisite`, `karea_toggle_requisite`, `karea_delete_requisite`
- `karea_notes` - Notes on a task - human-readable updates the user reads. For private cross-session memory use karea_docs (set_context).
  - `karea_list_notes`, `karea_add_note`, `karea_edit_note`, `karea_delete_note`
- `karea_docs` - A task's long-form markdown document and its AI Context (private working memory that survives across sessions).
  - `karea_get_markdown`, `karea_set_markdown`, `karea_get_context`, `karea_set_context`
- `karea_questions` - Open questions: things you are waiting on an answer for. Create, answer, edit, delete.
  - `karea_list_questions`, `karea_create_question`, `karea_answer_question`, `karea_edit_question`, `karea_delete_question`
- `karea_resources` - The file/document library: list, read, create, update, upload, delete, and attach resources to tasks.
  - `karea_list_resources`, `karea_get_resource`, `karea_create_resource`, `karea_update_resource`, `karea_upload_resource`, `karea_delete_resource`, `karea_link_resource_to_task`, `karea_unlink_resource_from_task`
- `karea_meetings` - Meetings, and the tasks and open questions attached to them.
  - `karea_list_meetings`, `karea_view_meeting`, `karea_create_meeting`, `karea_edit_meeting`, `karea_delete_meeting`, `karea_link_task_to_meeting`, `karea_unlink_task_from_meeting`, `karea_link_question_to_meeting`, `karea_unlink_question_from_meeting`
- `karea_reminders` - Reminders: see what is due, create one, snooze it, dismiss it, mark it done.
  - `karea_check_reminders`, `karea_create_reminder`, `karea_snooze_reminder`, `karea_dismiss_reminder`, `karea_mark_reminder_done`
- `karea_integrations` - JIRA links on a task, and AI CLI sessions linked to a task.
  - `karea_get_jira_link`, `karea_link_jira`, `karea_unlink_jira`, `karea_link_session`, `karea_list_sessions`, `karea_unlink_session`
- `karea_assistant` - Ask Karea a natural-language question about your work, or generate a recap of a period.
  - `karea_ask`, `karea_recap`
- `karea_help` - full parameter schema for any action.

Call `karea_help` with an action name for its full parameter schema. Set
`KAREA_MCP_LEGACY_TOOLS=1` to go back to 64 individual tools.
<!-- /SYNC:TOOL_CATALOGUE -->

### Tasks

Called through `karea_tasks` or `karea_subtasks` or `karea_docs`.


| Action | Use for |
|---|---|
| `karea_list_tasks` | List tasks in a project; filter with `status` (open, in_progress, blocked, review, backlog, done). |
| `karea_view_task` | Full detail of one task (resolves UUID, `HA123`, `C1`, or exact title). Output also includes any linked resources with their IDs. Pass `includeContext: true` to inline the task's AI Context (avoids a follow-up `karea_get_context` round-trip); when omitted, the response hints that Context exists. |
| `karea_view_tasks` | Same as `karea_view_task` but batched: pass an array of task refs (visual IDs, names, or UUIDs) and get one consolidated response with a block per task. Max 50 per call. Prefer this over calling `karea_view_task` N times when inspecting a batch. |
| `karea_create_task` | New task. Flags: `name`, `category`, `priority`, `sla` (`2d`/`5h`/`tomorrow`), `description` (rendered as Markdown -- use `**bold**`, lists, `code`, links), `source`, `closingRequisites`, `tags`, `markdown`, `jiraIssueKey`, `parentId` (UUID only). For subtasks, prefer `karea_create_subtask`. |
| `karea_create_subtask` | Create a subtask under a parent. Takes `parent` (visual ID like `KPL77`, name, or UUID) plus the same flags as `karea_create_task`. Inherits the parent's category by default. |
| `karea_list_subtasks` | List subtasks of a parent task. Accepts `parent` as visual ID, name, or UUID. |
| `karea_edit_task` | Edit any field of a task: `name` (rename), `priority`, `status`, `sla`, `description` (Markdown), `markdown`, `category`, `tags` (with `clearTags` to replace), `closingRequisites` (with `clearClosingRequisites`), `jiraIssueKey` (set to `"unlink"` to remove), or `note` to append a note. |
| `karea_close_task` | Close a task; optional `resolution`. |
| `karea_delete_task` | Delete; requires `confirm: true`. |
| `karea_doing` | Create a task already in `in_progress` status. |
| `karea_done` | Close many tasks at once (array of refs). |
| `karea_quick_task` | "I just did this" log entry (`/did`). |
| `karea_get_markdown` / `karea_set_markdown` | Read/write the long-form markdown doc on a task -- **use this to persist investigation notes**. |
| `karea_get_context` / `karea_set_context` | Read/write the task's **Context** -- titled entries of AI working memory that hold the **full history** of a task (what was tried, decided, discovered, abandoned) across sessions (e.g. `Plan`, `Findings`, `Decisions`, `Gotchas`, `Attempted`). `karea_set_context` upserts by `title` (default `General`); empty content deletes the entry. Read FIRST when picking a task up, then update **incrementally** -- never overwrite with just the current status. Distinct from notes (human-readable) and markdown (long-form docs). |
| `karea_add_requisite` | Add a closing requisite (checklist item before task can close). |
| `karea_toggle_requisite` | Mark a closing requisite as done or undone. |
| `karea_delete_requisite` | Delete a closing requisite. |

### Notes

Called through `karea_notes`.


| Action | Use for |
|---|---|
| `karea_add_note` | Add a note to a task. |
| `karea_edit_note` | Edit an existing note's content. |
| `karea_delete_note` | Delete a note from a task. |
| `karea_list_notes` | List all notes on a task. |

### Questions

Called through `karea_questions`.


| Action | Use for |
|---|---|
| `karea_create_question` | Create an open question on a project. Accepts an optional `markdown` body (long-form context) and `taskIds` to pre-link tasks (visual IDs or UUIDs). |
| `karea_edit_question` | Update a question. Editable: `question`, `answer`, `status` (`open` / `answered` / `cancelled`), `markdown`. Link tasks with `taskIdsAdd`, unlink with `taskIdsRemove`. |
| `karea_answer_question` | Answer a question (also flips status to `answered`). Accepts the question's short ID (e.g. `KAQ3`) or UUID. |
| `karea_edit_question` / `karea_delete_question` | Edit or delete a question by its short ID (e.g. `KAQ3`) or UUID. |
| `karea_list_questions` | List questions in a project. `status` filter accepts `open`, `answered`, `cancelled`, or `all` (default). Each question has a static short ID (`<prefix>Q<seq>`, e.g. `KAQ3`) you can reference from anywhere. |

### Resources

Called through `karea_resources`.


| Action | Use for |
|---|---|
| `karea_create_resource` | Create a text resource. Accepts `name`, `content`, optional `folder`. |
| `karea_upload_resource` | Upload a binary file as a resource (base64-encoded). Accepts `name`, `data` (base64), optional `mimeType`, `folder`, and `taskId` to auto-link the resource to a task on upload. |
| `karea_get_resource` | Get a resource's full metadata + content (text) by UUID. Binary files return metadata only. |
| `karea_update_resource` | Update a resource. Editable: `name`, `content` (text resources only), `folder`. |
| `karea_delete_resource` | Delete a resource (needs the resource UUID). |
| `karea_link_resource_to_task` / `karea_unlink_resource_from_task` | Link or unlink an existing resource to/from a task. |
| `karea_list_resources` | List resources. With a `projectId` it returns every resource in that project -- assigned to it, linked to one of its tasks, or filed under a folder named after the project (e.g. knowledge-base docs). Omit `projectId` to list all your resources, including unfiled ones. Output includes size, MIME, folder, and linked tasks. |

### Reminders (KA422)

Called through `karea_reminders`.


Task-scoped reminders. When a reminder fires, Karea shows a full-screen in-app modal to the user and (optionally) emails them. The MCP surfaces reminders in two ways:

1. **Auto-nudge:** every `karea` / `mcp__karea__*` tool response automatically appends a `⏰ Pending reminders:` block if the caller has any past-due or currently-firing reminders. No polling needed - the very next tool call surfaces them.
2. **Dedicated tools:**

| Action | Use for |
|---|---|
| `karea_check_reminders` | List the caller's reminders. Optional `taskId` filter and `includeDone` flag. Useful before doing focused work so you know what will interrupt. |
| `karea_create_reminder` | Schedule a reminder on a task. `fireAt` accepts ISO datetime or friendly forms like `2h`, `3d`, `tomorrow 9am`. Optional `title` (falls back to task title), `repeat` (`daily` / `weekly` / `monthly`), `emailOptIn` (bool, default false - in-app modal is always on). |
| `karea_snooze_reminder` | Snooze by N minutes. |
| `karea_dismiss_reminder` | Cancel a reminder - it will not fire again. |
| `karea_mark_reminder_done` | Fulfill a reminder AND close the underlying task (status = done). |

When you see the `⏰ Pending reminders:` footer, decide with the user before dismissing anything. Snoozing (`+15m`, `+1h`, `tomorrow`) is the safe default when the user is busy.

### AI Sessions

Called through `karea_integrations`.


Link your current AI coding session (Claude Code, OpenCode, Codex, Cursor, Aider) to a task so the user can see the history and copy a resume command later.

| Action | Use for |
|---|---|
| `karea_link_session` | Link the current session: `task`, `provider` (`claude-code` / `opencode` / `codex` / `cursor` / `aider` / `other`), `sessionId`, optional `label`. Call this automatically as soon as the user names the task they're working on (see "Session linking" below). Re-linking the same session refreshes its last-active stamp. |
| `karea_list_sessions` | List AI sessions linked to a task (provider, session id, last active, row id). |
| `karea_unlink_session` | Remove a linked session by its row id (from `karea_list_sessions`). |

### JIRA

Called through `karea_integrations`.


| Action | Use for |
|---|---|
| `karea_get_jira_link` | Get the JIRA link for a task. |
| `karea_link_jira` | Link a task to a JIRA issue by key (e.g. PROJ-123). |
| `karea_unlink_jira` | Remove the JIRA link from a task. |

### Projects & Categories

Called through `karea_projects`.


| Action | Use for |
|---|---|
| `karea_list_projects` | List the user's projects with IDs and category summary. |
| `karea_create_project` / `karea_delete_project` | Project management. |
| `karea_share_project` | Share a project with another user by email. `role` is one of `owner`, `editor`, `viewer` (default: `editor`). |
| `karea_create_category` | Create a category in a project. |
| `karea_delete_category` | Delete a category **and every task in it** (cascade). Requires `confirm: true`. Move tasks out first if they should survive. |

### Other

Called through `karea_assistant`.


| Action | Use for |
|---|---|
| `karea_recap` | Recent activity summary over a time window (`hours`, default 24). Returns sections: DONE, QUICK TASKS, IN PROGRESS, BLOCKED, DUE TODAY, OPEN QUESTIONS. |
| `karea_ask` | Natural-language request routed through Karea's AI (the same engine the in-app chat uses). |

## Output the tools return

Every mutation or single-record lookup ends with a small footer the user expects you to surface verbatim:

```
ID: <uuid>
Short ID: <visual id, e.g. KA231>          # only on tasks
Link: https://karea.app/dashboard/task/<uuid>
```

When you report back to the user, **include the Link** so they can click straight through. Don't replace it with the raw UUID and don't strip it.

## Conventions the user expects

- **Task IDs**: prefer per-project IDs like `HA123` when the project has a prefix, else the short visual ID like `C1` / `T2`. Never paste a UUID to the user unless they ask.
- **Status values**: `open`, `in_progress` ("Doing"), `blocked`, `review`, `backlog`, `done`. When the user says "doing" they mean `in_progress`; when they say "review" they mean `review`.
- **Priority**: `1` = critical, `5` = minor. Default is `3`.
- **SLA shortcuts**: `2d`, `5h`, `30m`, `1w`, `tomorrow`, `monday`.

## Session linking -- do this automatically

When the user says they are working on a specific Karea task ("working on KA123", "let's do HA42", "pick up the flares bug"), do BOTH of these immediately, without being asked:

1. **Link the session**: call `karea_link_session` with the current session id (`provider: "claude-code"`, the id Claude Code reports for `claude --resume`) and a short label describing the work. Re-linking the same session later is safe -- it just refreshes the "last active" stamp. Alternatively, every task-referencing tool (`karea_create_task`, `karea_edit_task`, `karea_close_task`, `karea_quick_task`, `karea_doing`, `karea_set_markdown`, `karea_set_context`, `karea_add_note`, `karea_edit_note`, `karea_create_subtask`) also accepts the same session fields inline (`aiSessionId`, `toolType`, `sessionLabel`) so a plan/note/status-change can link the session in one call.
2. **Set it in progress** (if you are starting work now): `karea_edit_task({ task, status: "in_progress" })`.
3. **Read the Context**: `karea_get_context` before doing anything else, so you resume with full memory instead of re-deriving it.

## Context discipline -- keep it current, automatically

Context tracks the **full history** of a task -- what was tried, decided, discovered, and abandoned along the way -- NOT just its current state. Treat it as the DEFAULT place to persist what you learn, and update it **incrementally** so the journey is preserved:

- After making a **plan** -> `karea_set_context({ task, title: "Plan", context: ... })`.
- After a significant **finding, root cause, or discovery** -> read + append to the `Findings` entry.
- After a **decision** (approach chosen, trade-off accepted) -> read + append to the `Decisions` entry with the reasoning.
- Hit a **gotcha** worth remembering -> read + append to `Gotchas`.
- After trying and abandoning an approach -> read + append to `Attempted` so the next session doesn't retry it.
- **Read first with `karea_get_context`, refine, write back.** Do NOT overwrite an entry with the current status -- that erases the reasoning that got you here. Same title = same entry, but its content grows as the task evolves.
- Notes, markdown, and description are still used when the user asks for them or the content is human-facing -- but Context gets updated **as well**, always.

## Tags -- use existing only

`tags` on `karea_create_task` / `karea_edit_task` / `karea_create_subtask` upserts by name, so a typo or a paraphrase creates a **duplicate** tag. Rule:

- Only pass tags that already exist in the project. Check `karea_view_task` (a similar task) or the project's tag list first.
- Do NOT invent a new tag unless the user explicitly asked for one.
- When unsure whether a tag exists, omit it and ask the user.

## How to work

1. **Read before writing.** Before editing anything non-trivial, call `karea_view_task` or `karea_list_tasks` so you see the current state.
2. **Confirm destructive actions.** `karea_delete_task`, `karea_delete_project`, `karea_delete_category` and `karea_delete_meeting` all require `confirm: true`. Ask the user for authorization before passing it, and say what will go with it: deleting a **project** takes its tasks, categories, notes and history; deleting a **category** takes **every task inside it** (the schema cascades `Task.category`), which is rarely what someone picturing "remove this label" expects -- move the tasks with `karea_edit_task` first if they should survive. Deleting a **meeting** is the exception: linked tasks and questions outlive it, only the links go.
3. **Markdown is your scratchpad.** When the user asks you to investigate a bug tied to a task, dump your findings with `karea_set_markdown`. Always read first with `karea_get_markdown` to avoid overwriting existing content.
4. **Don't invent tasks.** If the user asks about a task that doesn't resolve, say so -- don't guess at a best-match title.
5. **Notes vs Context vs Markdown -- three different things.** `karea_add_note` = a short, **human-readable** update the user reads (markdown supported). `karea_set_context` = titled entries of **AI working memory** that persist across sessions (Plan, Findings, Decisions, Gotchas) -- your default save target; keep it current proactively (see "Context discipline" above). `karea_set_markdown` = the long-form documentation/knowledge base. Human update -> note; your own cross-session memory -> context (always); long-form docs -> markdown.
6. **Questions for blockers.** Use `karea_create_question` when the user needs to surface an open question for the team.

## Example flows

**"Add a bug: flares broken on external monitor. P2, due tomorrow."**
```
karea_create_task({ name: "Flares broken on external monitor", category: "Bugs", priority: 2, sla: "tomorrow" })
```

**"Mark HA42 as doing, note: started on the regex."**
```
karea_edit_task({ task: "HA42", status: "in_progress", note: "Started on the regex." })
```

**"Tag HA42 as bug + urgent and link it to JIRA PROJ-101."**
```
karea_edit_task({ task: "HA42", tags: ["bug", "urgent"], jiraIssueKey: "PROJ-101" })
```

**"Dump what we found about HA123 to its markdown."**
```
karea_get_markdown({ task: "HA123" })
karea_set_markdown({ task: "HA123", markdown: "# Root cause\n\n...\n\n# Fix\n\n..." })
```

**"Weekly recap."**
```
karea_recap({ hours: 168 })
```

**"Add a note to HA42: deployed the fix to staging."**
```
karea_add_note({ task: "HA42", content: "Deployed the fix to staging." })
```

**"What open questions do we have?"**
```
karea_list_questions({ status: "open" })
```
