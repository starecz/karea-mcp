#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// KA395: the stdio entrypoint. Everything it serves lives in tools.ts, so
// the hosted HTTP endpoint can serve exactly the same surface.
import { toolRegistry, TOOL_GROUPS, groupDescription, errorResult, pendingReminderNudge } from './tools'

const server = new McpServer({
  name: 'karea',
  version: '0.1.0',
})

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

/**
 * The SDK's `server.tool` infers the handler's argument type from the zod
 * shape it is given. That works for a literal shape written inline; with a
 * shape assembled at runtime it sends the checker into an unbounded
 * instantiation (TS2589, and an out-of-memory crash before it even reports
 * it). Registration is the same call either way - only the inference is
 * skipped.
 */
type ToolRegistrar = (
  name: string,
  description: string,
  shape: Record<string, z.ZodTypeAny>,
  handler: (args: any) => Promise<any>,
) => void
const registerOnServer = server.tool.bind(server) as unknown as ToolRegistrar

function registerCompactSurface() {
  const grouped = new Set<string>()

  for (const group of TOOL_GROUPS) {
    const actions = group.actions.filter((a) => toolRegistry.has(a))
    if (actions.length === 0) continue
    actions.forEach((a) => grouped.add(a))

    registerOnServer(
      group.tool,
      groupDescription(group),
      {
        action: z.enum(actions as [string, ...string[]]).describe('Which operation to perform. See the list in this tool\'s description.'),
        params: z.record(z.any()).optional().describe('Arguments for the chosen action, as an object. Omit for actions that take none.'),
      },
      async ({ action, params }: { action: string; params?: Record<string, any> }) => {
        const entry = toolRegistry.get(action)
        if (!entry) return errorResult(`Unknown action "${action}".`)
        // The action's own schema still validates, so a bad call fails the
        // same way and with the same message it always did.
        const parsed = z.object(entry.shape).safeParse(params ?? {})
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
          return errorResult(`Invalid params for ${action} - ${issues}. Call karea_help with action="${action}" for the full schema.`)
        }
        return entry.handler(parsed.data)
      },
    )
  }

  // Anything not claimed by a group would silently disappear, which is worse
  // than an extra tool. Register it on its own so the surface can never lose
  // a capability by omission.
  for (const [name, entry] of toolRegistry) {
    if (grouped.has(name)) continue
    registerOnServer(name, entry.description, entry.shape, entry.handler)
  }

  registerOnServer(
    'karea_help',
    'Return the full JSON Schema and description of any Karea action, so you can call it correctly through its group tool. Read-only; changes nothing. Omit `action` to list every available action grouped by tool.',
    {
      action: z.string().optional().describe('An action name, e.g. "karea_create_task". Omit to list all of them.'),
    },
    async ({ action }: { action?: string }) => {
      if (!action) {
        const lines: string[] = []
        for (const group of TOOL_GROUPS) {
          const actions = group.actions.filter((a) => toolRegistry.has(a))
          if (actions.length === 0) continue
          lines.push(`${group.tool}: ${actions.join(', ')}`)
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      }
      const entry = toolRegistry.get(action)
      if (!entry) {
        return errorResult(`Unknown action "${action}". Call karea_help with no arguments to list them all.`)
      }
      const params = Object.entries(entry.shape).map(([key, schema]) => ({
        name: key,
        required: !schema.isOptional(),
        description: schema.description || '',
      }))
      const group = TOOL_GROUPS.find((g) => g.actions.includes(action))
      const text = [
        `${action}${group ? ` (call it through ${group.tool})` : ''}`,
        '',
        entry.description,
        '',
        'Parameters:',
        ...(params.length
          ? params.map((p) => `- ${p.name}${p.required ? '' : ' (optional)'}: ${p.description}`)
          : ['(none)']),
      ].join('\n')
      return { content: [{ type: 'text' as const, text }] }
    },
  )
}

function registerLegacySurface() {
  for (const [, entry] of toolRegistry) {
    registerOnServer(entry.name, entry.description, entry.shape, entry.handler)
  }
}

// KAREA_MCP_LEGACY_TOOLS=1 restores the pre-KA323 surface: all 64 tools
// registered individually. One environment variable back, for a client that
// has the old names wired in.
if (process.env.KAREA_MCP_LEGACY_TOOLS === '1') registerLegacySurface()
else registerCompactSurface()

// Start the server
const transport = new StdioServerTransport()
server.connect(transport)
