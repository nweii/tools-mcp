// ABOUTME: HTTP contract pins for the server surface — the bearer-gated health probe, OAuth
// discovery metadata, /mcp method gating, and the MCP initialize + tool-listing round-trip.
// Characterization: assertions observe the current HTTP responses only; the only internal reached is
// the auth instance's seedTestToken, which mints a bearer the way an issued OAuth token would be.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'http';
import { createServer } from 'net';
import type { Auth } from 'mcp-server-kit';

process.env.MCP_CLIENT_ID ??= 'test-client';

const { createApp } = await import('../src/app.ts');

// A free port, so MCP_BASE_URL is final before createApp(): the SDK-backed auth bakes the
// issuer/discovery URLs at construction (it does not resolve them live per request).
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

let server: Server;
let base: string;
let auth: Auth;

beforeAll(async () => {
  // This suite pins the no-secret, no-password configuration. process.env is shared across test files,
  // so clear these guards in case another suite set them. The kit's createAuth refuses to construct
  // with /authorize unguarded, so declare the gateway-guarded posture (APPROVAL_OPEN) — the same
  // click-to-approve surface this suite characterizes.
  delete process.env.MCP_CLIENT_SECRET;
  delete process.env.APPROVAL_PASSWORD;
  process.env.APPROVAL_OPEN = 'true';

  const port = await freePort();
  base = `http://localhost:${port}`;
  process.env.MCP_BASE_URL = base;
  const built = createApp();
  auth = built.auth;
  await new Promise<void>((resolve) => {
    server = built.app.listen(port, () => resolve());
  });
});

afterAll(() => {
  server?.close();
  delete process.env.APPROVAL_OPEN;
});

test('advertises OAuth protected-resource metadata', async () => {
  const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
  expect(res.status).toBe(200);
  const meta = (await res.json()) as { resource?: string; authorization_servers?: string[] };
  // Re-pin (delta: issuer/endpoint URLs gain a trailing slash, frozen at construction).
  expect(meta.resource).toBe(`${base}/`);
  expect(meta.authorization_servers).toContain(`${base}/`);
});

test('advertises OAuth authorization-server metadata', async () => {
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  expect(res.status).toBe(200);
  const meta = (await res.json()) as {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    code_challenge_methods_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
  };
  // Re-pin (delta: issuer URL gains a trailing slash, frozen at construction).
  expect(meta.issuer).toBe(`${base}/`);
  expect(meta.authorization_endpoint).toBe(`${base}/authorize`);
  // Re-pin (delta: token endpoint /oauth/token → /token).
  expect(meta.token_endpoint).toBe(`${base}/token`);
  expect(meta.code_challenge_methods_supported).toContain('S256');
  // No client secret configured in this suite, so 'none' is an advertised auth method.
  expect(meta.token_endpoint_auth_methods_supported).toContain('none');
});

test('GET /mcp without a token is 401 with a WWW-Authenticate challenge', async () => {
  const res = await fetch(`${base}/mcp`);
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
});

test('GET /mcp with a valid token is 405 (POST-only endpoint)', async () => {
  const token = auth.seedTestToken();
  const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(405);
  // Re-pin (DELETE /mcp collision: kit standardizes Allow to POST — the old handler advertised
  // 'POST, DELETE').
  expect(res.headers.get('allow')).toBe('POST');
});

test('DELETE /mcp is 405 (POST-only) with an Allow header', async () => {
  // Re-pin (DELETE /mcp collision): stateless transport has no session to delete, so the kit answers
  // 405 with Allow: POST rather than the old server's unrouted 404.
  const token = auth.seedTestToken();
  const res = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(405);
  expect(res.headers.get('allow')).toBe('POST');
});

test('POST /mcp initialize returns server info and advertises tool capability', async () => {
  const token = auth.seedTestToken();
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } };
  };
  expect(body.result?.serverInfo?.name).toBe('tools-mcp');
  expect(body.result?.capabilities?.tools).toBeDefined();
});

// Transport-contract pin: tool listing over /mcp. Pins the set of tool names the server advertises,
// not any tool's behavior (the CLI-backed tools need external services and are never invoked here).
test('POST /mcp tools/list advertises the wrapped CLI tools', async () => {
  const token = auth.seedTestToken();
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
  const names = (body.result?.tools ?? []).map((t) => t.name).sort();
  expect(names).toEqual(
    [
      'bird_bookmarks',
      'bird_mentions',
      'bird_post_tweet',
      'bird_read',
      'bird_replies',
      'bird_reply',
      'bird_search',
      'bird_thread',
      'bird_whoami',
      'browser_content',
      'browser_links',
      'browser_markdown',
      'browser_scrape',
      'browser_screenshot',
      'browser_snapshot',
      'perplexity_ask',
      'perplexity_reason',
      'perplexity_research',
      'perplexity_search',
    ].sort(),
  );
});

test('/health is 404 when no HEALTH_TOKEN is configured', async () => {
  delete process.env.HEALTH_TOKEN;
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(404);
});

test('/health rejects a bad bearer with 401', async () => {
  process.env.HEALTH_TOKEN = 'health-secret';
  try {
    const res = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  } finally {
    delete process.env.HEALTH_TOKEN;
  }
});

test('/health returns an ok body with a valid token', async () => {
  process.env.HEALTH_TOKEN = 'health-secret';
  try {
    const res = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer health-secret' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; version?: string; uptime_seconds?: number };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime_seconds).toBe('number');
  } finally {
    delete process.env.HEALTH_TOKEN;
  }
});
