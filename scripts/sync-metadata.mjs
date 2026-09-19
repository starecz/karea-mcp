#!/usr/bin/env node
/*
 * Single source of truth: mcp/package.json (name, version, description, repo)
 *                         mcp/src/index.ts (tool list)
 *
 * This script regenerates the derived files so they stay in sync:
 *   - mcp/server.json          (Official MCP Registry manifest)
 *   - mcp/smithery.yaml        (Smithery directory manifest)
 *   - mcp/README.md            (tool count + tool catalogue between markers)
 *   - src/app/dashboard/help/mcp-tools.generated.ts  (the in-app help page)
 *   - public/karea-skill/SKILL.md  (catalogue between markers)
 *   - claude-skill/SKILL.md        (catalogue between markers)
 *
 * KA492: the help page used to hand-maintain its own list of tools. It drifted
 * to 33 flat tools that no longer existed in that shape. Anything that
 * describes the tool surface is generated from here now, so it cannot.
 *
 * Run automatically before `npm publish` via the prepublishOnly hook,
 * or manually any time you add/remove a tool: `npm run sync-metadata`.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// KA395 moved every registerTool() call and the group table out of index.ts
// into tools.ts, so index.ts could become a thin stdio entrypoint and the
// hosted HTTP endpoint could import the same registry. Reading index.ts here
// would now find zero actions, and the 3-15 guard below would refuse to run.
// Both are read so this keeps working whichever file they end up in.
const src = ['src/tools.ts', 'src/index.ts']
  .map((rel) => { try { return readFileSync(join(root, rel), 'utf8') } catch { return '' } })
  .join('\n')

// KA323: two different numbers now, and the distinction matters.
//   actions - the 64 operations, each registered with registerTool()
//   tools   - what the client actually SEES: one tool per noun, plus
//             karea_help. This is the number Glama scores, and the one every
//             description below must quote.
const actions = [...new Set(src.match(/registerTool\('karea_[a-z_]+'/g) || [])]
  .map(s => s.replace(/^registerTool\('/, '').replace(/'$/, ''))
  .sort()
const actionCount = actions.length

const groupTools = [...new Set(src.match(/tool: 'karea_[a-z_]+'/g) || [])]
  .map(s => s.replace(/^tool: '/, '').replace(/'$/, ''))
const tools = [...groupTools, 'karea_help'].sort()
const toolCount = tools.length

if (toolCount < 3 || toolCount > 15) {
  // Glama's guidance is a 3-15 tool surface; drifting out of it is the exact
  // problem KA323 fixed, so fail loudly rather than publishing past it.
  console.error(`Refusing to sync: the advertised surface is ${toolCount} tools, outside the 3-15 range.`)
  process.exit(1)
}

const baseDescription = `MCP server for Karea task management - ${toolCount} tools covering ${actionCount} actions, for Claude Code, Cursor, and other MCP clients to create, edit, close, and recap your dev tasks`

const serverJson = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: pkg.mcpName,
  description: `Karea task manager - ${toolCount} tools covering ${actionCount} actions, for Claude Code, Cursor, and other MCP clients.`,
  status: 'active',
  repository: {
    url: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''),
    source: 'github'
  },
  version: pkg.version,
  websiteUrl: 'https://karea.app',
  packages: [
    {
      registryType: 'npm',
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: 'stdio' },
      environmentVariables: [
        {
          name: 'KAREA_API_KEY',
          description: 'Your Karea API key. Generate at https://karea.app/dashboard/settings?section=api-keys',
          isRequired: true,
          isSecret: true
        },
        {
          name: 'KAREA_URL',
          description: 'Karea base URL. Defaults to https://karea.app for the hosted service.',
          isRequired: false,
          default: 'https://karea.app'
        }
      ]
    }
  ]
}
writeFileSync(join(root, 'server.json'), JSON.stringify(serverJson, null, 2) + '\n')

const smitheryYaml = `name: karea
displayName: Karea Task Manager
description: ${toolCount} tools covering ${actionCount} actions, so Claude Code, Cursor, and other MCP clients can manage your dev tasks (create, edit, close, recap, link to Jira, attach resources).
publisher: starecz
homepage: https://karea.app
repository: ${pkg.repository.url}
license: ${pkg.license}
categories:
  - productivity
  - task-management
  - developer-tools
keywords:
  - tasks
  - todo
  - claude-code
  - cursor
  - project-management
  - jira
startCommand:
  type: stdio
  configSchema:
    type: object
    required:
      - kareaApiKey
    properties:
      kareaApiKey:
        type: string
        title: Karea API Key
        description: Generate yours at https://karea.app/dashboard/settings?section=api-keys
        format: password
      kareaUrl:
        type: string
        title: Karea Base URL
        description: Defaults to the hosted service. Override only if self-hosting.
        default: https://karea.app
  commandFunction: |-
    (config) => ({
      command: 'npx',
      args: ['-y', '${pkg.name}'],
      env: {
        KAREA_API_KEY: config.kareaApiKey,
        KAREA_URL: config.kareaUrl || 'https://karea.app'
      }
    })
`
writeFileSync(join(root, 'smithery.yaml'), smitheryYaml)

const readmePath = join(root, 'README.md')
let readme = readFileSync(readmePath, 'utf8')
// KA323: the catalogue lists the advertised tools AND, under each, the
// actions it dispatches to - so a reader still sees every capability without
// the tool list itself being 64 long.
const groupsBlock = src.match(/const TOOL_GROUPS[\s\S]*?\n\]/)?.[0] || ''
// Summaries are written with whichever quote reads best - a summary
// containing an apostrophe uses double quotes - so the pattern has to accept
// both. A single-quote-only pattern silently dropped karea_docs from the
// catalogue, which is exactly the kind of quiet omission the check below
// now refuses to publish.
const groupEntries = [...groupsBlock.matchAll(
  /tool: '(karea_[a-z_]+)',\s*\n\s*summary: (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),\s*\n\s*actions: \[([^\]]*)\]/g,
)].map(m => ({
  tool: m[1],
  summary: (m[2] ?? m[3]).replace(/\\(['"])/g, '$1'),
  actions: [...m[4].matchAll(/'(karea_[a-z_]+)'/g)].map(a => a[1]),
}))

if (groupEntries.length + 1 !== toolCount) {
  console.error(`Refusing to sync: parsed ${groupEntries.length} groups but ${toolCount} tools are advertised - the catalogue would omit one.`)
  process.exit(1)
}
const catalogued = new Set(groupEntries.flatMap(g => g.actions))
const missing = actions.filter(a => !catalogued.has(a))
if (missing.length > 0) {
  console.error(`Refusing to sync: ${missing.length} action(s) belong to no group and would be undocumented: ${missing.join(', ')}`)
  process.exit(1)
}
const toolListMd = groupEntries.length
  ? groupEntries
      .map(g => `- \`${g.tool}\` - ${g.summary}\n  - ${g.actions.map(a => `\`${a}\``).join(', ')}`)
      .join('\n') + '\n- `karea_help` - full parameter schema for any action.'
  : tools.map(t => `- \`${t}\``).join('\n')
const catalogueBlock = `<!-- SYNC:TOOL_CATALOGUE -->
**${toolCount} tools covering ${actionCount} actions** (regenerated by \`scripts/sync-metadata.mjs\`).

Each tool takes an \`action\` and a \`params\` object. Set
\`KAREA_MCP_LEGACY_TOOLS=1\` to go back to registering all ${actionCount}
actions as individual tools.

${toolListMd}
<!-- /SYNC:TOOL_CATALOGUE -->`
readme = readme.replace(
  /<!-- SYNC:TOOL_CATALOGUE -->[\s\S]*?<!-- \/SYNC:TOOL_CATALOGUE -->/,
  catalogueBlock
)
readme = readme.replace(
  /<!-- SYNC:TOOL_COUNT -->.*?<!-- \/SYNC:TOOL_COUNT -->/g,
  `<!-- SYNC:TOOL_COUNT -->${toolCount}<!-- /SYNC:TOOL_COUNT -->`
)
writeFileSync(readmePath, readme)

if (pkg.description !== baseDescription) {
  pkg.description = baseDescription
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// KA492: everything below describes the tool surface to a human, and every one
// of these files had drifted at least once. They are generated now.
// ---------------------------------------------------------------------------
const appRoot = join(root, '..')

const generatedTs = `// GENERATED FILE - DO NOT EDIT.
// Written by mcp/scripts/sync-metadata.mjs from mcp/src/index.ts.
// Run \`npm run sync-metadata\` in mcp/ after changing the tool surface.

export interface McpToolGroup {
  tool: string
  summary: string
  actions: string[]
}

export const MCP_TOOL_COUNT = ${toolCount}
export const MCP_ACTION_COUNT = ${actionCount}

export const MCP_TOOL_GROUPS: McpToolGroup[] = ${JSON.stringify(
  [
    ...groupEntries,
    {
      tool: 'karea_help',
      summary: 'Full JSON Schema and description for any action, so an agent can call it correctly. Omit the action to list every action grouped by tool.',
      actions: [],
    },
  ],
  null,
  2,
)}
`
writeFileSync(join(appRoot, 'src/app/dashboard/help/mcp-tools.generated.ts'), generatedTs)

// The skill docs carry the same catalogue, in markdown, between markers.
const skillCatalogue = `<!-- SYNC:TOOL_CATALOGUE -->
The server advertises **${toolCount} tools** (one per noun, plus \`karea_help\`), covering
**${actionCount} actions**. Every tool takes \`{ action, params }\`:

\`\`\`json
{ "action": "karea_create_task", "params": { "name": "Fix the navbar", "priority": 1 } }
\`\`\`

${toolListMd}

Call \`karea_help\` with an action name for its full parameter schema. Set
\`KAREA_MCP_LEGACY_TOOLS=1\` to go back to ${actionCount} individual tools.
<!-- /SYNC:TOOL_CATALOGUE -->`

for (const rel of ['public/karea-skill/SKILL.md', 'claude-skill/SKILL.md']) {
  const abs = join(appRoot, rel)
  let doc
  try { doc = readFileSync(abs, 'utf8') } catch { continue }
  if (!/<!-- SYNC:TOOL_CATALOGUE -->/.test(doc)) {
    console.error(`Refusing to sync: ${rel} has no <!-- SYNC:TOOL_CATALOGUE --> marker.`)
    process.exit(1)
  }
  doc = doc.replace(/<!-- SYNC:TOOL_CATALOGUE -->[\s\S]*?<!-- \/SYNC:TOOL_CATALOGUE -->/, skillCatalogue)
  writeFileSync(abs, doc)
}

console.log(`[sync-metadata] wrote help page data + 2 skill catalogues`)

// KA515: rebuild the downloadable skill tarball.
//
// This used to be made by hand, which is precisely why it sat two months stale
// while SKILL.md moved on - anyone who downloaded it got a catalogue of 64
// tools that no longer existed. Generating it here means the file the user
// downloads and the file this script just wrote cannot disagree.
const skillDir = join(appRoot, 'public/karea-skill')
const tarball = join(appRoot, 'public/karea-claude-skill.tar.gz')
try {
  // Plain flags only: this runs under busybox tar in the node:alpine container
  // as often as under GNU tar, and busybox has no --sort or --owner.
  execFileSync('tar', ['-czf', tarball, '-C', join(appRoot, 'public'), 'karea-skill'])
  const { size } = statSync(tarball)
  console.log(`[sync-metadata] wrote public/karea-claude-skill.tar.gz (${size} bytes)`)
} catch (err) {
  console.error(`[sync-metadata] could not build the skill tarball: ${err.message}`)
  process.exit(1)
}

console.log(`[sync-metadata] wrote server.json, smithery.yaml, README.md (${toolCount} tools)`)
