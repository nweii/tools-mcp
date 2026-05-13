# Agent guidance — nweii-tools-mcp

This repo is a **personal MCP toolkit** wrapping local CLIs as MCP tools, so remote MCP clients (Claude.ai etc.) can call them over HTTPS.

## Architecture

- `src/server.ts` — process entry; listens on PORT
- `src/app.ts` — Express app: CORS, OAuth endpoints, MCP transport
- `src/auth.ts` — OAuth 2.1 + PKCE + static bearer token middleware (mirrors `obsidian-remote-mcp`)
- `src/exec.ts` — small subprocess helper (`runCli`, `parseJsonOutput`, `CliError`) for shelling out to local CLIs
- `src/tools.ts` — registers all per-CLI tool modules onto the McpServer
- `src/tools/<name>.ts` — one module per wrapped CLI

## Adding a new CLI wrapper

Read `src/tools/bird.ts` as the reference. The pattern:

1. Add the CLI as a dependency in `package.json` (so `node_modules/.bin/<bin>` is reliable, no `bunx` network roundtrip per call)
2. Create `src/tools/<name>.ts`:
   - Export a `register<Name>Tools(server)` function
   - Read any required secrets from `process.env`, fail loudly with actionable messages when missing
   - Use `runCli` from `src/exec.ts` for subprocess calls
   - Use `--json` output paths where the wrapped CLI supports it; return both `content` (text) and `structuredContent` (parsed object) on JSON tools
   - Mark write tools with `annotations: { readOnlyHint: false, destructiveHint: …, idempotentHint: false, openWorldHint: true }`
3. Wire it up in `src/tools.ts`
4. Add env keys to `.env.example` with comments
5. Add a row to the README's tools table

## Testing without deploying

Run locally with cookies in env:

```bash
BIRD_AUTH_TOKEN=… BIRD_CT0=… MCP_CLIENT_ID=dev MCP_STATIC_BEARER_TOKEN=$(openssl rand -hex 32) bun run start
```

Then call MCP directly:

```bash
curl -s -H "Authorization: Bearer $MCP_STATIC_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://localhost:3457/mcp | jq
```

## Conventions

- Bun + TypeScript, no separate build step (Bun runs `.ts` directly)
- Files start with `// ABOUTME: <one-liner>`
- Secrets never live in this repo — only in `.env` (gitignored), Docker env, or the host's environment
- Each tool returns either text content or structured JSON, never plain CLI stderr — surface errors via `isError: true` with a humanized message
- Mirror `obsidian-remote-mcp` patterns wherever possible — same auth module, same Docker shape, same env naming style

## Install policy

`bunfig.toml` gates installs. Don't remove it.

- New package versions younger than 3 days aren't eligible — defends against malicious-publish supply-chain attacks (the May 2026 npm incident and its family).
- `frozenLockfile = true` — commit `bun.lock` and never run `--no-frozen-lockfile` unless you have a reason.
- `exact = true` — `bun add <pkg>` saves the version without a caret.

**CVE response** — when a patch lands inside the 3-day window and you need it now, add the package to `minimumReleaseAgeExclude` in `bunfig.toml`, run `bun install`, then revert the exclude in the same diff. The git history of the override is the audit trail.
