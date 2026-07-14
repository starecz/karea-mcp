#!/usr/bin/env node
// KA328 v2: exercise a large Context set + retrieve via the live MCP.
// Sets ~50KB of context via karea_set_context, then reads it back with
// karea_get_context AND karea_view_task { includeContext: true } — asserts
// full byte-for-byte fidelity of a big blob (headings, code fences, unicode,
// long lines).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const mcpRoot = join(here, '..')

const TASK_ID = '61f67608-a26e-45d9-9c25-1c4e64721b3e'
const PROJECT_ID = 'c82174b5-1b7e-4dbc-a993-2d398a1f02cc'

// Build ~50KB of realistic-looking AI-scratchpad content.
function buildContext() {
  const chunks = []
  chunks.push('# Task overview\n')
  chunks.push('Investigating flaky recurrence engine on KAREA-DEV. Symptom: 3% of monthly-DOM tasks drift by one day at DST boundaries.\n\n')
  chunks.push('## Decisions\n')
  for (let i = 1; i <= 40; i++) {
    chunks.push(`- **Decision ${i}**: chose \`Intl.DateTimeFormat\` over \`Date.getMonth\` because month arithmetic across DST needs TZ awareness. Rationale on file: \`src/lib/date-format.ts:${100 + i}\`. Verified with a case at ${['America/New_York', 'Europe/Madrid', 'Asia/Tokyo', 'Pacific/Auckland'][i % 4]}.\n`)
  }
  chunks.push('\n## Working notes (running log)\n')
  for (let i = 0; i < 80; i++) {
    chunks.push(`- entry ${i}: 你好 · émoji 🎯 · timestamp T${(i * 37) % 1000}. Long context line to exercise byte fidelity: ${'x'.repeat(300)}\n`)
  }
  chunks.push('\n## Sample code block\n')
  chunks.push('```ts\nexport function nextOccurrence(anchor: Date, rule: RecurRule): Date {\n  // TODO: DST-safe increment for DOM cadence\n  return advance(anchor, rule)\n}\n```\n')
  chunks.push('\n## Open questions\n1. Should we normalize to UTC midnight on the anchor day?\n2. What happens on Feb 29 → Feb 28 rollover?\n3. Do we treat Sunday 02:00→03:00 spring-forward as a new day?\n')
  return chunks.join('')
}

let pass = 0, total = 0
const T = (cond, label) => { total++; if (cond) pass++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + label) }

async function main() {
  const context = buildContext()
  const size = Buffer.byteLength(context, 'utf8')
  console.log(`context bytes: ${size}`)
  T(size > 40000, `context is large (${size} bytes)`)

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
  const client = new Client({ name: 'ka328-large-test', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)

  // SET
  const setRes = await client.callTool({
    name: 'karea_set_context',
    arguments: { task: TASK_ID, context, projectId: PROJECT_ID },
  })
  const setText = setRes.content?.[0]?.text || ''
  console.log('set_context response:', setText)
  T(/Updated Context/.test(setText), 'karea_set_context reports Updated Context')
  T(new RegExp(`\\(${size} chars\\)|\\(${context.length} chars\\)`).test(setText), 'set_context echoes size close to input')

  // GET
  const getRes = await client.callTool({
    name: 'karea_get_context',
    arguments: { task: TASK_ID, projectId: PROJECT_ID },
  })
  const getText = getRes.content?.[0]?.text || ''
  // Response is prefixed with `# Context: <title>\n\n`
  const bodyIdx = getText.indexOf('\n\n')
  const gotBody = bodyIdx >= 0 ? getText.slice(bodyIdx + 2) : getText
  T(gotBody === context, `karea_get_context returns byte-identical body (in=${size}, out=${Buffer.byteLength(gotBody, 'utf8')})`)

  // VIEW_TASK includeContext
  const vtRes = await client.callTool({
    name: 'karea_view_task',
    arguments: { task: TASK_ID, projectId: PROJECT_ID, includeContext: true },
  })
  const vtText = vtRes.content?.[0]?.text || ''
  // Look for the AI Context section and extract everything up to the footer
  const marker = '\n\nAI Context:\n'
  const start = vtText.indexOf(marker)
  T(start !== -1, 'view_task response contains AI Context section')
  let inlineBody = ''
  if (start !== -1) {
    const after = vtText.slice(start + marker.length)
    const footerIdx = after.indexOf('\n\nID: ')
    inlineBody = footerIdx !== -1 ? after.slice(0, footerIdx) : after
  }
  T(inlineBody === context, `view_task includeContext inlines byte-identical context (in=${size}, out=${Buffer.byteLength(inlineBody, 'utf8')})`)

  // Clean up context so it doesn't pollute later runs
  await client.callTool({
    name: 'karea_set_context',
    arguments: { task: TASK_ID, context: '', projectId: PROJECT_ID },
  })

  await client.close()
  console.log(`\nResult: ${pass}/${total}`)
  process.exit(pass === total ? 0 : 1)
}

main().catch((e) => { console.error('ERR', e); process.exit(1) })
