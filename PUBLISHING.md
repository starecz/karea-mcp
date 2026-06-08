# Publishing karea-mcp

## Source of truth

| Fact | Lives in | Used by |
| --- | --- | --- |
| npm name (`karea-mcp`) | `package.json` `name` | `server.json`, `smithery.yaml`, README install snippets |
| Registry name (`io.github.starecz/karea-mcp`) | `package.json` `mcpName` | `server.json` `name` |
| Version | `package.json` `version` | `server.json` top-level + package version |
| Description (count + summary) | derived in `scripts/sync-metadata.mjs` from tool count | `package.json`, `server.json`, `smithery.yaml`, README |
| Repository URL | `package.json` `repository.url` | `server.json`, `smithery.yaml` |
| Tool list and count | `src/index.ts` (regex match on `'karea_*'` strings) | README "Tool catalogue", count in all descriptions |
| Required env vars (`KAREA_API_KEY`, `KAREA_URL`) | hard-coded in `scripts/sync-metadata.mjs` and `src/karea-client.ts` | `server.json` `environmentVariables`, `smithery.yaml` `configSchema` |

**Rule: never edit `server.json`, `smithery.yaml`, or the README tool catalogue by hand.** They are regenerated. Edit the source (`package.json` or `src/index.ts`), then run `npm run sync-metadata`.

## Regenerate derived files

```bash
cd mcp
npm run sync-metadata
```

This is also wired into `prepublishOnly` so `npm publish` will not ship a stale manifest.

## Release flow

1. **Add or remove a tool** in `src/index.ts` (this is the only place tools are declared).
2. **Bump version** in `package.json` (`npm version patch | minor | major`).
3. `npm run sync-metadata` — regenerates `server.json`, `smithery.yaml`, README count + catalogue.
4. `npm publish` — runs `prepublishOnly` (sync + build) automatically.
5. **Push to the Official MCP Registry** (only first time + on version bumps):
   ```bash
   mcp-publisher login github   # one-time, opens device flow
   mcp-publisher publish        # reads server.json
   ```
6. **Smithery** picks up automatically once registered, or:
   ```bash
   npx -y @smithery/cli@latest mcp publish https://github.com/starecz/karea-mcp -n starecz/karea-mcp
   ```

## Adding new metadata fields

If a directory wants a new field (e.g. a logo URL, a tagline), add it to:
- `scripts/sync-metadata.mjs` — derive it from a source-of-truth field
- Update this doc's table

Do not hard-code in the derived files.
