# tools-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server that exposes personal tools — wrapped local CLIs and remote APIs — to MCP clients (Claude.ai, Claude Code, etc.) over HTTPS.

This is a **personal toolkit** — modular by design. Each tool surface lives in its own module under `src/tools/`. Current modules wrap [`@steipete/bird`](https://www.npmjs.com/package/@steipete/bird) for X/Twitter and the [Perplexity AI API](https://docs.perplexity.ai/) for web-grounded search, ask, research, and reasoning.

## Why

Some CLIs only work where they're installed (because of cookies, auth files, local paths, system access, etc.). Running them on a single trusted host (a NAS, a home server) and exposing them as MCP tools means any MCP client can call them without re-authenticating per machine.

## What it includes

### Bird (X/Twitter)

| Tool | Description |
|------|-------------|
| `bird_whoami` | Verify which X account is authenticated |
| `bird_read` | Read a tweet by ID/URL (JSON) |
| `bird_thread` | Full thread containing a tweet (JSON) |
| `bird_replies` | Replies to a tweet (JSON) |
| `bird_search` | Search tweets, supports operators (JSON) |
| `bird_mentions` | Mentions of a user (defaults to authenticated account) |
| `bird_bookmarks` | Read your bookmarks (JSON) |
| `bird_post_tweet` | **Write.** Post a tweet |
| `bird_reply` | **Write.** Reply to a tweet |

### Perplexity (web-grounded AI)

Calls the [Perplexity REST API](https://docs.perplexity.ai/) directly. Requires `PERPLEXITY_API_KEY` in the server env. All four tools are read-only and billed to that key.

| Tool | Description |
|------|-------------|
| `perplexity_search` | Ranked search results (title, URL, snippet, date) — no AI synthesis |
| `perplexity_ask` | Quick web-grounded answer with citations (`sonar-pro`) |
| `perplexity_research` | Deep multi-source research (`sonar-deep-research`, 30s+ per call) |
| `perplexity_reason` | Step-by-step reasoning with web grounding (`sonar-reasoning-pro`) |

## Security

- **OAuth 2.1 + PKCE** at `/authorize` and `/oauth/token` (compatible with Claude.ai's connector flow)
- **Static bearer token** (`MCP_STATIC_BEARER_TOKEN`) for clients that bypass the browser flow
- **CORS allowlisting** via `CORS_ALLOWED_ORIGINS`
- Bird cookies live only in the server's environment (`BIRD_AUTH_TOKEN`, `BIRD_CT0`) — never in this repo

## Quick start (local)

```bash
git clone git@github.com:nweii/tools-mcp.git
cd tools-mcp
bun install
cp .env.example .env
# edit .env and fill in BIRD_AUTH_TOKEN, BIRD_CT0, MCP_CLIENT_ID
bun run start
```

The server listens on `PORT` (default 3457). MCP endpoint is `POST /mcp`.

Smoke-test bird directly (bypassing MCP) — useful before deploying:

```bash
BIRD_AUTH_TOKEN=… BIRD_CT0=… ./node_modules/.bin/bird whoami
```

## Deployment (NAS / home server)

The same pattern as `obsidian-remote-mcp`: Docker behind a reverse proxy that handles TLS, with the public origin set in `MCP_BASE_URL`.

1. Copy `docker-compose.yml.example` to `docker-compose.yml`, fill in env values
2. Point a subdomain (e.g. `tools-mcp.yourdomain.com`) at the host via Cloudflare Tunnel / reverse proxy
3. Set `MCP_BASE_URL=https://tools-mcp.yourdomain.com` (matching the public URL exactly, no `/mcp` path)
4. `docker compose up -d`

## Connecting clients

### Claude.ai (browser MCP connector)

1. In Claude.ai → Settings → Connectors → Add custom MCP
2. URL: `https://tools-mcp.yourdomain.com/mcp`
3. Approve in the consent screen that opens on `/authorize`

### `mcp-remote` / scripts / Claude Code

Use the static bearer token instead of the browser flow:

```bash
curl -H "Authorization: Bearer $MCP_STATIC_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://tools-mcp.yourdomain.com/mcp
```

## Adding a new CLI wrapper

1. Create `src/tools/<name>.ts` exporting `register<Name>Tools(server)`
2. Use `runCli`/`parseJsonOutput` from `src/exec.ts` to shell out
3. Wire it up in `src/tools.ts`
4. Add any required env vars to `.env.example`

The bird module is the reference implementation.

## Configuration reference

See `.env.example` for the full list of environment variables.

## Heads-up on bird

`@steipete/bird` is **deprecated upstream** but still functional. Its cookies rotate every few weeks/months — when `bird_whoami` starts returning auth errors, re-extract `auth_token` and `ct0` from a logged-in browser and update the env.
