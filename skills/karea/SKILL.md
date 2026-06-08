---
name: karea
description: Use this skill when the user wants to track, create, edit, close, recap, or otherwise manage tasks in Karea (karea.app) - their task manager. Karea exposes 44 MCP tools that map to its slash commands and dashboard actions.
---

# Karea Task Manager

Karea is a keyboard-first task manager for solo developers. This skill teaches Claude Code how to use the Karea MCP server to manage tasks naturally during a coding session.

## When to use

- User says "log this as a task", "create a task", "add to my todo", "I'm starting on X", "I'm done with Y", "what's next", "show me my tasks", "give me a recap of last week"
- User mentions a Karea task by short ID (e.g. `KA37`, `KPL12`) or by name
- User asks Claude to open / answer questions on a task while working
- User wants to link the current work to a Jira issue or a resource file

## Core flow

1. **Start work** -> `karea_doing("task title or ID")` to set status to in_progress
2. **Add open questions** as they arise -> `karea_create_question(task, "what should X behave like when Y?")`
3. **Add closing requisites** that must be true before close -> `karea_add_requisite(task, "tests pass")`
4. **Append investigation notes** to long-form markdown -> `karea_set_markdown(task, "..." )` or `karea_add_note(task, "...")`
5. **Finish** -> `karea_toggle_requisite` to tick each closing requisite, then `karea_done(task)` or `karea_close_task(task)`

## Common patterns

- **Quick capture during conversation**: `karea_quick_task("fix the bug we just found")`
- **Detailed task with structure**: `karea_create_task` with title, description, priority (1=critical), category, tags, closingRequisites array, markdown body
- **Subtasks for breakdown**: `karea_create_subtask(parent, "step 1")`, repeat
- **Productivity recap across a date range**: `karea_recap(from, to)`
- **Link to Jira**: `karea_link_jira(task, "PROJ-123")`
- **Attach a file or URL**: `karea_create_resource` then `karea_link_resource_to_task`

## Conventions

- Always prefer the user's existing task IDs (e.g. `KA37`) over creating duplicates
- When closing a task, write a 2-3 sentence note about what changed and any technically notable detail
- Default status on finish is `review`, not `done` (unless user says done explicitly)
- Never run destructive actions (`karea_delete_*`) without explicit user confirmation

## Setup

The Karea MCP server is configured via `.mcp.json` in this plugin. Users need an API key from <https://karea.app/dashboard/settings/api-keys> exposed as `KAREA_API_KEY`. The full tool catalogue (44 tools) is in the plugin README.
