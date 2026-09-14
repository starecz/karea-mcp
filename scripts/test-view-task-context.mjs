#!/usr/bin/env node
// Live MCP test for KA328: spawn the local MCP server via tsx (no npm publish
// required) and verify `karea_view_task` supports `includeContext: true` +
// hints when context exists but wasn't requested.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const mcpRoot = join(here, '..')

const TASK_ID = '61f67608-a26e-45d9-9c25-1c4e64721b3e'
const PROJECT_ID = 'c82174b5-1b7e-4dbc-a993-2d398a1f02cc'

let pass = 0, total = 0
const T = (cond, label) => { total++; if (cond) pass++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + label) }

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', join(mcpRoot, 'src/index.ts')],
    env: {
      ...process.env,
      KAREA_URL: 'http://localhost:3002',
      KAREA_API_KEY: 'karea_testextension123456789abcdef',
    },
    cwd: mcpRoot,
  })
  const client = new Client({ name: 'ka328-test', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)

  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name)
  T(names.includes('karea_view_task'), 'karea_view_task registered')
  T(names.includes('karea_link_session'), 'karea_link_session registered (KA291)')
  const vt = tools.tools.find((t) => t.name === 'karea_view_task')
  T(!!vt?.inputSchema?.properties?.includeContext, 'karea_view_task exposes includeContext param')

  // Call without includeContext - should include HINT that context exists
  const noCtx = await client.callTool({
    name: 'karea_view_task',
    arguments: { task: TASK_ID, projectId: PROJECT_ID },
  })
  const noCtxText = noCtx.content?.[0]?.text || ''
  console.log('--- view_task (no includeContext) ---\n' + noCtxText.slice(0, 800) + '\n---')
  T(/AI Context/i.test(noCtxText) && !noCtxText.includes('MCP_TEST_CONTEXT_MARKER'), 'no includeContext: response hints at Context without inlining it')

  // Call WITH includeContext
  const withCtx = await client.callTool({
    name: 'karea_view_task',
    arguments: { task: TASK_ID, projectId: PROJECT_ID, includeContext: true },
  })
  const withCtxText = withCtx.content?.[0]?.text || ''
  console.log('--- view_task (includeContext=true) ---\n' + withCtxText.slice(0, 800) + '\n---')
  T(withCtxText.includes('MCP_TEST_CONTEXT_MARKER: KA328 verify includeContext'), 'includeContext=true inlines the actual Context body')

  await client.close()
  console.log(`\nResult: ${pass}/${total}`)
  process.exit(pass === total ? 0 : 1)
}

main().catch((e) => { console.error('ERR', e); process.exit(1) })
