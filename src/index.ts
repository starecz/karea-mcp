#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// KA395: the stdio entrypoint. Everything it serves lives in tools.ts, so
// the hosted HTTP endpoint can serve exactly the same surface.
import { toolRegistry, TOOL_GROUPS, groupDescription, errorResult, pendingReminderNudge, actionAnnotations, groupAnnotations, routeAction, helpResult, HELP_TOOL_DESCRIPTION, serverInstructions, type ToolHints } from './tools'

// KA761: say how the tools are called at `initialize`, as the hosted
// endpoint does (not for the legacy one-tool-per-action surface).
const server = new McpServer(
  { name: 'karea', version: '0.1.0' },
  process.env.KAREA_MCP_LEGACY_TOOLS === '1' ? {} : { instructions: serverInstructions(process.env.KAREA_PUBLIC_URL || 'https://karea.app') },
)

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
  hints?: ToolHints,
) => void
/**
 * Every tool is registered with a title and its behaviour hints
 * (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) - the MCP
 * directory review requires them, and clients use them to decide when to ask
 * the user before a call.
 */
const registerOnServer: ToolRegistrar = (name, description, shape, handler, hints) => {
  const h = hints ?? actionAnnotations(name)
  const { title, ...annotations } = h
  ;(server as any).registerTool(name, { title, description, inputSchema: shape, annotations: { title, ...annotations } }, handler)
}

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
        // KA761: the enum is still what clients see, but a value outside it
        // reaches the handler (`.catch` passes the raw input through) so the
        // caller is told which tool owns the action, or which name it meant,
        // instead of a bare enum mismatch. "list_notes" is accepted too.
        action: z.enum(actions as [string, ...string[]]).catch((ctx: any) => ctx.input).describe('Which operation to perform: one of the actions listed in this tool\'s description (an action name, not a tool name).'),
        params: z.record(z.any()).optional().describe('Arguments for the chosen action, as an object. Omit for actions that take none.'),
      },
      async ({ action, params }: { action: string; params?: Record<string, any> }) => {
        const route = routeAction(group.tool, action)
        if (!route.ok) return errorResult(route.message)
        const { entry } = route
        action = route.action
        // The action's own schema still validates, so a bad call fails the
        // same way and with the same message it always did.
        const parsed = z.object(entry.shape).safeParse(params ?? {})
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
          return errorResult(`Invalid params for ${action} - ${issues}. Call karea_help with action="${action}" for the full schema.`)
        }
        return entry.handler(parsed.data)
      },
      groupAnnotations({ tool: group.tool, actions }),
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
    HELP_TOOL_DESCRIPTION,
    {
      action: z.string().optional().describe('An action name, e.g. "karea_create_task" (or "create_task"). Omit to list all of them.'),
    },
    async ({ action }: { action?: string }) => helpResult(action),
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
