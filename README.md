# tools-mcp

A modular MCP server that exposes wrapped local CLIs and remote APIs to MCP clients like Claude.ai and Claude Code over HTTPS.

Each tool surface lives in its own module under `src/tools/`. The current modules wrap [`@steipete/bird`](https://www.npmjs.com/package/@steipete/bird) for X/Twitter, the [Perplexity API](https://docs.perplexity.ai/) for web-grounded search and reasoning, and [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-run/) for headless-browser page capture.

## Why

Some CLIs only work where they're installed: cookies, auth files, local paths, system access. Running them on a single host and exposing them over MCP means any client can call them without re-authenticating per machine.

## Bird (X/Twitter)

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

`@steipete/bird` is deprecated upstream but still working. Its cookies rotate every few weeks; when `bird_whoami` returns auth errors, re-extract `auth_token` and `ct0` from a logged-in browser and update the env.

## Perplexity (web-grounded AI)

Calls the [Perplexity REST API](https://docs.perplexity.ai/) directly. Requires `PERPLEXITY_API_KEY` in the server env. All four tools are read-only and billed to that key.

| Tool | Description |
|------|-------------|
| `perplexity_search` | Ranked search results (title, URL, snippet, date) |
| `perplexity_ask` | Quick web-grounded answer with citations (`sonar-pro`) |
| `perplexity_research` | Deep multi-source research (`sonar-deep-research`, 30s+ per call) |
| `perplexity_reason` | Step-by-step reasoning with web grounding (`sonar-reasoning-pro`) |

## Browser (Cloudflare Browser Rendering)

Calls the [Browser Rendering REST API](https://developers.cloudflare.com/browser-run/quick-actions/) directly — a headless browser in Cloudflare's cloud, so any client (including ones with no local browser) can render a page, screenshot it, or extract structure. Requires `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with the **Browser Rendering — Edit** permission. All tools are read-only and bill to that account's browser-time quota (free plan: 10 min/day, 3 concurrent browsers).

| Tool | Description |
|------|-------------|
| `browser_markdown` | Render a page (post-JavaScript) and return clean Markdown |
| `browser_content` | Render a page and return its full HTML |
| `browser_screenshot` | Capture a screenshot, returned as an image |
| `browser_scrape` | Extract elements matching CSS selectors |
| `browser_links` | Extract all links from a page |
| `browser_snapshot` | Multiple formats in one call (HTML, screenshot, Markdown, accessibility tree) — one browser-time charge |

Because billing is on browser time, the cheapest patterns are `browser_snapshot` (several formats per render) and passing `rejectResourceTypes` (e.g. `["image","font"]`) to cut render time. The page targeted by these tools must be reachable from the public internet — Cloudflare's browser cannot reach `localhost`.

## Security

The Claude-facing OAuth surface is served by the MCP SDK (via [`mcp-server-kit`](https://github.com/nweii/mcp-server-kit)).

- OAuth 2.1 + PKCE, with discovery at `/.well-known/oauth-authorization-server`, the approval page at `/authorize`, and token exchange at `/token` (compatible with Claude.ai's connector flow)
- The approval page is guarded: the server refuses to start unless one of `APPROVAL_PASSWORD` (a password on the approval page), `MCP_CLIENT_SECRET` (a secret required at token exchange), or `APPROVAL_OPEN=true` (declares an external gateway already guards `/authorize`) is set
- Static bearer token (`MCP_STATIC_BEARER_TOKEN`) for clients that bypass the browser flow
- Bearer-gated liveness at `/health` — returns 404 unless `HEALTH_TOKEN` is set, then requires that token; the secret pasted into an uptime monitor grants nothing else and rotates independently of the `/mcp` auth
- CORS allowlisting via `CORS_ALLOWED_ORIGINS`
- Bird cookies, the Perplexity API key, and the Cloudflare API token live only in the server's environment, never in this repo

## Quick start (local)

```bash
git clone git@github.com:nweii/tools-mcp.git
cd tools-mcp
bun install
cp .env.example .env
# fill in BIRD_AUTH_TOKEN, BIRD_CT0, PERPLEXITY_API_KEY, MCP_CLIENT_ID, and a
# guard for /authorize (APPROVAL_PASSWORD, or APPROVAL_OPEN=true for local use)
bun run start
```

The server listens on `PORT` (default 3457). MCP endpoint is `POST /mcp`.

Smoke-test bird without going through MCP:

```bash
BIRD_AUTH_TOKEN=… BIRD_CT0=… ./node_modules/.bin/bird whoami
```

## Deployment (NAS / home server)

Same shape as `obsidian-remote-mcp`: Docker behind a reverse proxy that handles TLS, with the public origin set in `MCP_BASE_URL`.

1. Copy `docker-compose.yml.example` to `docker-compose.yml`, fill in env values
2. Point a subdomain (e.g. `tools-mcp.yourdomain.com`) at the host via Cloudflare Tunnel / reverse proxy
3. Set `MCP_BASE_URL=https://tools-mcp.yourdomain.com` (match the public URL exactly, no `/mcp` path)
4. `docker compose up -d`

## Connecting clients

### Claude.ai (browser MCP connector)

1. Claude.ai → Settings → Connectors → Add custom MCP
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

## Adding a tool module

1. Create `src/tools/<name>.ts` exporting `register<Name>Tools(server)`
2. Wire it up in `src/tools.ts`
3. Add any required env vars to `.env.example`

For CLI wrappers, see `src/tools/bird.ts` and use `runCli`/`parseJsonOutput` from `src/exec.ts`. For REST API wrappers, see `src/tools/perplexity.ts` and use native `fetch` with an `AbortController` for timeouts.

## Configuration reference

See `.env.example` for the full list of environment variables.
