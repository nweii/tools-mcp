// ABOUTME: HTTP contract pins for the server surface — the unauthenticated health probe, OAuth
// discovery metadata, /mcp method gating, and the MCP initialize + tool-listing round-trip.
// Characterization: assertions observe the current HTTP responses only; no internals are imported
// except seedTestToken, which mints a bearer the way an issued OAuth token would be accepted.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'http';

process.env.MCP_CLIENT_ID ??= 'test-client';
process.env.MCP_BASE_URL = 'http://localhost:0'; // replaced with the real origin in beforeAll

const { createApp } = await import('../src/app.ts');
const { seedTestToken } = await import('../src/auth.ts');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      base = `http://localhost:${port}`;
      process.env.MCP_BASE_URL = base;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

// PIN OF TEMPORARY BEHAVIOR: /healthz is currently unauthenticated and returns this body shape.
// A later change replaces it with a bearer-gated health endpoint; when that lands, this pin is
// expected to change with it.
test('GET /healthz is unauthenticated and returns ok/name/version', async () => {
  const res = await fetch(`${base}/healthz`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok?: boolean; name?: string; version?: string };
  expect(body.ok).toBe(true);
  expect(body.name).toBe('tools-mcp');
  expect(typeof body.version).toBe('string');
});

test('advertises OAuth protected-resource metadata', async () => {
  const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
  expect(res.status).toBe(200);
  const meta = (await res.json()) as { resource?: string; authorization_servers?: string[] };
  expect(meta.resource).toBe(base);
  expect(meta.authorization_servers).toContain(base);
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
  expect(meta.issuer).toBe(base);
  expect(meta.authorization_endpoint).toBe(`${base}/authorize`);
  expect(meta.token_endpoint).toBe(`${base}/oauth/token`);
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
  const token = seedTestToken();
  const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(405);
  expect(res.headers.get('allow')).toContain('POST');
});

test('POST /mcp initialize returns server info and advertises tool capability', async () => {
  const token = seedTestToken();
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
  const token = seedTestToken();
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
