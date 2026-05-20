# Agent guidance — tools-mcp

This repo is a **personal MCP toolkit** that exposes tools to remote MCP clients (Claude.ai etc.) over HTTPS. Tools fall into two shapes:

- **CLI wrappers** — shell out to a local binary
- **API wrappers** — call a remote REST API directly

Both live as modules under `src/tools/`. Pick the shape that matches what you're exposing.

## Architecture

- `src/server.ts` — process entry; listens on PORT
- `src/app.ts` — Express app: CORS, OAuth endpoints, MCP transport
- `src/auth.ts` — OAuth 2.1 + PKCE + static bearer token middleware (mirrors `obsidian-remote-mcp`)
- `src/exec.ts` — small subprocess helper (`runCli`, `parseJsonOutput`, `CliError`) for the CLI-wrapper shape
- `src/tools.ts` — registers all tool modules onto the McpServer
- `src/tools/<name>.ts` — one module per tool surface (CLI or API)

## Adding a new tool module

Reference files: `src/tools/bird.ts` (CLI shape), `src/tools/perplexity.ts` (REST API shape).

Shared pattern:

1. Create `src/tools/<name>.ts`:
   - Export a `register<Name>Tools(server)` function
   - Read any required secrets from `process.env`, fail loudly with actionable messages when missing
   - Return both `content` (text) and `structuredContent` (parsed object) on tools with structured output
   - Mark write tools with `annotations: { readOnlyHint: false, destructiveHint: …, idempotentHint: false, openWorldHint: true }`
2. Wire it up in `src/tools.ts`
3. Add env keys to `.env.example` with comments
4. Add a section to the README's tools table

CLI shape only:

- Add the CLI as a dependency in `package.json` (so `node_modules/.bin/<bin>` is reliable, no `bunx` network roundtrip per call)
- Use `runCli` from `src/exec.ts` for subprocess calls; prefer `--json` output paths where the wrapped CLI supports them

API shape only:

- Use native `fetch` with an `AbortController` for timeouts; expose a `<NAME>_TIMEOUT_MS` env hook if calls can be slow
- Surface non-2xx responses as a humanized error string via `isError: true`

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
- Mirror [nweii/obsidian-remote-mcp](https://github.com/nweii/obsidian-remote-mcp) patterns wherever possible — same auth module, same Docker shape, same env naming style

## Install policy

`bunfig.toml` gates installs. Don't remove it.

- New package versions younger than 3 days aren't eligible — defends against malicious-publish supply-chain attacks.
- `frozenLockfile = true` — commit `bun.lock` and never run `--no-frozen-lockfile` unless you have a reason.
- `exact = true` — `bun add <pkg>` saves the version without a caret.

**CVE response** — when a patch lands inside the 3-day window and you need it now, add the package to `minimumReleaseAgeExclude` in `bunfig.toml`, run `bun install`, then revert the exclude in the same diff. The git history of the override is the audit trail.
